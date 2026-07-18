import * as vscode from 'vscode'
import path from 'path'
import escapeStringRegexp from 'escape-string-regexp'
import {compileBladeBatch, getCompiledContext} from './compiled'
import {debugLog} from './debug'
import {evictOldestEntries} from './cache'
import {BLADE_EXCLUDE_GLOB, BLADE_SELECTOR, getWorkspaceFolder} from './utils'

type RenameTarget = {
    uri   : vscode.Uri
    range : vscode.Range
}

export type BladeReference = {
    document : vscode.TextDocument
    range    : vscode.Range
}

export type PhpReferenceSymbol = {
    position : vscode.Position
    kind?    : vscode.SymbolKind
}

type PreparedReferenceSymbol = {
    key    : string
    symbol : string
    kind   : vscode.SymbolKind | undefined
    target : RenameTarget
}

type ReferenceBatch = {
    keys     : Set<string>
    excludes : string[]
    promise  : Promise<Map<string, BladeReference[]>>
}

type ReferenceBatchCache = {
    version : number
    batches : ReferenceBatch[]
}

const pendingBladeRenames = new Set<string>()
const pendingRenameSaves = new Set<string>()
const referenceBatches = new Map<string, ReferenceBatchCache>()
let nextBladeReferenceSearch = 0

const MAX_REFERENCE_BATCH_DOCUMENTS = 50

function consumePending(pending: Set<string>, uri: vscode.Uri): boolean {
    const key = uri.toString()

    if (!pending.has(key)) {
        return false
    }

    pending.delete(key)

    return true
}

export function markRenameDocument(uri: vscode.Uri): void {
    pendingRenameSaves.add(uri.toString())
}

export function consumeRenameDocument(uri: vscode.Uri): boolean {
    return consumePending(pendingRenameSaves, uri)
}

export function markBladeRename(uri: vscode.Uri): void {
    pendingBladeRenames.add(uri.toString())
    markRenameDocument(uri)
}

export function consumeBladeRename(uri: vscode.Uri): boolean {
    return consumePending(pendingBladeRenames, uri)
}

function definitionTarget(
    definition: vscode.Location | vscode.LocationLink | undefined,
): RenameTarget | undefined {
    if (!definition) {
        return undefined
    }

    if ('targetUri' in definition) {
        return {
            uri   : definition.targetUri,
            range : definition.targetSelectionRange ?? definition.targetRange,
        }
    }

    return definition
}

function sameTarget(left: RenameTarget, right: RenameTarget): boolean {
    return left.uri.toString() === right.uri.toString()
      && left.range.start.line === right.range.start.line
      && left.range.start.character === right.range.start.character
      && left.range.end.line === right.range.end.line
      && left.range.end.character === right.range.end.character
}

async function getDefinitionTarget(uri: vscode.Uri, position: vscode.Position) {
    const definitions = await vscode.commands.executeCommand<
        vscode.Location[] | vscode.LocationLink[]
    >('vscode.executeDefinitionProvider', uri, position) ?? []

    return definitionTarget(definitions[0])
}

async function getCompiledTarget(
    document: vscode.TextDocument,
    position: vscode.Position,
): Promise<RenameTarget | undefined> {
    try {
        const context = await getCompiledContext(document)

        if (!context) {
            return undefined
        }

        const generatedPosition = context.markerMap.toGeneratedPosition(position)

        return generatedPosition
            ? getDefinitionTarget(context.uri, generatedPosition)
            : undefined
    } catch (error) {
        debugLog(`getCompiledTarget failed: ${error instanceof Error ? error.message : String(error)}`)

        return undefined
    }
}

export function positionKey(position: vscode.Position): string {
    return `${position.line}:${position.character}`
}

function rangeKey(range: vscode.Range): string {
    return `${positionKey(range.start)}:${positionKey(range.end)}`
}

function sameExcludes(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false
    }

    const leftSet = new Set(left)

    return right.every((pattern) => leftSet.has(pattern))
}

function excludesKey(excludes: string[]): string {
    return [...excludes].sort().join('\0')
}

function isCancelled(token?: vscode.CancellationToken): boolean {
    return token?.isCancellationRequested ?? false
}

function symbolRange(
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.Range | undefined {
    return document.getWordRangeAtPosition(position, /\$?[A-Za-z_]\w*/)
}

function referencePattern(symbol: string, kind?: vscode.SymbolKind): RegExp {
    const name = escapeStringRegexp(symbol)

    switch (kind) {
        case vscode.SymbolKind.Property:
        case vscode.SymbolKind.Field:
            return new RegExp(`(?:(?:\\?->|->)\\s*|::\\s*\\$)(${name})(?!\\w)`, 'g')
        case vscode.SymbolKind.Method:
            return new RegExp(`(?:\\?->|->|::)\\s*(${name})(?=\\s*\\()`, 'g')
        case vscode.SymbolKind.Function:
            return new RegExp(`(?<![\\w$@>:])(${name})(?=\\s*\\()`, 'g')
        case vscode.SymbolKind.Constant:
        case vscode.SymbolKind.EnumMember:
            return new RegExp(`::\\s*(${name})(?!\\w)`, 'g')
        case vscode.SymbolKind.Variable:
            return new RegExp(`\\$(${name})(?!\\w)`, 'g')
        default:
            return new RegExp(`(?<![\\w$])(${name})(?=\\W|$)`, 'g')
    }
}

function findBladeReferenceRanges(
    document: vscode.TextDocument,
    symbol: string,
    kind?: vscode.SymbolKind,
): vscode.Range[] {
    return [...document.getText().matchAll(referencePattern(symbol, kind))].map((match) => {
        const offset = match.index! + match[0].lastIndexOf(match[1])
        const start = document.positionAt(offset)

        return new vscode.Range(start, document.positionAt(offset + symbol.length))
    })
}

async function getSymbolKind(
    document: vscode.TextDocument,
    position: vscode.Position,
): Promise<vscode.SymbolKind | undefined> {
    const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[] | vscode.SymbolInformation[]
    >('vscode.executeDocumentSymbolProvider', document.uri) ?? []
    const queue = [...symbols]

    while (queue.length > 0) {
        const symbol = queue.shift()!
        const range = 'selectionRange' in symbol ? symbol.selectionRange : symbol.location.range

        if (range.contains(position)) {
            return symbol.kind
        }

        if ('children' in symbol) {
            queue.push(...symbol.children)
        }
    }
}

function scanDoubleStar(glob: string, i: number): {regex: string, next: number} {
    return {regex: '.*', next: i + 2}
}

function scanSingleStar(glob: string, i: number): {regex: string, next: number} {
    return {regex: '[^/]*', next: i + 1}
}

function scanQuestion(glob: string, i: number): {regex: string, next: number} {
    return {regex: '[^/]', next: i + 1}
}

function scanBracket(glob: string, i: number): {regex: string, next: number} {
    const close = glob.indexOf(']', i + 1)

    if (close === -1) {
        return {regex: '\\[', next: i + 1}
    }

    const inner = glob.slice(i + 1, close)
    const negated = inner.startsWith('!')
    const chars = negated ? inner.slice(1) : inner

    return {regex: `[${negated ? '^' : ''}${chars}]`, next: close + 1}
}

function scanBrace(glob: string, i: number): {regex: string, next: number} {
    const close = glob.indexOf('}', i + 1)

    if (close === -1) {
        return {regex: '\\{', next: i + 1}
    }

    const parts = glob.slice(i + 1, close).split(',')

    return {regex: `(${parts.join('|')})`, next: close + 1}
}

function escapeLiteral(ch: string): string {
    return /[.+^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch
}

function matchesGlob(filePath: string, glob: string): boolean {
    // Convert glob pattern to regex, processing wildcards before escaping
    // so that bracket [abc] and brace {a,b} expressions work correctly.
    let regexStr = ''
    let i = 0

    while (i < glob.length) {
        const ch = glob[i]

        if (ch === '*' && glob[i + 1] === '*') {
            const scan = scanDoubleStar(glob, i)
            regexStr += scan.regex
            i = scan.next
        } else if (ch === '*' && glob[i - 1] !== '*') {
            const scan = scanSingleStar(glob, i)
            regexStr += scan.regex
            i = scan.next
        } else if (ch === '?') {
            const scan = scanQuestion(glob, i)
            regexStr += scan.regex
            i = scan.next
        } else if (ch === '[') {
            const scan = scanBracket(glob, i)
            regexStr += scan.regex
            i = scan.next
        } else if (ch === '{') {
            const scan = scanBrace(glob, i)
            regexStr += scan.regex
            i = scan.next
        } else {
            regexStr += escapeLiteral(ch)
            i += 1
        }
    }

    return new RegExp(`^${regexStr}$`).test(filePath)
}

function getFilesExcludes(resource: vscode.ConfigurationScope): string[] {
    return vscode.workspace
        .getConfiguration('intelephense.files', resource)
        .get<string[]>('exclude') ?? []
}

function getSectionExcludes(section: string, resource: vscode.ConfigurationScope): string[] {
    return [...new Set([
        ...(vscode.workspace
            .getConfiguration(`intelephense.${section}`, resource)
            .get<string[]>('exclude') ?? []),
        ...getFilesExcludes(resource),
    ])]
}

export function getReferenceExcludes(resource: vscode.ConfigurationScope): string[] {
    return getSectionExcludes('references', resource)
}

export function getRenameExcludes(resource: vscode.ConfigurationScope): string[] {
    return getSectionExcludes('rename', resource)
}

export function isExcludedLocation(uri: vscode.Uri, patterns: string[]): boolean {
    if (patterns.length === 0) {
        return false
    }

    const absolute = uri.fsPath.split(path.sep).join('/')
    const workspaceFolder = getWorkspaceFolder(uri)
    const relative = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath).split(path.sep).join('/')
        : absolute

    return patterns.some((pattern) =>
        matchesGlob(absolute, pattern) || matchesGlob(relative, pattern),
    )
}

async function getBladeCandidates(
    targets: PreparedReferenceSymbol[],
    excludes: string[],
    token?: vscode.CancellationToken,
): Promise<Map<vscode.TextDocument, Map<string, vscode.Range[]>>> {
    // Vendor blades (framework/package views) are not indexed by intelephense and
    // scanning them on every request is a performance killer, so always exclude them.
    const searchExcludes = [...new Set([...excludes, BLADE_EXCLUDE_GLOB])]
    const exclude = searchExcludes.length > 1 ? `{${searchExcludes.join(',')}}` : searchExcludes[0]

    const documents = new Map(
        vscode.workspace.textDocuments
            .filter((document) => document.languageId === BLADE_SELECTOR)
            .filter((document) => !isExcludedLocation(document.uri, searchExcludes))
            .map((document) => [document.uri.toString(), document]),
    )

    for (const uri of await vscode.workspace.findFiles('**/*.blade.php', exclude, undefined, token)) {
        if (isCancelled(token)) {
            break
        }

        const key = uri.toString()
        documents.set(key, documents.get(key) ?? await vscode.workspace.openTextDocument(uri))
    }

    const candidates = new Map<vscode.TextDocument, Map<string, vscode.Range[]>>()

    for (const document of documents.values()) {
        const ranges = new Map<string, vscode.Range[]>()

        for (const target of targets) {
            const matches = findBladeReferenceRanges(document, target.symbol, target.kind)

            if (matches.length > 0) {
                ranges.set(target.key, matches)
            }
        }

        if (ranges.size > 0) {
            candidates.set(document, ranges)
        }
    }

    return candidates
}

function getBladeReplacement(
    document: vscode.TextDocument,
    range: vscode.Range,
    newName: string,
): string {
    const line = document.lineAt(range.start.line).text
    const hasDollar = range.start.character > 0 && line[range.start.character - 1] === '$'
    const name = newName.startsWith('$') ? newName.slice(1) : newName

    return hasDollar ? '$' + name : name
}

function bladeSymbol(symbol: string): string {
    return symbol.startsWith('$') ? symbol.slice(1) : symbol
}

type CompiledContext = NonNullable<Awaited<ReturnType<typeof getCompiledContext>>>

async function prepareReferenceSymbol(
    document: vscode.TextDocument,
    position: vscode.Position,
    kind: vscode.SymbolKind | undefined,
    token?: vscode.CancellationToken,
): Promise<PreparedReferenceSymbol | undefined> {
    const range = symbolRange(document, position)

    if (!range || isCancelled(token)) {
        return undefined
    }

    const target = document.languageId === BLADE_SELECTOR
        ? await getCompiledTarget(document, position)
        : await getDefinitionTarget(document.uri, position)

    if (!target) {
        return undefined
    }

    const rawSymbol = document.getText(range)

    return {
        key    : positionKey(range.start),
        symbol : bladeSymbol(rawSymbol),
        kind   : kind ?? await getSymbolKind(document, position)
          ?? (rawSymbol.startsWith('$') ? vscode.SymbolKind.Variable : undefined),
        target,
    }
}

async function prepareReferenceSymbols(
    document: vscode.TextDocument,
    symbols: PhpReferenceSymbol[],
    token?: vscode.CancellationToken,
): Promise<PreparedReferenceSymbol[]> {
    const prepared = await Promise.all(symbols.map(({position, kind}) =>
        prepareReferenceSymbol(document, position, kind, token),
    ))

    return prepared.filter((target): target is PreparedReferenceSymbol => Boolean(target))
}

function collectCandidateRanges(
    prepared: PreparedReferenceSymbol[],
    targetRanges: Map<string, vscode.Range[]>,
): Map<string, {range: vscode.Range, targets: PreparedReferenceSymbol[]}> {
    const ranges = new Map<string, {range: vscode.Range, targets: PreparedReferenceSymbol[]}>()

    for (const target of prepared) {
        for (const range of targetRanges.get(target.key) ?? []) {
            const key = rangeKey(range)
            const entry = ranges.get(key) ?? {range, targets: []}

            entry.targets.push(target)
            ranges.set(key, entry)
        }
    }

    return ranges
}

async function matchReferencesToTargets(
    results: Map<string, BladeReference[]>,
    bladeDocument: vscode.TextDocument,
    context: CompiledContext,
    ranges: Map<string, {range: vscode.Range, targets: PreparedReferenceSymbol[]}>,
    token?: vscode.CancellationToken,
): Promise<number> {
    let definitions = 0

    for (const {range, targets} of ranges.values()) {
        if (isCancelled(token)) {
            break
        }

        const generatedPosition = context.markerMap.toGeneratedPosition(range.start)

        if (!generatedPosition) {
            continue
        }

        const candidate = await getDefinitionTarget(context.uri, generatedPosition)
        definitions++

        if (!candidate) {
            continue
        }

        for (const target of targets) {
            if (sameTarget(candidate, target.target)) {
                results.get(target.key)!.push({document: bladeDocument, range})
            }
        }
    }

    return definitions
}

async function scanBladeReferences(
    document: vscode.TextDocument,
    symbols: PhpReferenceSymbol[],
    excludes: string[],
    token?: vscode.CancellationToken,
): Promise<Map<string, BladeReference[]>> {
    const searchId = ++nextBladeReferenceSearch
    const prepared = await prepareReferenceSymbols(document, symbols, token)
    const results = new Map(prepared.map(({key}) => [key, [] as BladeReference[]]))

    debugLog(`Blade reference batch start #${searchId}: symbols=${prepared.length}`)

    if (prepared.length === 0 || isCancelled(token)) {
        return results
    }

    const candidates = await getBladeCandidates(prepared, excludes, token)
    let definitions = 0

    // Batch-compile all uncached candidate blades in a single PHP process
    await compileBladeBatch([...candidates.keys()])

    for (const [bladeDocument, targetRanges] of candidates) {
        if (isCancelled(token)) {
            break
        }

        const context = await getCompiledContext(bladeDocument)

        if (!context) {
            continue
        }

        const ranges = collectCandidateRanges(prepared, targetRanges)
        definitions += await matchReferencesToTargets(results, bladeDocument, context, ranges, token)
    }

    const matches = [...results.values()].reduce((total, references) => total + references.length, 0)
    debugLog(`Blade reference batch complete #${searchId}: documents=${candidates.size}, definitions=${definitions}, matches=${matches}`)

    return results
}

function getReferenceCache(document: vscode.TextDocument): ReferenceBatchCache {
    const key = document.uri.toString()
    const version = document.version ?? 0
    const cached = referenceBatches.get(key)

    if (cached?.version === version) {
        return cached
    }

    const created = {version, batches: []}
    referenceBatches.set(key, created)
    evictOldestEntries(referenceBatches, MAX_REFERENCE_BATCH_DOCUMENTS)

    return created
}

function normalizedSymbols(
    document: vscode.TextDocument,
    symbols: PhpReferenceSymbol[],
): PhpReferenceSymbol[] {
    const seen = new Set<string>()

    return symbols.filter(({position}) => {
        const range = symbolRange(document, position)
        const key = range ? positionKey(range.start) : ''

        if (!key || seen.has(key)) {
            return false
        }

        seen.add(key)

        return true
    })
}

export function prepareBladeReferencesForPhp(
    document: vscode.TextDocument,
    symbols: PhpReferenceSymbol[],
    excludes: string[],
    token?: vscode.CancellationToken,
): Promise<Map<string, BladeReference[]>> {
    const normalized = normalizedSymbols(document, symbols)
    const keys = new Set(normalized.map(({position}) => {
        const range = symbolRange(document, position)

        return range ? positionKey(range.start) : ''
    }).filter(Boolean))
    const cache = getReferenceCache(document)
    const keyHash = excludesKey(excludes)
    const existing = cache.batches.find((batch) =>
        batch.keys.size === keys.size
        && [...keys].every((key) => batch.keys.has(key))
        && excludesKey(batch.excludes) === keyHash,
    )

    if (existing) {
        return existing.promise
    }

    let promise: Promise<Map<string, BladeReference[]>>

    promise = scanBladeReferences(document, normalized, excludes, token).catch((error) => {
        cache.batches = cache.batches.filter((candidate) => candidate.promise !== promise)
        throw error
    })

    cache.batches.push({keys, excludes, promise})

    return promise
}

export function clearBladeReferenceCache(): void {
    referenceBatches.clear()
}

export async function getBladeReferencesForPhp(
    document: vscode.TextDocument,
    position: vscode.Position,
    excludes: string[],
    token?: vscode.CancellationToken,
): Promise<BladeReference[] | undefined> {
    if (isCancelled(token)) {
        return undefined
    }

    const range = symbolRange(document, position)

    if (!range) {
        return []
    }

    const key = positionKey(range.start)
    const keyHash = excludesKey(excludes)
    const cached = getReferenceCache(document).batches.find((batch) =>
        batch.keys.has(key) && excludesKey(batch.excludes) === keyHash,
    )
    const results = cached
        ? await cached.promise
        : await scanBladeReferences(document, [{position}], excludes, token)

    return results.get(key) ?? []
}

export async function getBladeRenameEditsForPhp(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    token: vscode.CancellationToken,
): Promise<vscode.WorkspaceEdit | undefined> {
    const references = await getBladeReferencesForPhp(document, position, getRenameExcludes(document.uri), token)

    if (!references) {
        return undefined
    }

    const range = symbolRange(document, position)
    const symbol = range ? document.getText(range) : ''
    const replacement = symbol.startsWith('$') && !newName.startsWith('$') ? '$' + newName : newName
    const bladeEdits = new vscode.WorkspaceEdit()

    for (const {document: bladeDocument, range: referenceRange} of references) {
        markBladeRename(bladeDocument.uri)
        bladeEdits.replace(
            bladeDocument.uri,
            referenceRange,
            getBladeReplacement(bladeDocument, referenceRange, replacement),
        )
    }

    return bladeEdits
}

import * as vscode from 'vscode'
import * as cache from './cache'
import {getWorkspaceFolder, isBladeUri} from './utils'
import {getDebugMode, getPhpDocBlocks} from './config'
import {getCompiledContext, getCompiledContextFromDisk, isBladeParserCompiledPath, saveCompiledProbe} from './compiled'
import {markCompiledAsAutoOpened} from './diagnostics'
import {debugLog, logResults} from './debug'
import {parsePhpDocument} from '../parsers/php'
import {mapUri, offsetAt, positionAt} from './mapping'
import {CompletionResult, getAnnotatedVariableType, getClassCompletionContext, getLivePhpRegion, getTypedCompletionContext, classCompletionKinds, classOnlyKinds, typedCompletionKinds, LivePhpRegion} from './completion'
import {resolveClassFile} from './reflection'
import {dedupe, dedupeLinks, dedupeLocations, flattenDocumentSymbols, mapPosition, waitForProvider, byUniqueNameAndLine, referenceableKinds} from './symbols'
import {getBladeProps, parseBladeDocument} from '../parsers/blade'
import {getBladeReferencesForPhp, getReferenceExcludes, isExcludedLocation, positionKey, prepareBladeReferencesForPhp} from './rename'
import type {BladeReference} from './rename'

export async function waitForIntelephense() {
    const workspaceFolder = getWorkspaceFolder()

    if (!workspaceFolder) {
        return
    }

    const artisanUri = vscode.Uri.joinPath(workspaceFolder.uri, 'artisan')

    await waitForProvider(
        () => vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', artisanUri),
        (symbols) => Boolean(symbols),
        'Intelephense',
    )
}

export async function activateIntelephense() {
    const extension = vscode.extensions.getExtension('bmewburn.vscode-intelephense-client')

    if (!extension) {
        vscode.window.showErrorMessage(
            'Blade Parser requires the "bmewburn.vscode-intelephense-client" extension to function',
        )

        throw new Error('Intelephense activation failed: extension not found')
    }

    await extension.activate()
}

async function queryCompiled<T>(
    document: vscode.TextDocument,
    command: string,
    position?: vscode.Position,
    exactOnly = false,
): Promise<T[]> {
    const context = await getCompiledContext(document)

    if (!context) {
        return []
    }

    const mappedPosition = position ? context.markerMap.toGeneratedPosition(position) : undefined

    if (position && !mappedPosition) {
        return []
    }

    const results = await vscode.commands.executeCommand<T[]>(command, context.uri, mappedPosition) ?? []

    return mapUri(results, context.uri, document, context.markerMap, exactOnly, position)
}

interface LivePhpProbe {
    uri            : vscode.Uri
    position       : vscode.Position
    // maps a probe offset back to a source document offset
    toSourceOffset : (offset: number) => number
    // probe text, for converting probe positions to offsets
    text           : string
}

// Builds a synthetic PHP file from the dirty blade region so hover/definition work
// without compiling. The header mirrors the compiler's docblock preamble so
// global `@var` annotations (e.g. `$vs_auth_user`, `$errors`) still resolve.
async function buildLivePhpProbe(
    document: vscode.TextDocument,
    sourceOffset: number,
    region: LivePhpRegion,
): Promise<LivePhpProbe | undefined> {
    const text = document.getText()
    const regionText = text.slice(region.start, region.end)

    // config docblocks + file-local `{{-- @var ... --}}` annotations, mirroring
    // the compiler's preamble so local types resolve while typing
    const localBlocks = [...text.matchAll(/\{\{--\s*@var\b([\s\S]*?)--\}\}/g)]
        .map((m) => m[1].trim())
    const header = [
        ...getPhpDocBlocks(document.uri),
        ...localBlocks,
    ].map((block) => `/** @var ${block} */`).join('\n')

    let body: string
    let innerStartProbe: number
    let innerStartRegion: number

    if (region.kind === 'php') {
        const inner = regionText.replace(/^\s*@php\b/, '').replace(/@endphp\b\s*$/, '').trim()
        innerStartRegion = regionText.indexOf(inner)
        body = `<?php\n${header}\n${inner}\n`
        innerStartProbe = body.length - inner.length
    } else if (region.kind === 'expression') {
        const inner = regionText
            .replace(/^\s*\{\{(?!\{)\-?\s*/, '')
            .replace(/\s*\-?\}\}\s*$/, '')
            .trim()
        innerStartRegion = regionText.indexOf(inner)
        body = `<?php\n${header}\n$__blade = ${inner};\n`
        innerStartProbe = body.length - inner.length
    } else {
        return undefined
    }

    const toSourceOffset = (offset: number): number =>
        region.start + (offset - innerStartProbe) + innerStartRegion

    const probeCursorOffset = innerStartProbe + (sourceOffset - region.start - innerStartRegion)

    const probePosAt = (offset: number): vscode.Position =>
        positionAt(body, Math.max(0, Math.min(offset, body.length)))

    return {
        uri      : vscode.Uri.file(await saveCompiledProbe(document, body)),
        position : probePosAt(probeCursorOffset),
        toSourceOffset,
        text     : body,
    }
}

// Runs an intelephense command against the live probe and maps probe-URI results
// back to the source document. Results pointing at external files pass through.
async function queryLivePhp<T>(
    document: vscode.TextDocument,
    command: string,
    position: vscode.Position,
): Promise<T[]> {
    const sourceOffset = document.offsetAt(position)
    const region = getLivePhpRegion(document, position)

    if (!region) {
        return []
    }

    const probe = await buildLivePhpProbe(document, sourceOffset, region)

    if (!probe) {
        return []
    }

    const results = await vscode.commands.executeCommand<T[]>(command, probe.uri, probe.position) ?? []

    return mapLiveResults(results, probe, document)
}

function mapLiveResults<T>(results: T[], probe: LivePhpProbe, document: vscode.TextDocument): T[] {
    const probeOffsetAt = (pos: vscode.Position): number => offsetAt(probe.text, pos)

    const mapPos = (pos: vscode.Position): vscode.Position =>
        document.positionAt(probe.toSourceOffset(probeOffsetAt(pos)))

    return results.flatMap((result) => {
        const r = result as any

        if (r?.uri?.toString() === probe.uri.toString() && r?.range) {
            return [{...r, uri: document.uri, range: new vscode.Range(mapPos(r.range.start), mapPos(r.range.end))}]
        }

        if (r?.targetUri?.toString() === probe.uri.toString() && r?.targetRange) {
            return [{
                ...r,
                targetUri   : document.uri,
                targetRange : new vscode.Range(mapPos(r.targetRange.start), mapPos(r.targetRange.end)),
                ...(r.targetSelectionRange ? {targetSelectionRange: new vscode.Range(mapPos(r.targetSelectionRange.start), mapPos(r.targetSelectionRange.end))} : {}),
            }]
        }

        if (r?.location?.uri?.toString() === probe.uri.toString() && r?.location?.range) {
            return [{
                ...r,
                location : {
                    ...r.location,
                    uri   : document.uri,
                    range : new vscode.Range(mapPos(r.location.range.start), mapPos(r.location.range.end)),
                },
            }]
        }

        return [result]
    })
}

export function getReferencesFor(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
) {
    return cache.getLatestResultsFor(document, async(isCurrent) => {
        if (getBladeProps(document).some(({range}) => range.contains(position))) {
            return []
        }

        const excludes = getReferenceExcludes(document.uri)

        const [queried, bladeScan] = await Promise.all([
            queryCompiled<vscode.Location>(document, 'vscode.executeReferenceProvider', position),
            getBladeReferencesForPhp(document, position, excludes, token).catch((error) => {
                debugLog(`getReferencesFor blade scan failed: ${error instanceof Error ? error.message : String(error)}`)

                return [] as BladeReference[]
            }),
        ])

        if (!isCurrent()) {
            return undefined
        }

        const filtered = dedupeLocations([
            ...queried
                .filter((location) => !isExcludedLocation(location.uri, excludes))
                .filter((location) =>
                    location.uri.scheme !== 'file' || !isBladeParserCompiledPath(location.uri.fsPath),
                )
                .filter((location) => !isBladeUri(location.uri)),
            ...(bladeScan ?? []).map((reference) => new vscode.Location(reference.document.uri, reference.range)),
        ])

        logResults('getReferencesFor', document, filtered)

        return filtered
    })
}

export function getHoverFor(document: vscode.TextDocument, position: vscode.Position) {
    return cache.getLatestResultsFor(document, async(isCurrent) => {
        if (getBladeProps(document).some(({range}) => range.contains(position))) {
            return []
        }

        const live = await queryLivePhp<vscode.Hover>(document, 'vscode.executeHoverProvider', position)

        if (!isCurrent()) {
            return undefined
        }

        const results = live.length > 0
            ? live
            : await queryCompiled<vscode.Hover>(document, 'vscode.executeHoverProvider', position)

        if (!isCurrent()) {
            return undefined
        }

        logResults('getHoverFor', document, results)

        return results
    })
}

export function getDocumentLinksFor(document: vscode.TextDocument, token?: vscode.CancellationToken) {
    return cache.getLatestResultsFor(document, async(isCurrent) => {
        if (token?.isCancellationRequested) {
            return []
        }

        const context = await getCompiledContextFromDisk(document)

        if (!context || !isCurrent()) {
            return undefined
        }

        await vscode.workspace.openTextDocument(context.uri)
        markCompiledAsAutoOpened(context.uri)

        const results = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
            'vscode.executeLinkProvider',
            context.uri,
        ) ?? []

        const deduped = dedupeLinks(
            mapUri(results, context.uri, document, context.markerMap, false) as vscode.DocumentLink[],
        )

        logResults('getDocumentLinksFor', document, deduped)

        return deduped
    })
}

export function getSymbolFor(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    return cache.getOrCacheResultsFor(document, async() => {
        const blade = await parseBladeDocument(document)
        const php = await parsePhpDocument(document)

        const symbols = dedupe([...blade, ...php])

        logResults('getSymbolFor', document, symbols)

        return symbols
    }, 'symbols')
}

export async function getCodeLensesFor(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const symbols = await getSymbolFor(document)

    return cache.getOrCacheResultsFor(document, async() => {
        const targetSymbols = buildTargetSymbols(symbols)
        const excludes = getReferenceExcludes(document.uri)
        const bladeReferences = await prepareBladeReferencesForPhp(
            document,
            targetSymbols.map((sym) => ({position: sym.selectionRange.start, kind: sym.kind})),
            getReferenceExcludes(document.uri),
        ).catch((error) => {
            debugLog(`getCodeLensesFor blade scan failed: ${error instanceof Error ? error.message : String(error)}`)

            return new Map<string, BladeReference[]>()
        })

        const lenses = await queryReferenceBatches(document, targetSymbols, excludes, bladeReferences)

        logResults('getCodeLensesFor', document, lenses)

        return lenses
    }, 'lenses')
}

function buildTargetSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
    return flattenDocumentSymbols(symbols)
        .filter((s) => referenceableKinds.has(s.kind))
        .filter(byUniqueNameAndLine())
}

async function queryReferenceBatches(
    document: vscode.TextDocument,
    targetSymbols: vscode.DocumentSymbol[],
    excludes: string[],
    bladeReferences: Map<string, BladeReference[]>,
): Promise<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = []
    const BATCH_SIZE = 10

    for (let i = 0; i < targetSymbols.length; i += BATCH_SIZE) {
        const batch = targetSymbols.slice(i, i + BATCH_SIZE)
        const results = await Promise.all(
            batch.map((sym) =>
                queryCompiled<vscode.Location>(document, 'vscode.executeReferenceProvider', sym.range.start),
            ),
        )

        for (let j = 0; j < batch.length; j++) {
            const lens = buildCodeLens(document, batch[j], results[j], bladeReferences, excludes)

            if (lens) {
                lenses.push(lens)
            }
        }
    }

    return lenses
}

function buildCodeLens(
    document: vscode.TextDocument,
    symbol: vscode.DocumentSymbol,
    queried: vscode.Location[],
    bladeReferences: Map<string, BladeReference[]>,
    excludes: string[],
): vscode.CodeLens | undefined {
    const filteredQueried = dedupeLocations(queried)
        .filter((ref) => !isExcludedLocation(ref.uri, excludes))
        .filter((ref) => !isBladeUri(ref.uri))
        .filter((ref) =>
            ref.uri.toString() !== document.uri.toString()
            || !ref.range.isEqual(symbol.selectionRange),
        )
    const scanned = (bladeReferences.get(positionKey(symbol.selectionRange.start)) ?? [])
        .filter((ref) => !ref.range.isEqual(symbol.selectionRange))
    const refs = dedupeLocations([
        ...filteredQueried,
        ...scanned.map((ref) => new vscode.Location(ref.document.uri, ref.range)),
    ])

    if (refs.length === 0) {
        return undefined
    }

    return new vscode.CodeLens(symbol.selectionRange, {
        title     : `${refs.length} reference${refs.length === 1 ? '' : 's'}`,
        command   : 'editor.action.showReferences',
        arguments : [document.uri, symbol.selectionRange.start, refs],
    })
}

export function getDefinitionsFor(document: vscode.TextDocument, position: vscode.Position) {
    return cache.getLatestResultsFor(document, async(isCurrent) => {
        const wordRange = document.getWordRangeAtPosition(position, /\$?[A-Za-z_]\w*/)
        const word = wordRange ? document.getText(wordRange) : ''
        const props = getBladeProps(document)

        if (props.some(({range}) => range.contains(position))) {
            return []
        }

        const prop = word.startsWith('$')
            ? props.find(({name}) => name === word.slice(1))
            : undefined

        if (prop) {
            return [new vscode.Location(document.uri, prop.range)]
        }

        const annotatedType = getAnnotatedVariableType(document, position)
        const annotatedPath = annotatedType
            ? await resolveClassFile(document, annotatedType)
            : undefined

        if (!isCurrent()) {
            return undefined
        }

        if (annotatedPath) {
            return [new vscode.Location(vscode.Uri.file(annotatedPath), new vscode.Position(0, 0))]
        }

        const live = await queryLivePhp<vscode.Location | vscode.LocationLink>(
            document,
            'vscode.executeDefinitionProvider',
            position,
        )

        if (!isCurrent()) {
            return undefined
        }

        const results = live.length > 0
            ? live
            : await queryCompiled<vscode.Location | vscode.LocationLink>(
                document,
                'vscode.executeDefinitionProvider',
                position,
            )

        if (!isCurrent()) {
            return undefined
        }

        logResults('getDefinitionsFor', document, results)

        return results
    })
}

// Coalesces rapid completion invocations (one per keystroke) into a single query
// for the latest position. Hover/definition are on-demand, so they are not debounced.
const completionDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const COMPLETION_DEBOUNCE_MS = 50

export async function getCompletionsFor(
    document: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string,
): Promise<vscode.CompletionList> {
    const key = document.uri.toString()
    const existing = completionDebounceTimers.get(key)

    if (existing) {
        clearTimeout(existing)
    }

    const run = () => fetchCompletions(document, position, triggerCharacter)

    const completionResult = await new Promise<CompletionResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            completionDebounceTimers.delete(key)
            run().then(resolve, reject)
        }, COMPLETION_DEBOUNCE_MS)
        completionDebounceTimers.set(key, timer)
    })

    return new vscode.CompletionList(
        completionResult.items,
        completionResult.isIncomplete,
    )
}

async function fetchCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string,
): Promise<CompletionResult> {
    const region = getLivePhpRegion(document, position)
    const typedContext = getTypedCompletionContext(document, position)
    const classContext = typedContext ? undefined : getClassCompletionContext(document, position)

    // Gate on a live PHP region to avoid a full-file compile on every plain HTML keystroke.
    if (!region && !typedContext && !classContext) {
        return {items: [], isIncomplete: false}
    }

    if (getDebugMode(document.uri)) {
        debugLog([
            'completion decision',
            `file: ${document.uri.fsPath}`,
            `pos: ${position.line}:${position.character}`,
            `typed: ${typedContext ? 'yes' : 'no'}`,
            `class: ${classContext ? `yes prefix="${classContext.prefix}"` : 'no'}`,
            `trigger: ${triggerCharacter ?? '-'}`,
        ].join(' | '))
    }

    const startedAt = Date.now()
    const probe = await buildCompletionProbeUris(document, typedContext, classContext)
    const compiledAt = Date.now()

    if (!probe.typedUri && !probe.classUri && !probe.compiledContext) {
        return {items: [], isIncomplete: false}
    }

    const mappedPosition = probe.typedQuery
        ? probe.typedQuery.position
        : probe.classQuery
            ? probe.classQuery.position
            : mapPosition(position, probe.compiledContext!.markerMap)
    const completionResult = await vscode.commands.executeCommand<vscode.CompletionList | vscode.CompletionItem[]>(
        'vscode.executeCompletionItemProvider',
        probe.typedUri ?? probe.classUri ?? probe.compiledContext!.uri,
        mappedPosition,
        triggerCharacter,
    )
    const queriedAt = Date.now()

    if (!completionResult) {
        return {items: [], isIncomplete: false}
    }

    const completionItems = filterCompletionItems(completionResult, typedContext, classContext, document, position)
    const mappedItems = mapCompletionItems(
        completionItems,
        probe,
        typedContext,
        classContext,
        document,
        position,
    )

    logCompletionTiming(document, startedAt, compiledAt, queriedAt, probe.typedQuery)

    debugLog([
        'completion query',
        `generated position: ${mappedPosition.line}:${mappedPosition.character}`,
        `raw items: ${completionItems.length}`,
        `mapped items: ${mappedItems.length}`,
        `labels: ${completionItems.map((i) => `${i.label}(${i.kind})`).join(', ')}`,
    ].join(' | '))
    logResults('getCompletionsFor', document, mappedItems)

    return {
        items        : mappedItems,
        isIncomplete : false,
    }
}

interface CompletionProbe {
    typedQuery      : {source: string, position: vscode.Position} | undefined
    classQuery      : {source: string, position: vscode.Position} | undefined
    typedUri        : vscode.Uri | undefined
    classUri        : vscode.Uri | undefined
    compiledContext : Awaited<ReturnType<typeof getCompiledContext>>
}

async function buildCompletionProbeUris(
    document: vscode.TextDocument,
    typedContext: import('./completion').TypedCompletionContext | undefined,
    classContext: import('./completion').ClassCompletionContext | undefined,
): Promise<CompletionProbe> {
    const typedQuery = typedContext ? getTypedCompletionQuery(typedContext) : undefined
    const classQuery = classContext ? getClassCompletionQuery(classContext) : undefined
    const typedUri = typedQuery
        ? vscode.Uri.file(await saveCompiledProbe(document, typedQuery.source))
        : undefined
    const classUri = classQuery
        ? vscode.Uri.file(await saveCompiledProbe(document, classQuery.source))
        : undefined
    const compiledContext = (typedQuery || classQuery) ? undefined : await getCompiledContext(document)

    return {typedQuery, classQuery, typedUri, classUri, compiledContext}
}

function filterCompletionItems(
    completionResult: vscode.CompletionList | vscode.CompletionItem[],
    typedContext: import('./completion').TypedCompletionContext | undefined,
    classContext: import('./completion').ClassCompletionContext | undefined,
    document?: vscode.TextDocument,
    position?: vscode.Position,
): vscode.CompletionItem[] {
    return (Array.isArray(completionResult) ? completionResult : completionResult.items)
        .filter((item) => {
            if (typedContext) {
                return item.kind !== undefined && typedCompletionKinds.has(item.kind)
            }

            if (classContext) {
                return item.kind !== undefined && classCompletionKinds.has(item.kind)
            }

            if (document && position) {
                const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/)
                const word = wordRange ? document.getText(wordRange) : ''
                const isUpper = /^[A-Z]/.test(word)
                const isLower = /^[a-z]/.test(word)

                if (isUpper && item.kind !== undefined) {
                    return classOnlyKinds.has(item.kind)
                }

                if (isLower && item.kind !== undefined) {
                    return !classOnlyKinds.has(item.kind)
                }
            }

            return true
        })
}

function mapCompletionItems(
    completionItems: vscode.CompletionItem[],
    probe: CompletionProbe,
    typedContext: import('./completion').TypedCompletionContext | undefined,
    classContext: import('./completion').ClassCompletionContext | undefined,
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.CompletionItem[] {
    return probe.typedQuery
        ? mapTypedCompletionItems(completionItems, typedContext!.range)
        : classContext
            ? mapTypedCompletionItems(completionItems, classContext.range, classContext.prefix)
            : inlineFqcnCompletions(completionItems.flatMap((completion) =>
                mapUri([completion], probe.compiledContext!.uri, document, probe.compiledContext!.markerMap, false, position),
            ))
}

function logCompletionTiming(
    document: vscode.TextDocument,
    startedAt: number,
    compiledAt: number,
    queriedAt: number,
    typedQuery: {source: string, position: vscode.Position} | undefined,
): void {
    if (getDebugMode(document.uri)) {
        debugLog([
            'completion timing',
            `${typedQuery ? 'typed context' : 'compile'}: ${compiledAt - startedAt}ms`,
            `query: ${queriedAt - compiledAt}ms`,
            `map: ${Date.now() - queriedAt}ms`,
            `total: ${Date.now() - startedAt}ms`,
        ].join(' | '))
    }
}

function getTypedCompletionQuery(context: import('./completion').TypedCompletionContext): {
    source   : string
    position : vscode.Position
} {
    const operatorIndex = context.expression.includes('->')
        ? context.expression.indexOf('->')
        : context.expression.indexOf('::')
    const target = context.expression.slice(0, operatorIndex)

    if (target.startsWith('$')) {
        return {
            source   : `<?php\n/** @var ${context.type} ${target} */\n${context.expression};\n`,
            position : new vscode.Position(2, context.expression.length),
        }
    }

    const suffix = context.expression.slice(target.length)

    return {
        source   : `<?php\n${context.type}${suffix};\n`,
        position : new vscode.Position(1, context.type.length + suffix.length),
    }
}

function getClassCompletionQuery(context: import('./completion').ClassCompletionContext): {
    source   : string
    position : vscode.Position
} {
    const prefix = context.prefix.startsWith('\\') ? context.prefix : `\\${context.prefix}`

    return {
        source   : `<?php\n/** @var ${prefix} $x */\n`,
        position : new vscode.Position(1, 9 + prefix.length),
    }
}

function mapTypedCompletionItems(
    items: vscode.CompletionItem[],
    range: vscode.Range,
    typedPrefix?: string,
): vscode.CompletionItem[] {
    const fqcnPrefix = typedPrefix && typedPrefix.includes('\\')
        ? typedPrefix.slice(0, typedPrefix.lastIndexOf('\\') + 1)
        : undefined

    return items.map((item) => {
        const {textEdit, additionalTextEdits, ...completion} = item as vscode.CompletionItem & {textEdit?: {newText: string}}
        const labelStr = typeof item.label === 'string' ? item.label : (item.label as any)?.label
        const insertText = fqcnPrefix && labelStr ? fqcnPrefix + labelStr : textEdit?.newText

        return {
            ...completion,
            range,
            ...(insertText ? {insertText} : {}),
            ...(insertText ? {filterText: insertText} : {}),
        }
    })
}

// Intelephense sets `detail` to `use <FQCN>` for importable classes/traits/modules.
// Strip the `use ` prefix, then validate it's a real FQCN (at least one backslash).
function extractFqcn(item: vscode.CompletionItem): string | undefined {
    const labelStr = typeof item.label === 'string'
        ? item.label
        : (item.label as any)?.label
    const detail = typeof item.detail === 'string' ? item.detail.trim() : ''

    const detailFqcn = detail.replace(/^use\s+/, '')

    if (/^[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)+$/.test(detailFqcn)) {
        return detailFqcn
    }

    if (typeof labelStr === 'string' && /^[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*$/.test(labelStr)) {
        return labelStr
    }

    return undefined
}

function inlineFqcnCompletions(
    items: vscode.CompletionItem[],
): vscode.CompletionItem[] {
    return items.map((item) => {
        const {additionalTextEdits, ...completion} = item as vscode.CompletionItem

        if (!item.kind || !classOnlyKinds.has(item.kind)) {
            return completion
        }

        const fqcn = extractFqcn(item)

        if (!fqcn) {
            return completion
        }

        const {textEdit, ...classCompletion} = completion
        const labelStr = typeof item.label === 'string'
            ? item.label
            : (item.label as any)?.label
        const insertText = `\\${fqcn}`

        return {
            ...classCompletion,
            insertText,
            filterText : labelStr ?? insertText,
        }
    })
}

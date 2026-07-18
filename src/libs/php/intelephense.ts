import * as vscode from 'vscode'
import * as cache from '../core/cache'
import {getWorkspaceFolder, isBladeUri} from '../core/utils'
import {getDebugMode} from '../core/config'
import {getCompiledContext, getCompiledContextFromDisk, isBladeCompleteCompiledPath} from '../compiler/compiled'
import {markCompiledAsAutoOpened} from '../blade/diagnostics'
import {debugLog, logResults} from '../core/debug'
import {parsePhpDocument} from '../../parsers/php'
import {mapUri} from '../compiler/result-mapper'
import {isGeneratedCompletionNoise} from '../compiler/generated-noise'
import {CompletionResult, getAnnotatedVariableType, getClassCompletionContext, getLivePhpRegion, getTypedCompletionContext, classCompletionKinds, classOnlyKinds, typedCompletionKinds} from '../blade/completion'
import {resolveClassFile} from './reflection'
import {dedupe, dedupeLinks, dedupeLocations, flattenDocumentSymbols, mapPosition, waitForProvider, byUniqueNameAndLine, referenceableKinds} from '../blade/symbols'
import {getBladeProps, getBladePropsWithValues, parseBladeDocument} from '../../parsers/blade'
import {getReferenceExcludes, isExcludedLocation, positionKey, prepareBladeReferencesForPhp} from '../rename/rename'
import {queryLivePhp} from './live-php-probe'
import {buildCompletionProbeUris, mapTypedCompletionItems, inlineFqcnCompletions, CompletionProbe} from './completion-probe'
import {resolveReferences} from './reference-resolver'
import {COMPLETION_DEBOUNCE_MS} from '../core/constants'
import {buildBladePropHover} from './php-type-inference'
import type {BladeReference} from '../rename/rename'

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
            '"PHP Intelephense" is required',
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

export function getReferencesFor(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
) {
    return cache.getLatestResultsFor(document, async(isCurrent) => {
        if (getBladeProps(document).some(({range}) => range.contains(position))) {
            return []
        }

        const filtered = await resolveReferences(document, position, token)

        if (!isCurrent()) {
            return undefined
        }

        logResults('getReferencesFor', document, filtered)

        return filtered
    })
}

export function getHoverFor(document: vscode.TextDocument, position: vscode.Position) {
    return cache.getLatestResultsFor(document, async(isCurrent) => {
        if (getBladeProps(document).some(({range}) => range.contains(position))) {
            return []
        }

        const propHover = buildBladePropHover(document, position)

        if (propHover) {
            return [propHover]
        }

        const live = await queryLivePhp<vscode.Hover>(document, 'vscode.executeHoverProvider', position, getLivePhpRegion)

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
        .filter((ref) =>
            ref.uri.scheme !== 'file' || !isBladeCompleteCompiledPath(ref.uri.fsPath),
        )
        .filter((ref) => !isBladeUri(ref.uri))
    const scanned = bladeReferences.get(positionKey(symbol.selectionRange.start)) ?? []
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
            getLivePhpRegion,
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
// A superseded invocation must settle its promise (empty list) — leaving it pending
// would hang the completion request VS Code already dispatched.
const completionDebounceTimers = new Map<string, {
    timer   : ReturnType<typeof setTimeout>
    resolve : (result: CompletionResult) => void
}>()

export function clearCompletionDebounce(document: vscode.TextDocument): void {
    const key = document.uri.toString()
    const existing = completionDebounceTimers.get(key)

    if (existing) {
        clearTimeout(existing.timer)
        existing.resolve({items: [], isIncomplete: false})
        completionDebounceTimers.delete(key)
    }
}

export async function getCompletionsFor(
    document: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string,
): Promise<vscode.CompletionList> {
    const key = document.uri.toString()
    const existing = completionDebounceTimers.get(key)

    if (existing) {
        clearTimeout(existing.timer)
        existing.resolve({items: [], isIncomplete: false})
    }

    const run = () => fetchCompletions(document, position, triggerCharacter)

    const completionResult = await new Promise<CompletionResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            completionDebounceTimers.delete(key)
            run().then(resolve, reject)
        }, COMPLETION_DEBOUNCE_MS)
        completionDebounceTimers.set(key, {timer, resolve})
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

    logCompletionDecision(document, position, typedContext, classContext, triggerCharacter)

    const startedAt = Date.now()
    const probe = await buildCompletionProbeUris(document, typedContext, classContext)
    const compiledAt = Date.now()

    if (!probe.typedUri && !probe.classUri && !probe.compiledContext) {
        return {items: [], isIncomplete: false}
    }

    const mappedPosition = getCompletionMappedPosition(probe, position)
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
    logCompletionQuery(mappedPosition, completionItems, mappedItems)
    logResults('getCompletionsFor', document, mappedItems)

    return {
        items        : mappedItems,
        isIncomplete : false,
    }
}

function filterCompletionItems(
    completionResult: vscode.CompletionList | vscode.CompletionItem[],
    typedContext: import('../blade/completion').TypedCompletionContext | undefined,
    classContext: import('../blade/completion').ClassCompletionContext | undefined,
    document?: vscode.TextDocument,
    position?: vscode.Position,
): vscode.CompletionItem[] {
    const source = document?.getText() ?? ''

    return (Array.isArray(completionResult) ? completionResult : completionResult.items)
        .filter((item) => shouldIncludeCompletionItem(item, typedContext, classContext, document, position, source))
}

function shouldIncludeCompletionItem(
    item: vscode.CompletionItem,
    typedContext: import('../blade/completion').TypedCompletionContext | undefined,
    classContext: import('../blade/completion').ClassCompletionContext | undefined,
    document?: vscode.TextDocument,
    position?: vscode.Position,
    source = '',
): boolean {
    if (item.kind === vscode.CompletionItemKind.Variable) {
        const label = typeof item.label === 'string' ? item.label : item.label?.label

        if (typeof label === 'string' && isGeneratedCompletionNoise(label, source)) {
            return false
        }
    }

    if (typedContext) {
        return item.kind !== undefined && typedCompletionKinds.has(item.kind)
    }

    if (classContext) {
        return item.kind !== undefined && classCompletionKinds.has(item.kind)
    }

    if (!document || !position) {
        return true
    }

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

    return true
}

function mapCompletionItems(
    completionItems: vscode.CompletionItem[],
    probe: CompletionProbe,
    typedContext: import('../blade/completion').TypedCompletionContext | undefined,
    classContext: import('../blade/completion').ClassCompletionContext | undefined,
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.CompletionItem[] {
    return probe.typedQuery
        ? mapTypedCompletionItems(completionItems, typedContext!.range)
        : classContext
            ? mapTypedCompletionItems(completionItems, classContext.range, classContext.prefix)
            : inlineFqcnCompletions(mapUri(
                completionItems,
                probe.compiledContext!.uri,
                document,
                probe.compiledContext!.markerMap,
                false,
                position,
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

function logCompletionDecision(
    document: vscode.TextDocument,
    position: vscode.Position,
    typedContext: import('../blade/completion').TypedCompletionContext | undefined,
    classContext: import('../blade/completion').ClassCompletionContext | undefined,
    triggerCharacter?: string,
): void {
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
}

function getCompletionMappedPosition(
    probe: CompletionProbe,
    position: vscode.Position,
): vscode.Position {
    return probe.typedQuery
        ? probe.typedQuery.position
        : probe.classQuery
            ? probe.classQuery.position
            : mapPosition(position, probe.compiledContext!.markerMap)
}

function logCompletionQuery(
    mappedPosition: vscode.Position,
    completionItems: vscode.CompletionItem[],
    mappedItems: vscode.CompletionItem[],
): void {
    debugLog([
        'completion query',
        `generated position: ${mappedPosition.line}:${mappedPosition.character}`,
        `raw items: ${completionItems.length}`,
        `mapped items: ${mappedItems.length}`,
        `labels: ${completionItems.map((i) => `${i.label}(${i.kind})`).join(', ')}`,
    ].join(' | '))
}

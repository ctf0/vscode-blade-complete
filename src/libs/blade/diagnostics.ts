import * as vscode from 'vscode'
import {getCompiledContext} from '../compiler/compiled'
import {getDebugMode, getEnableDiagnostics} from '../core/config'
import {debugLog} from '../core/debug'
import {BladeMarkerMap} from '../compiler/mapping'
import {clearDocumentCache} from '../core/cache'
import {clearHtmlSymbolsCache} from './html'
import {requestCodeLensRefresh} from '../core/codelens-refresh'
import {BLADE_SELECTOR} from '../core/utils'
import {
    openCompiledDoc,
    syncCompiledDoc,
    closeCompiledTab,
    clearAutoOpenedCompiledUri,
} from '../compiler/compiled-doc-lifecycle'
import {generatedNoisePattern} from '../compiler/generated-noise'
import {
    MAX_DIAGNOSTICS_ENTRIES,
    DIAGNOSTICS_REFRESH_DEBOUNCE_MS,
    DIAGNOSTICS_WAIT_MS,
    DIAGNOSTICS_REPUBLISH_DEBOUNCE_MS,
} from '../core/constants'

export {markCompiledAsAutoOpened, markCompiledAsUserOpened} from '../compiler/compiled-doc-lifecycle'

interface BladeEntry {
    bladeUri       : string
    compiledDoc    : vscode.TextDocument | undefined
    compiledUri    : vscode.Uri | undefined
    markerMap      : BladeMarkerMap | undefined
    timer          : ReturnType<typeof setTimeout> | undefined
    republishTimer : ReturnType<typeof setTimeout> | undefined
    generation     : number
    lastAccessed   : number
}

const collection = vscode.languages.createDiagnosticCollection('blade-complete')

// Blade file uri string -> entry for its compiled php document
const entries = new Map<string, BladeEntry>()
const MAX_ENTRIES = MAX_DIAGNOSTICS_ENTRIES

function evictOldestEntry(): void {
    if (entries.size <= MAX_ENTRIES) {
        return
    }

    // ponytail: O(1) LRU via Map insertion order. On access (getEntry)
    // we delete+re-set so the first key here is always the LRU entry.
    // Switch to a min-heap if lastAccessed semantics diverge from
    // insertion order (e.g. external timestamp updates).
    const oldestKey = entries.keys().next().value

    if (oldestKey === undefined) {
        return
    }

    const entry = entries.get(oldestKey)

    if (entry?.timer) {
        clearTimeout(entry.timer)
    }

    if (entry?.republishTimer) {
        clearTimeout(entry.republishTimer)
    }

    if (entry) {
        closeCompiledTab(entry, true).catch((error) => {
            debugLog(`evictOldestEntry closeCompiledTab failed: ${error instanceof Error ? error.message : String(error)}`)
        })
    }

    entries.delete(oldestKey)
}

// Diagnostics are computed for the blade currently in focus only: every
// analyzed blade keeps its compiled document open, so analyzing all open
// blades (or the workspace-index batch) floods the Problems panel with
// compiled-file entries.
let activeBladeDoc: vscode.TextDocument | undefined

const REFRESH_DEBOUNCE_MS = DIAGNOSTICS_REFRESH_DEBOUNCE_MS
const DIAGNOSTICS_WAIT_MS_VAL = DIAGNOSTICS_WAIT_MS
const REPUBLISH_DEBOUNCE_MS = DIAGNOSTICS_REPUBLISH_DEBOUNCE_MS

function mapDiagnostics(
    diagnostics: readonly vscode.Diagnostic[],
    markerMap: BladeMarkerMap,
): vscode.Diagnostic[] {
    const deduped = new Set<string>()

    return diagnostics.flatMap((diagnostic) => {
        if (diagnostic.source !== 'intelephense') {
            return []
        }

        if (generatedNoisePattern.test(diagnostic.message)) {
            return []
        }

        const range = markerMap.toSourceRange(diagnostic.range)

        if (!range) {
            // Diagnostic points at generated-only php (preamble, markers, ...)
            return []
        }

        // Component attribute expressions compile twice (resolve + withAttributes),
        // so dedup by message + mapped range — message-only would drop distinct
        // diagnostics sharing a message (same undefined var on two lines).
        const key = `${diagnostic.message}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`

        if (deduped.has(key)) {
            return []
        }

        deduped.add(key)

        return [new vscode.Diagnostic(range, diagnostic.message, diagnostic.severity ?? vscode.DiagnosticSeverity.Error)]
    })
}

// Intelephense publishes diagnostics asynchronously after the document is
// opened or its content changes — resolve on the next non-empty publish, with
// a timeout as safety net. No snapshot check here: with a stable compiled uri
// the store already holds the previous cycle's diagnostics, so a snapshot
// would resolve immediately with stale results. A timeout without any publish
// resolves undefined so the caller keeps the previous mapped diagnostics
// instead of wiping them on a slow intelephense start.
function waitForDiagnostics(uri: vscode.Uri): Promise<readonly vscode.Diagnostic[] | undefined> {
    return new Promise((resolve) => {
        let resolved = false
        let sawPublish = false

        const finish = (diagnostics: readonly vscode.Diagnostic[] | undefined): void => {
            if (resolved) {
                return
            }

            resolved = true
            clearTimeout(timeout)
            subscription.dispose()
            resolve(diagnostics)
        }

        const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
            if (event.uris.some((changed) => changed.toString() === uri.toString())) {
                sawPublish = true

                const diagnostics = vscode.languages.getDiagnostics(uri)

                if (diagnostics.some((diagnostic) => diagnostic.source === 'intelephense')) {
                    finish(diagnostics)
                }
            }
        })

        const timeout = setTimeout(() => {
            finish(sawPublish ? vscode.languages.getDiagnostics(uri) : undefined)
        }, DIAGNOSTICS_WAIT_MS_VAL)
    })
}

// A cycle's result is stale once a newer refresh started or the blade was
// closed (its entry removed) — anything produced must be dropped.
function isStale(entry: BladeEntry, generation: number): boolean {
    return generation !== entry.generation || entries.get(entry.bladeUri) !== entry
}

// A compiled doc parked after the blade was closed comes back as plaintext —
// re-activate it before returning.
async function resolveCompiledDoc(
    entry: BladeEntry,
    context: {uri: vscode.Uri},
    document: vscode.TextDocument,
): Promise<vscode.TextDocument | undefined> {
    let compiledDoc = entry.compiledDoc

    if (compiledDoc?.isClosed) {
        entry.compiledDoc = undefined
        clearAutoOpenedCompiledUri(compiledDoc.uri)
        compiledDoc = undefined
    }

    if (!compiledDoc || compiledDoc.uri.toString() !== context.uri.toString()) {
        compiledDoc = await openCompiledDoc(context.uri, document.uri.fsPath)

        if (!compiledDoc) {
            return undefined
        }

        entry.compiledDoc = compiledDoc
        entry.compiledUri = context.uri
    }

    if (compiledDoc.languageId !== 'php') {
        await vscode.languages.setTextDocumentLanguage(compiledDoc, 'php')
    }

    return compiledDoc
}

function closeCompiledTabQuietly(entry: BladeEntry, fsPath: string): void {
    void closeCompiledTab(entry).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(`closeCompiledTab failed for ${fsPath}: ${message}`)
    })
}

async function refreshNow(document: vscode.TextDocument): Promise<void> {
    if (!getEnableDiagnostics(document.uri)) {
        return
    }

    const entry = getEntry(document)
    const generation = ++entry.generation

    if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = undefined
    }

    const context = await getCompiledContext(document)

    if (isStale(entry, generation)) {
        return
    }

    if (!context) {
        entry.markerMap = undefined
        collection.delete(document.uri)

        return
    }

    entry.markerMap = context.markerMap
    const compiledDoc = await resolveCompiledDoc(entry, context, document)

    if (!compiledDoc) {
        return
    }

    const synced = await syncCompiledDoc(compiledDoc, context.content, true)

    if (isStale(entry, generation)) {
        return
    }

    // unchanged output with results already in the store — republish the current
    // raw diagnostics immediately instead of waiting out another full cycle
    // (the wait would race intelephense's publish burst and flicker the panel)
    const current = vscode.languages.getDiagnostics(compiledDoc.uri)

    if (!synced && current.some((diagnostic) => diagnostic.source === 'intelephense')) {
        collection.set(document.uri, mapDiagnostics(current, context.markerMap))
        closeCompiledTabQuietly(entry, document.uri.fsPath)

        return
    }

    const diagnostics = await waitForDiagnostics(compiledDoc.uri)

    if (isStale(entry, generation)) {
        return
    }

    if (diagnostics === undefined) {
        // intelephense never published this cycle — keep the previously
        // mapped diagnostics rather than clearing them with an empty store
        closeCompiledTabQuietly(entry, document.uri.fsPath)

        return
    }

    const mapped = mapDiagnostics(diagnostics, context.markerMap)

    collection.set(document.uri, mapped)
    closeCompiledTabQuietly(entry, document.uri.fsPath)

    if (getDebugMode(document.uri)) {
        debugLog(`diagnostics ${document.uri.fsPath}: ${mapped.length} mapped from ${diagnostics.length}`)
    }
}

function runRefresh(document: vscode.TextDocument): void {
    void refreshNow(document).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(`refreshNow failed for ${document.uri.fsPath}: ${message}`)
    })
}

function isBlade(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
    return document?.languageId === BLADE_SELECTOR
}

function isActiveBlade(document: vscode.TextDocument): boolean {
    return activeBladeDoc?.uri.toString() === document.uri.toString()
}

// Diagnostics are only computed for the blade currently in focus
function isFocusedBlade(document: vscode.TextDocument): boolean {
    return isBlade(document) && isActiveBlade(document)
}

function getEntry(document: vscode.TextDocument): BladeEntry {
    const key = document.uri.toString()
    let entry = entries.get(key)

    if (!entry) {
        entry = {
            bladeUri       : key,
            compiledDoc    : undefined,
            compiledUri    : undefined,
            markerMap      : undefined,
            timer          : undefined,
            republishTimer : undefined,
            generation     : 0,
            lastAccessed   : Date.now(),
        }
        entries.set(key, entry)
        evictOldestEntry()
    } else {
        entries.delete(key)
        entries.set(key, entry)
        entry.lastAccessed = Date.now()

        if (entries.size > MAX_ENTRIES) {
            evictOldestEntry()
        }
    }

    return entry
}

function scheduleRefresh(document: vscode.TextDocument): void {
    const entry = getEntry(document)

    if (entry.timer) {
        clearTimeout(entry.timer)
    }

    entry.timer = setTimeout(() => {
        entry.timer = undefined
        runRefresh(document)
    }, REFRESH_DEBOUNCE_MS)
}

// Intelephense republishes the compiled uri several times back-to-back (purge,
// partial, final, late dependent analysis). Republishing mapped diagnostics on
// every event flickers the Problems panel, so coalesce the bursts — and ignore
// empty (purge) publishes, which would wipe kept mapped diagnostics.
function republishMapped(entry: BladeEntry): void {
    if (entry.republishTimer) {
        clearTimeout(entry.republishTimer)
    }

    entry.republishTimer = setTimeout(() => {
        entry.republishTimer = undefined

        if (!entry.compiledUri || !entry.markerMap || entries.get(entry.bladeUri) !== entry) {
            return
        }

        const raw = vscode.languages.getDiagnostics(entry.compiledUri)

        if (raw.length === 0) {
            return
        }

        if (!raw.some((diagnostic) => diagnostic.source === 'intelephense')) {
            collection.delete(vscode.Uri.parse(entry.bladeUri))

            return
        }

        collection.set(vscode.Uri.parse(entry.bladeUri), mapDiagnostics(raw, entry.markerMap))
    }, REPUBLISH_DEBOUNCE_MS)
}

function releaseEntry(document: vscode.TextDocument, wipe = true): void {
    const uri = document.uri.toString()
    const entry = entries.get(uri)

    if (entry?.timer) {
        clearTimeout(entry.timer)
    }

    if (entry?.republishTimer) {
        clearTimeout(entry.republishTimer)
    }

    if (entry) {
        void closeCompiledTab(entry, wipe).catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            debugLog(`releaseEntry closeCompiledTab failed for ${document.uri.fsPath}: ${message}`)
        })
    }

    entries.delete(uri)
}

function clearEntry(document: vscode.TextDocument): void {
    releaseEntry(document)
    collection.delete(document.uri)
}

function clearAllEntries(): void {
    for (const entry of entries.values()) {
        if (entry.timer) {
            clearTimeout(entry.timer)
        }

        if (entry.republishTimer) {
            clearTimeout(entry.republishTimer)
        }

        void closeCompiledTab(entry, true).catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            debugLog(`clearAllEntries closeCompiledTab failed: ${message}`)
        })
    }

    entries.clear()
}

export function initDiagnostics(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        collection,
        vscode.workspace.onDidOpenTextDocument((document) => {
            if (isFocusedBlade(document)) {
                runRefresh(document)
            }
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (isFocusedBlade(event.document)) {
                scheduleRefresh(event.document)
            }
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (isFocusedBlade(document)) {
                runRefresh(document)
            }
        }),
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (isBlade(document)) {
                clearEntry(document)
            }
        }),
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            const next = editor?.document

            // focus moved — purge the previous blade's compiled entry; its
            // mapped diagnostics stay until the tab is closed
            if (activeBladeDoc && activeBladeDoc !== next) {
                releaseEntry(activeBladeDoc, false)
            }

            activeBladeDoc = isBlade(next) ? next : undefined

            if (isBlade(next)) {
                runRefresh(next)
            }
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration('bladeComplete.enableDiagnostics')) {
                return
            }

            // disabled — drop every compiled entry & mapped diagnostics; the
            // compiled tabs were auto-opened by this extension, safe to close
            if (!getEnableDiagnostics()) {
                collection.clear()
                clearAllEntries()
                activeBladeDoc = undefined

                return
            }

            const active = vscode.window.activeTextEditor?.document

            if (isBlade(active)) {
                activeBladeDoc = active
                runRefresh(active)
            }
        }),
        vscode.languages.onDidChangeDiagnostics((event) => {
            for (const entry of entries.values()) {
                if (
                    entry.compiledUri
                    && entry.markerMap
                    && event.uris.some((uri) => uri.toString() === entry.compiledUri?.toString())
                ) {
                    republishMapped(entry)
                }
            }
        }),
    )

    // Only the blade in focus gets diagnostics — refresh the active editor if any
    const active = vscode.window.activeTextEditor?.document

    if (isBlade(active)) {
        activeBladeDoc = active
        refreshNow(active)
    }
}

export function refreshAllOpenBlades(): void {
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId !== BLADE_SELECTOR) {
            continue
        }

        clearDocumentCache(doc)
        clearHtmlSymbolsCache(doc)

        const entry = entries.get(doc.uri.toString())

        if (entry) {
            entry.compiledDoc = undefined
            entry.compiledUri = undefined
            entry.markerMap = undefined
        }
    }

    requestCodeLensRefresh()

    const active = vscode.window.activeTextEditor?.document

    if (isBlade(active)) {
        runRefresh(active)
    }
}

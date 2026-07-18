import * as vscode from 'vscode'
import {getCompiledContext} from './compiled'
import {getDebugMode} from './config'
import {debugLog} from './debug'
import {BladeMarkerMap} from './mapping'
import {clearDocumentCache} from './cache'
import {clearHtmlSymbolsCache} from './html'
import {requestCodeLensRefresh} from './codelens-refresh'
import {manifestKey, removeManifestEntry} from './manifest'
import {getWorkspaceFolder, BLADE_SELECTOR} from './utils'

interface BladeEntry {
    bladeUri       : string
    compiledDoc    : vscode.TextDocument | undefined
    compiledUri    : vscode.Uri | undefined
    markerMap      : BladeMarkerMap | undefined
    timer          : ReturnType<typeof setTimeout> | undefined
    republishTimer : ReturnType<typeof setTimeout> | undefined
    generation     : number
}

const collection = vscode.languages.createDiagnosticCollection('blade-parser')

// Blade file uri string -> entry for its compiled php document
const entries = new Map<string, BladeEntry>()

// Compiled doc tabs WE auto-opened (vs user-opened via openCompiledPath command).
// Only these are eligible for auto-close after the diagnostics cycle.
const autoOpenedCompiledUris = new Set<string>()
// Compiled URIs the user explicitly opened — never auto-close these.
const userOpenedCompiledUris = new Set<string>()

export function markCompiledAsUserOpened(uri: vscode.Uri): void {
    userOpenedCompiledUris.add(uri.toString())
    autoOpenedCompiledUris.delete(uri.toString())
}

export function markCompiledAsAutoOpened(uri: vscode.Uri): void {
    if (!userOpenedCompiledUris.has(uri.toString())) {
        autoOpenedCompiledUris.add(uri.toString())
    }
}

// Diagnostics are computed for the blade currently in focus only: every
// analyzed blade keeps its compiled document open, so analyzing all open
// blades (or the workspace-index batch) floods the Problems panel with
// compiled-file entries.
let activeBladeDoc: vscode.TextDocument | undefined

const REFRESH_DEBOUNCE_MS = 200
const DIAGNOSTICS_WAIT_MS = 1000
const REPUBLISH_DEBOUNCE_MS = 150

// Diagnostics caused by the compiler's own generated variables/helpers are
// noise for the blade author (they never touch `$__env`, `$component`, ...).
const generatedNoisePattern = /(__env|__currentLoopData|__componentOriginal|__attributesOriginal|__propNames|__key|__value|\$__php_)/

function mapDiagnostics(
    diagnostics: readonly vscode.Diagnostic[],
    markerMap: BladeMarkerMap,
): vscode.Diagnostic[] {
    return diagnostics.flatMap((diagnostic) => {
        if (generatedNoisePattern.test(diagnostic.message)) {
            return []
        }

        const range = markerMap.toSourceRange(diagnostic.range)

        if (!range) {
            // Diagnostic points at generated-only php (preamble, markers, ...)
            return []
        }

        return [new vscode.Diagnostic(range, diagnostic.message, diagnostic.severity ?? vscode.DiagnosticSeverity.Error)]
    })
}

// Intelephense publishes diagnostics asynchronously after the document is
// opened or its content changes — resolve on the next non-empty publish, with
// a timeout as safety net. No snapshot check here: with a stable compiled uri
// the store already holds the previous cycle's diagnostics, so a snapshot
// would resolve immediately with stale results.
function waitForDiagnostics(uri: vscode.Uri): Promise<readonly vscode.Diagnostic[]> {
    return new Promise((resolve) => {
        let resolved = false

        const finish = (diagnostics: readonly vscode.Diagnostic[]): void => {
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
                const diagnostics = vscode.languages.getDiagnostics(uri)

                // ignore purge/empty events — keep waiting for the analysis result
                if (diagnostics.length > 0) {
                    finish(diagnostics)
                }
            }
        })

        const timeout = setTimeout(() => {
            finish(vscode.languages.getDiagnostics(uri))
        }, DIAGNOSTICS_WAIT_MS)
    })
}

// The compiled doc stays open (VS Code has no close API), so after each
// recompile its in-memory content must be replaced with the new output —
// otherwise both mapped and raw diagnostics would keep reflecting stale content.
// Returns true when the document was updated.
async function syncCompiledDoc(compiledDoc: vscode.TextDocument, content: string): Promise<boolean> {
    if (compiledDoc.getText() === content) {
        return false
    }

    const edit = new vscode.WorkspaceEdit()
    edit.replace(
        compiledDoc.uri,
        new vscode.Range(new vscode.Position(0, 0), compiledDoc.positionAt(compiledDoc.getText().length)),
        content,
    )

    if (await vscode.workspace.applyEdit(edit)) {
        // the edit makes the doc dirty — save it back so it never shows up as modified
        await compiledDoc.save()
    }

    return true
}

// Returns undefined when the compiled output cannot be opened (missing on
// disk, transient IO error) — the caller aborts the cycle.
async function openCompiledDoc(entry: BladeEntry, uri: vscode.Uri, bladePath: string): Promise<vscode.TextDocument | undefined> {
    try {
        const compiledDoc = await vscode.workspace.openTextDocument(uri)
        entry.compiledDoc = compiledDoc
        entry.compiledUri = uri
        autoOpenedCompiledUris.add(uri.toString())

        return compiledDoc
    } catch (error) {
        debugLog(`failed to open compiled doc for ${bladePath}: ${String(error)}`)

        return undefined
    }
}

// A cycle's result is stale once a newer refresh started or the blade was
// closed (its entry removed) — anything produced must be dropped.
function isStale(entry: BladeEntry, generation: number): boolean {
    return generation !== entry.generation || entries.get(entry.bladeUri) !== entry
}

async function refreshNow(document: vscode.TextDocument): Promise<void> {
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

    let compiledDoc = entry.compiledDoc

    if (compiledDoc?.isClosed) {
        entry.compiledDoc = undefined
        autoOpenedCompiledUris.delete(compiledDoc.uri.toString())
        compiledDoc = undefined
    }

    if (!compiledDoc || compiledDoc.uri.toString() !== context.uri.toString()) {
        compiledDoc = await openCompiledDoc(entry, context.uri, document.uri.fsPath)

        if (!compiledDoc) {
            return
        }
    }

    // a compiled doc parked after the blade was closed comes back as plaintext —
    // re-activate it before syncing content
    if (compiledDoc.languageId !== 'php') {
        await vscode.languages.setTextDocumentLanguage(compiledDoc, 'php')
    }

    const synced = await syncCompiledDoc(compiledDoc, context.content)

    if (isStale(entry, generation)) {
        return
    }

    // unchanged output with results already in the store — republish the current
    // raw diagnostics immediately instead of waiting out another full cycle
    // (the wait would race intelephense's publish burst and flicker the panel)
    const current = vscode.languages.getDiagnostics(compiledDoc.uri)

    if (!synced && current.length > 0) {
        collection.set(document.uri, mapDiagnostics(current, context.markerMap))
        void closeCompiledTab(entry)

        return
    }

    const diagnostics = await waitForDiagnostics(compiledDoc.uri)

    if (isStale(entry, generation)) {
        return
    }

    const mapped = mapDiagnostics(diagnostics, context.markerMap)

    collection.set(document.uri, mapped)
    void closeCompiledTab(entry)

    if (getDebugMode(document.uri)) {
        debugLog(`diagnostics ${document.uri.fsPath}: ${mapped.length} mapped from ${diagnostics.length}`)
    }
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
        }
        entries.set(key, entry)
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
        void refreshNow(document)
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

        if (!entry.compiledDoc || !entry.markerMap || entries.get(entry.bladeUri) !== entry) {
            return
        }

        const raw = vscode.languages.getDiagnostics(entry.compiledDoc.uri)

        if (raw.length === 0) {
            return
        }

        collection.set(vscode.Uri.parse(entry.bladeUri), mapDiagnostics(raw, entry.markerMap))
    }, REPUBLISH_DEBOUNCE_MS)
}

// Closes the compiled doc's editor tab if WE auto-opened it (not the user).
// Closing the tab is the only way to clear intelephense's raw diagnostics on
// the compiled URI from the Problems panel — there is no TextDocument.close()
// and we cannot clear another extension's DiagnosticCollection.
// wipeContent: delete the compiled file from disk after closing so
// intelephense drops diagnostics AND compileBladeOnce recompiles on reopen
// (the manifest hash would otherwise match the stale file). Only used on
// blade close/focus loss — must NOT be used after a refresh cycle.
async function closeCompiledTab(entry: BladeEntry, wipeContent = false): Promise<void> {
    const compiledUri = entry.compiledUri

    if (!compiledUri) {
        return
    }

    const key = compiledUri.toString()

    if (userOpenedCompiledUris.has(key)) {
        return
    }

    let closed = false

    if (autoOpenedCompiledUris.has(key)) {
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (
                    tab.input instanceof vscode.TabInputText
                    && tab.input.uri.toString() === key
                ) {
                    await vscode.window.tabGroups.close(tab, true)
                    closed = true
                    break
                }
            }

            if (closed) {
                break
            }
        }

        autoOpenedCompiledUris.delete(key)
    }

    if (wipeContent) {
        // Sync empty content BEFORE deleting the file so intelephense drops its
        // in-memory diagnostics. Deleting the file alone doesn't clear them —
        // the TextDocument stays alive ~3 min after tab close.
        if (entry.compiledDoc && !entry.compiledDoc.isClosed) {
            try {
                await syncCompiledDoc(entry.compiledDoc, '')
            } catch {
            }
        }

        entry.compiledDoc = undefined
        entry.compiledUri = undefined
        await deleteCompiledFile(key, entry.bladeUri)
    } else {
        entry.compiledDoc = undefined
    }
}

async function deleteCompiledFile(compiledUriStr: string, bladeUriStr: string): Promise<void> {
    try {
        await vscode.workspace.fs.delete(vscode.Uri.parse(compiledUriStr))
    } catch {
    }

    const bladePath = vscode.Uri.parse(bladeUriStr).fsPath
    const workspaceRoot = getWorkspaceFolder(vscode.Uri.parse(bladeUriStr))?.uri.fsPath
    await removeManifestEntry(workspaceRoot ? manifestKey(bladePath, workspaceRoot) : bladePath)
}

// Focus loss: purge the raw compiled entry (parked doc) but keep the mapped
// diagnostics on the blade file. The entry is dropped so the purge event
// cannot republish an empty mapped result over them.
function releaseEntry(document: vscode.TextDocument): void {
    const uri = document.uri.toString()
    const entry = entries.get(uri)

    if (entry?.timer) {
        clearTimeout(entry.timer)
    }

    if (entry?.republishTimer) {
        clearTimeout(entry.republishTimer)
    }

    if (entry) {
        void closeCompiledTab(entry, true)
    }

    entries.delete(uri)
}

function clearEntry(document: vscode.TextDocument): void {
    releaseEntry(document)
    collection.delete(document.uri)
}

export function initDiagnostics(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        collection,
        vscode.workspace.onDidOpenTextDocument((document) => {
            if (isFocusedBlade(document)) {
                refreshNow(document)
            }
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (isFocusedBlade(event.document)) {
                scheduleRefresh(event.document)
            }
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (isFocusedBlade(document)) {
                refreshNow(document)
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
                releaseEntry(activeBladeDoc)
            }

            activeBladeDoc = isBlade(next) ? next : undefined

            if (isBlade(next)) {
                refreshNow(next)
            }
        }),
        vscode.languages.onDidChangeDiagnostics((event) => {
            // republish mapped diagnostics when intelephense finishes a late analysis
            for (const entry of entries.values()) {
                if (
                    entry.compiledDoc
                    && entry.markerMap
                    && event.uris.some((uri) => uri.toString() === entry.compiledDoc?.uri.toString())
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
        refreshNow(active)
    }
}

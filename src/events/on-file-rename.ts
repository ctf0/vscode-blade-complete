import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'
import {getViewNameForPath, waitForLaravelGotoView, invalidateViewPhpDocBlocksCache} from '../libs/blade/view-data'
import {clearBladeReferenceCache, getRenameExcludes, startRenameOperation, finishRenameOperation} from '../libs/rename/rename'
import {getBladeExcludeGlob, isBladeUri} from '../libs/core/utils'
import {debugLog} from '../libs/core/debug'
import {replaceViewNamesInFiles, type RenameMapping, type PendingEdit} from '../libs/rename/view-name-replacer'
import {clearDocumentCache} from '../libs/core/cache'
import {clearHtmlSymbolsCache} from '../libs/blade/html'
import {compileBladeBatch} from '../libs/compiler/compiled'
import {requestCodeLensRefresh} from '../libs/core/codelens-refresh'
import {CONCURRENT_READS, RECOMPILE_DEBOUNCE_MS} from '../libs/core/constants'

type LaravelGotoViewApi = NonNullable<Awaited<ReturnType<typeof waitForLaravelGotoView>>>

function toTagName(viewName: string): string {
    return viewName.replace('components.', '')
}

// Debounced batch recompile for disk-written blade files. Each rename adds
// its blade file URIs to the set; after 500ms of inactivity we open all
// accumulated files, clear caches, and compile in one batch — so rapid
// consecutive renames grow the list and recompile everything in one go
// instead of recompiling the same files repeatedly.
const pendingRecompileUris = new Set<string>()
let recompileTimer: ReturnType<typeof setTimeout> | undefined
let recompileInFlight = false

function scheduleDiskRecompile(uris: string[]): void {
    for (const uri of uris) {
        pendingRecompileUris.add(uri)
    }

    if (recompileInFlight) {
        return
    }

    if (recompileTimer) {
        clearTimeout(recompileTimer)
    }

    recompileTimer = setTimeout(async() => {
        recompileTimer = undefined

        if (pendingRecompileUris.size === 0) {
            return
        }

        recompileInFlight = true
        const batch = [...pendingRecompileUris]

        pendingRecompileUris.clear()

        try {
            const documents: vscode.TextDocument[] = []

            for (const uriStr of batch) {
                try {
                    documents.push(await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr)))
                } catch {
                    // file may have been deleted or moved again
                }
            }

            if (documents.length === 0) {
                return
            }

            for (const doc of documents) {
                clearDocumentCache(doc)
                clearHtmlSymbolsCache(doc)
            }

            invalidateViewPhpDocBlocksCache()

            debugLog(`file-rename: recompiling disk batch of ${documents.length}`)
            await compileBladeBatch(documents)
            requestCodeLensRefresh()
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            debugLog(`file-rename: disk recompile failed ${message}`)
        } finally {
            recompileInFlight = false

            if (pendingRecompileUris.size > 0) {
                scheduleDiskRecompile([])
            }
        }
    }, RECOMPILE_DEBOUNCE_MS)
}

// Reading a file via `openTextDocument` registers it with the editor, fires
// didOpen events and triggers language servers (re-indexing) for every file
// we scan — that's what made renames slow. Only use the in-memory document
// when the file is actually open (to honour unsaved edits); otherwise read the
// bytes directly, in bounded parallel batches so thousands of files don't turn
// into thousands of sequential I/O round-trips.
function openDocuments(): Map<string, vscode.TextDocument> {
    return new Map(vscode.workspace.textDocuments.map((document) => ([document.uri.toString(), document])))
}

// Only documents shown in a visible editor tab. Background-opened documents
// (from openTextDocument by this or other extensions) are excluded — they must
// go through disk writes, otherwise applyEdit makes them dirty and VS Code
// promotes them to visible tabs with unsaved changes.
function visibleEditors(): Map<string, vscode.TextDocument> {
    return new Map(vscode.window.visibleTextEditors.map((editor) => [editor.document.uri.toString(), editor.document]))
}

async function readAllFiles(
    documents: Map<string, vscode.TextDocument>,
    uris: vscode.Uri[],
): Promise<{uri: vscode.Uri, content: string}[]> {
    const contents: {uri: vscode.Uri, content: string}[] = []
    const read: vscode.Uri[] = []

    for (const uri of uris) {
        const document = documents.get(uri.toString())

        if (document) {
            contents.push({uri, content: document.getText()})
        } else {
            read.push(uri)
        }
    }

    const readFile = async(uri: vscode.Uri) => {
        try {
            return {uri, content: await fs.readFile(uri.fsPath, 'utf8')} as const
        } catch (error) {
            debugLog(`file-rename: skipping unreadable file ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`)

            return undefined
        }
    }

    for (let i = 0; i < read.length; i += CONCURRENT_READS) {
        for (const entry of await Promise.all(read.slice(i, i + CONCURRENT_READS).map(readFile))) {
            if (entry) {
                contents.push(entry)
            }
        }
    }

    return contents
}

let pendingRename: Promise<void> = Promise.resolve()

// Apply ranges to a content string, sorting in descending start order so
// earlier offsets remain valid as later replacements shift the tail.
function buildModifiedContent(pending: PendingEdit): string {
    let modified = pending.content

    for (const range of [...pending.ranges].sort((a, b) => b.start - a.start)) {
        modified = modified.slice(0, range.start) + range.replacement + modified.slice(range.end)
    }

    return modified
}

async function applyDiskEdits(pending: PendingEdit[]): Promise<void> {
    await Promise.all(pending.map(async(entry) => {
        const modified = buildModifiedContent(entry)
        await fs.writeFile(entry.uri.fsPath, modified, 'utf8')
    }))
}

// Blade files written to disk as part of this rename.
function collectDiskBladeUris(diskEdits: PendingEdit[]): string[] {
    return diskEdits.filter((entry) => isBladeUri(entry.uri)).map((entry) => entry.uri.toString())
}

// Blade files among the editor edits still open in a visible tab.
function collectVisibleBladeUris(
    visibleDocs: Map<string, vscode.TextDocument>,
    editUris: string[],
): string[] {
    return editUris.filter((uriStr) => visibleDocs.get(uriStr) && isBladeUri(vscode.Uri.parse(uriStr)))
}

async function updateBladeViewReferences(
    renames: {oldPath: string, newPath: string}[],
): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    const cwd = workspaceFolder?.uri.fsPath

    const mappings: RenameMapping[] = (await Promise.all(
        renames.map(async({oldPath, newPath}) => {
            const [oldViewName, newViewName] = await Promise.all([
                getViewNameForPath(oldPath, cwd),
                getViewNameForPath(newPath, cwd),
            ])

            if (!oldViewName || !newViewName || oldViewName === newViewName) {
                return undefined
            }

            debugLog(`file-rename:
                before: "${oldPath}" → "${oldViewName}"
                after : "${newPath}" → "${newViewName}"
            `)

            return {
                oldViewName,
                newViewName,
                oldTagName : toTagName(oldViewName),
                newTagName : toTagName(newViewName),
            }
        }),
    )).filter((m): m is RenameMapping => Boolean(m))

    if (mappings.length === 0) {
        return
    }

    const api = await waitForLaravelGotoView()

    if (!workspaceFolder || !api) {
        return
    }

    await vscode.window.withProgress({
        location    : vscode.ProgressLocation.Notification,
        title       : `Updating ${mappings.length} blade reference${mappings.length > 1 ? 's' : ''}`,
        cancellable : false,
    }, async(progress) => {
        progress.report({message: 'Resolving view names...', increment: 0})

        const allDocuments = openDocuments()
        const visibleDocs = visibleEditors()
        const edit = new vscode.WorkspaceEdit()
        const diskEdits: PendingEdit[] = []

        progress.report({message: 'Searching files...', increment: 1})

        const searchExcludes = [...new Set([...getRenameExcludes(workspaceFolder), getBladeExcludeGlob()])]
        const exclude = searchExcludes.length > 1 ? `{${searchExcludes.join(',')}}` : searchExcludes[0]

        const [bladeUris, phpUris] = await Promise.all([
            vscode.workspace.findFiles('**/*.blade.php', exclude),
            vscode.workspace.findFiles('**/*.php', exclude),
        ])

        progress.report({message: `Scanning ${bladeUris.length + phpUris.length} files...`, increment: 1})

        const [bladeFiles, phpFiles] = await Promise.all([
            readAllFiles(allDocuments, bladeUris),
            readAllFiles(allDocuments, phpUris),
        ])

        replaceViewNamesInFiles(api, bladeFiles, mappings, visibleDocs, edit, diskEdits, true)
        replaceViewNamesInFiles(api, phpFiles, mappings, visibleDocs, edit, diskEdits, false)

        progress.report({message: 'Applying edits...', increment: 1})

        if (diskEdits.length > 0) {
            await applyDiskEdits(diskEdits)
        }

        let allBladeUris = collectDiskBladeUris(diskEdits)

        if (edit.size > 0) {
            clearBladeReferenceCache()
            const editUris = [...edit.entries()].map(([uri]) => uri.toString())
            const generation = startRenameOperation(editUris)

            await vscode.workspace.applyEdit(edit)
            finishRenameOperation(generation)

            allBladeUris = allBladeUris.concat(collectVisibleBladeUris(visibleDocs, editUris))
        }

        if (allBladeUris.length > 0) {
            scheduleDiskRecompile(allBladeUris)
        }

        progress.report({message: 'Done', increment: 1})

        if (diskEdits.length > 0 || edit.size > 0) {
            debugLog(`file-rename: updated disk=${diskEdits.length} editor=${edit.size} recompile=${allBladeUris.length}`)
        }
    })
}

async function expandDirectoryRenames(
    renames: {oldPath: string, newPath: string}[],
): Promise<{oldPath: string, newPath: string}[]> {
    const result: {oldPath: string, newPath: string}[] = []

    for (const {oldPath, newPath} of renames) {
        if (oldPath.endsWith('.blade.php') && newPath.endsWith('.blade.php')) {
            result.push({oldPath, newPath})
            continue
        }

        // Directory rename: find blade files inside the new path, then
        // derive the old path by swapping the directory prefix.
        try {
            const stat = await fs.stat(newPath)

            if (!stat.isDirectory()) {
                continue
            }

            const newUri = vscode.Uri.file(newPath)
            const pattern = new vscode.RelativePattern(newUri, '**/*.blade.php')
            const bladeFiles = await vscode.workspace.findFiles(pattern)

            for (const fileUri of bladeFiles) {
                const filePath = fileUri.fsPath
                const relativePath = path.relative(newPath, filePath)
                const oldFilePath = path.join(oldPath, relativePath)

                result.push({oldPath: oldFilePath, newPath: filePath})
            }
        } catch {
            // new path no longer exists or is not accessible
        }
    }

    return result
}

export function handleFileRename(event: vscode.FileRenameEvent): void {
    pendingRename = pendingRename.then(async() => {
        try {
            const allRenames = event.files.map(({oldUri, newUri}) => ({oldPath: oldUri.fsPath, newPath: newUri.fsPath}))
            const bladeRenames = await expandDirectoryRenames(allRenames)

            if (bladeRenames.length === 0) {
                return
            }

            await updateBladeViewReferences(bladeRenames)
        } catch (error) {
            debugLog(`file-rename failed: ${error instanceof Error ? error.message : String(error)}`)
        }
    })
}

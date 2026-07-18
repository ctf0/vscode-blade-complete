import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import escapeStringRegexp from 'escape-string-regexp'
import {getViewNameForPath, waitForLaravelGotoView} from '../libs/view-data'
import {markBladeRename, clearBladeReferenceCache, getRenameExcludes} from '../libs/rename'
import {BLADE_EXCLUDE_GLOB} from '../libs/utils'
import {positionAt} from '../libs/mapping'
import {debugLog} from '../libs/debug'

type LaravelGotoViewApi = NonNullable<Awaited<ReturnType<typeof waitForLaravelGotoView>>>

function toTagName(viewName: string): string {
    return viewName.replace('components.', '')
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

const CONCURRENT_READS = 64

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
        } catch {
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

type PendingEdit = {
    uri     : vscode.Uri
    content : string
    ranges  : {start: number, end: number, replacement: string}[]
}

async function applyDiskEdits(pending: PendingEdit[]): Promise<void> {
    await Promise.all(pending.map(async({uri, content, ranges}) => {
        let next = content

        for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
            next = next.slice(0, range.start) + range.replacement + next.slice(range.end)
        }

        await fs.writeFile(uri.fsPath, next, 'utf8')
    }))
}

function applyRanges(
    pending: PendingEdit,
    documents: Map<string, vscode.TextDocument>,
    edit: vscode.WorkspaceEdit,
    diskEdits: PendingEdit[],
): vscode.Uri | undefined {
    if (pending.ranges.length === 0) {
        return undefined
    }

    const document = documents.get(pending.uri.toString())

    if (document) {
        for (const {start, end, replacement} of pending.ranges) {
            edit.replace(
                pending.uri,
                new vscode.Range(positionAt(pending.content, start), positionAt(pending.content, end)),
                replacement,
            )
        }

        return pending.uri
    }

    diskEdits.push(pending)

    return undefined
}

async function replaceInBladeFiles(
    api: LaravelGotoViewApi,
    uris: vscode.Uri[],
    documents: Map<string, vscode.TextDocument>,
    oldViewName: string,
    newViewName: string,
    edit: vscode.WorkspaceEdit,
    diskEdits: PendingEdit[],
): Promise<void> {
    const oldTagName = toTagName(oldViewName)
    const newTagName = toTagName(newViewName)
    const componentPattern = oldTagName === newTagName
        ? null
        : new RegExp(`<\\/?x-(${escapeStringRegexp(oldTagName)})(?![\\w.-])`, 'g')

    for (const {uri, content} of await readAllFiles(documents, uris)) {
        if (!content.includes(oldViewName) && (!componentPattern || !content.includes(oldTagName))) {
            continue
        }

        const ranges: PendingEdit['ranges'] = []

        const collect = (text: string, start: number, replacement: string): void => {
            ranges.push({start, end: start + text.length, replacement})
        }

        for (const {text, index} of api.findViewNameCalls(content)) {
            if (text !== oldViewName) {
                continue
            }

            // `findViewNameCalls` reports `index` relative to the opening quote of the call
            // (`match.index` points at the quote, not the name), so `index` is one char short
            // of the name's true end. `+1` skips the quote to get the exact name span.
            collect(text, index + 1 - text.length, newViewName)
        }

        if (componentPattern) {
            for (const match of content.matchAll(componentPattern)) {
                collect(
                    match[1],
                    match.index! + match[0].indexOf(match[1]),
                    newTagName,
                )
            }
        }

        const openUri = applyRanges({uri, content, ranges}, documents, edit, diskEdits)

        if (openUri) {
            markBladeRename(openUri)
        }
    }
}

async function replaceViewCalls(
    api: LaravelGotoViewApi,
    uris: vscode.Uri[],
    documents: Map<string, vscode.TextDocument>,
    oldViewName: string,
    newViewName: string,
    edit: vscode.WorkspaceEdit,
    diskEdits: PendingEdit[],
): Promise<void> {
    for (const {uri, content} of await readAllFiles(documents, uris)) {
        if (!content.includes(oldViewName)) {
            continue
        }

        const ranges: PendingEdit['ranges'] = []

        for (const {text, index} of api.findViewNameCalls(content)) {
            if (text !== oldViewName) {
                continue
            }

            ranges.push({start: index + 1 - text.length, end: index + 1, replacement: newViewName})
        }

        applyRanges({uri, content, ranges}, documents, edit, diskEdits)
    }
}

async function updateBladeViewReferences(
    oldPath: string,
    newPath: string,
): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    const cwd = workspaceFolder?.uri.fsPath

    const [oldViewName, newViewName] = await Promise.all([
        getViewNameForPath(oldPath, cwd),
        getViewNameForPath(newPath, cwd),
    ])

    if (!oldViewName || !newViewName || oldViewName === newViewName) {
        return
    }

    debugLog(`file-rename:
        before: "${oldPath}" → "${oldViewName}"
        after : "${newPath}" → "${newViewName}"
    `)

    const api = await waitForLaravelGotoView()

    if (!workspaceFolder || !api) {
        return
    }

    const documents = openDocuments()
    const edit = new vscode.WorkspaceEdit()
    const diskEdits: PendingEdit[] = []

    const searchExcludes = [...new Set([...getRenameExcludes(workspaceFolder), BLADE_EXCLUDE_GLOB])]
    const exclude = searchExcludes.length > 1 ? `{${searchExcludes.join(',')}}` : searchExcludes[0]

    const [bladeUris, phpUris] = await Promise.all([
        vscode.workspace.findFiles('**/*.blade.php', exclude),
        vscode.workspace.findFiles('**/*.php', exclude),
    ])

    await Promise.all([
        replaceInBladeFiles(api, bladeUris, documents, oldViewName, newViewName, edit, diskEdits),
        replaceViewCalls(api, phpUris, documents, oldViewName, newViewName, edit, diskEdits),
    ])

    if (diskEdits.length > 0) {
        await applyDiskEdits(diskEdits)
    }

    if (edit.size > 0) {
        clearBladeReferenceCache()
        await vscode.workspace.applyEdit(edit)
    }

    if (diskEdits.length > 0 || edit.size > 0) {
        debugLog(`file-rename: updated ${diskEdits.length + edit.size} file(s)`)
    }
}

export async function handleFileRename(event: vscode.FileRenameEvent): Promise<void> {
    for (const {oldUri, newUri} of event.files) {
        if (!oldUri.fsPath.endsWith('.blade.php') || !newUri.fsPath.endsWith('.blade.php')) {
            continue
        }

        try {
            await updateBladeViewReferences(oldUri.fsPath, newUri.fsPath)
        } catch (error) {
            debugLog(`file-rename failed: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
}

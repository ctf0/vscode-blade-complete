import * as vscode from 'vscode'
import {getBladeRenameEditsForPhp, markRenameDocument} from '../libs/rename'
import {debugLog} from '../libs/debug'
import {getDebugMode} from '../libs/config'

function positionBefore(left: vscode.Position, right: vscode.Position): boolean {
    return left.line < right.line
      || (left.line === right.line && left.character < right.character)
}

function rangesOverlap(left: vscode.Range, right: vscode.Range): boolean {
    return positionBefore(left.start, right.end) && positionBefore(right.start, left.end)
}

type WorkspaceEditOperation = {
    _type    : number
    uri?     : vscode.Uri
    from?    : vscode.Uri
    to?      : vscode.Uri
    edit?    : vscode.TextEdit
    options?: {
        overwrite?         : boolean
        ignoreIfExists?    : boolean
        recursive?         : boolean
        ignoreIfNotExists? : boolean
    }
    metadata? : vscode.WorkspaceEditEntryMetadata
}

function getWorkspaceEditOperations(edit: vscode.WorkspaceEdit): WorkspaceEditOperation[] {
    // _allEntries is a private API that may be removed or change in future VS Code versions.
    // Guard against missing or changed API to prevent runtime crashes.
    const editable = edit as vscode.WorkspaceEdit & {
        _allEntries? : () => WorkspaceEditOperation[]
    }

    if (typeof editable._allEntries !== 'function') {
        return []
    }

    return editable._allEntries() ?? []
}

function dumpWorkspaceEdit(label: string, edit: vscode.WorkspaceEdit | undefined): void {
    if (!getDebugMode()) {
        return
    }

    const entries = edit?.entries() ?? []
    const allEntries = edit ? getWorkspaceEditOperations(edit) : []

    debugLog(`${label} operations:\n${JSON.stringify(allEntries.map(({_type, uri, from, to, edit}) => ({
        type    : _type,
        uri     : uri?.fsPath,
        from    : from?.fsPath,
        to      : to?.fsPath,
        range   : edit?.range,
        newText : edit?.newText,
    })), null, 2)}`)

    debugLog(`${label}:\n${JSON.stringify(entries.map(([uri, edits]) => ({
        uri   : uri.fsPath,
        edits : edits.map(({range, newText}) => ({
            range : {
                start : range.start,
                end   : range.end,
            },
            newText,
        })),
    })), null, 2)}`)

    for (const [uri, edits] of entries) {
        for (let index = 0; index < edits.length; index++) {
            for (let otherIndex = index + 1; otherIndex < edits.length; otherIndex++) {
                if (rangesOverlap(edits[index].range, edits[otherIndex].range)) {
                    debugLog(`${label} overlap: ${uri.fsPath} edits ${index}/${otherIndex}`)
                }
            }
        }
    }
}

class RenameProvider implements vscode.RenameProvider {
    constructor(
        private readonly provideNativeRename: (
            document: vscode.TextDocument,
            position: vscode.Position,
            newName: string,
            token: vscode.CancellationToken,
        ) => Thenable<vscode.WorkspaceEdit | undefined>,
    ) {}

    async provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        token: vscode.CancellationToken,
    ) {
        debugLog(`rename provider entered: ${document.uri.fsPath}:${position.line}:${position.character}`)

        const [nativeEdits, bladeEdits] = await Promise.all([
            this.provideNativeRename(document, position, newName, token),
            getBladeRenameEditsForPhp(document, position, newName, token),
        ])

        for (const [uri] of nativeEdits?.entries() ?? []) {
            markRenameDocument(uri)
        }

        dumpWorkspaceEdit('rename native WorkspaceEdit', nativeEdits)

        if (!nativeEdits) {
            return bladeEdits
        }

        if (!bladeEdits) {
            return nativeEdits
        }

        const nativeOperations = getWorkspaceEditOperations(nativeEdits)
        const hasFileOperations = nativeOperations.some(({_type}) => _type === 1)

        if (!hasFileOperations) {
            for (const [uri, edits] of bladeEdits.entries()) {
                nativeEdits.set(uri, [...nativeEdits.get(uri), ...edits])
            }

            dumpWorkspaceEdit('rename final WorkspaceEdit', nativeEdits)

            return nativeEdits
        }

        const mergedEdits = new vscode.WorkspaceEdit()

        // Use public entries() API for text edits — groups by URI, no overwrite bug
        for (const [uri, edits] of nativeEdits.entries()) {
            mergedEdits.set(uri, edits)
        }

        // Add blade edits on top of native text edits
        for (const [uri, edits] of bladeEdits.entries()) {
            const existing = mergedEdits.get(uri)
            mergedEdits.set(uri, existing ? [...existing, ...edits] : edits)
        }

        // File operations (rename/create/delete) — no public API, must use _allEntries
        for (const operation of nativeOperations) {
            if (operation._type !== 1) {
                continue
            }

            if (operation.from && operation.to) {
                mergedEdits.renameFile(operation.from, operation.to, operation.options, operation.metadata)
            } else if (operation.to) {
                mergedEdits.createFile(operation.to, operation.options, operation.metadata)
            } else if (operation.from) {
                mergedEdits.deleteFile(operation.from, operation.options, operation.metadata)
            }
        }

        dumpWorkspaceEdit('rename final WorkspaceEdit', mergedEdits)

        return mergedEdits
    }
}

export function registerRenameProvider(): vscode.Disposable {
    let renameRegistration: vscode.Disposable | undefined
    let forwardingRename = false
    const renameProvider = new RenameProvider(async(document, position, newName) => {
        if (forwardingRename) {
            return undefined
        }

        forwardingRename = true
        renameRegistration?.dispose()

        try {
            return await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
                'vscode.executeDocumentRenameProvider',
                document.uri,
                position,
                newName,
            )
        } finally {
            renameRegistration = vscode.languages.registerRenameProvider('php', renameProvider)
            forwardingRename = false
        }
    })

    renameRegistration = vscode.languages.registerRenameProvider('php', renameProvider)

    return {
        dispose : () => renameRegistration?.dispose(),
    }
}

import * as vscode from 'vscode'
import {getBladeRenameEditsForPhp, markRenameDocument} from '../libs/rename/rename'
import {debugLog} from '../libs/core/debug'
import {getDebugMode} from '../libs/core/config'

function dumpWorkspaceEdit(label: string, edit: vscode.WorkspaceEdit | undefined): void {
    if (!getDebugMode()) {
        return
    }

    const entries = edit?.entries() ?? []

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

        if (nativeEdits.size === 0) {
            void Promise.resolve(vscode.workspace.applyEdit(bladeEdits)).then((success) => {
                if (!success) {
                    debugLog('rename: failed to apply blade edits for file operation')
                }
            }).catch((error) => {
                const message = error instanceof Error ? error.message : String(error)
                debugLog(`rename: applyEdit failed: ${message}`)
            })

            return nativeEdits
        }

        for (const [uri, edits] of bladeEdits.entries()) {
            nativeEdits.set(uri, [...(nativeEdits.get(uri) ?? []), ...edits])
        }

        dumpWorkspaceEdit('rename final WorkspaceEdit', nativeEdits)

        return nativeEdits
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

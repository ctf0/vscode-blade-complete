import * as vscode from 'vscode'
import {getCodeLensesFor} from '../libs/php/intelephense'
import {getCachedResult} from '../libs/core/cache'
import {getDebugMode, getShowCodeLens} from '../libs/core/config'
import {debugLog} from '../libs/core/debug'
import {onDidChangeCodeLenses, requestCodeLensRefresh} from '../libs/core/codelens-refresh'

const pendingLenses = new Set<string>()

export class CodeLensProvider implements vscode.CodeLensProvider {
    readonly onDidChangeCodeLenses = onDidChangeCodeLenses

    provideCodeLenses(document: vscode.TextDocument) {
        if (!getShowCodeLens(document.uri)) {
            return this.debugLens(document)
        }

        const cached = getCachedResult<vscode.CodeLens[]>(document, 'lenses')

        if (cached && cached.length > 0) {
            return [
                ...cached,
                ...(this.debugLens(document) || []),
            ]
        }

        const key = document.uri.toString()

        if (!pendingLenses.has(key)) {
            pendingLenses.add(key)

            void getCodeLensesFor(document)
                .then((resolved) => {
                    if (resolved.length > 0) {
                        requestCodeLensRefresh()
                    }
                })
                .catch((error) => {
                    const message = error instanceof Error ? error.message : String(error)
                    debugLog(`getCodeLensesFor failed for ${document.uri.fsPath}: ${message}`)
                })
                .finally(() => {
                    pendingLenses.delete(key)
                })
        }

        return undefined
    }

    debugLens(document: vscode.TextDocument) {
        if (getDebugMode(document.uri)) {
            return [
                new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                    command   : 'bladeComplete.openCompiledPath',
                    title     : '$(go-to-file)‎ Open Compiled Files',
                    arguments : [document],
                }),
            ]
        }

        return undefined
    }
}

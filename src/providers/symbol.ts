import * as vscode from 'vscode'
import {getSymbolFor} from '../libs/php/intelephense'
import {getCachedHtmlSymbols, onHtmlSymbolsReady} from '../libs/blade/html'

let disposable: vscode.Disposable | undefined
let selector: vscode.DocumentSelector | undefined
let refreshTimer: NodeJS.Immediate | undefined

class SymbolProvider implements vscode.DocumentSymbolProvider {
    async provideDocumentSymbols(document: vscode.TextDocument) {
        const symbols = await getSymbolFor(document)
        const html = getCachedHtmlSymbols(document)

        const merged = [...symbols, ...html]

        return merged.length ? merged : undefined
    }
}

function registerProvider() {
    disposable?.dispose()
    disposable = vscode.languages.registerDocumentSymbolProvider(selector!, new SymbolProvider())
}

export function activate(documentSelector: vscode.DocumentSelector): vscode.Disposable {
    selector = documentSelector
    registerProvider()

    // When HTML symbols finish loading in the background, re-register the
    // provider to trigger VS Code's provider change event, which causes the
    // outline panel to re-request symbols — now with HTML included.
    const eventSub = onHtmlSymbolsReady.event(() => {
        refreshTimer = setImmediate(registerProvider)
    })

    return {
        dispose : () => {
            if (refreshTimer !== undefined) {
                clearImmediate(refreshTimer)
                refreshTimer = undefined
            }

            eventSub.dispose()
            disposable?.dispose()
            disposable = undefined
        },
    }
}

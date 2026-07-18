import * as vscode from 'vscode'
import {clearDocumentCache} from '../libs/cache'
import {clearHtmlSymbolsCache} from '../libs/html'
import {BLADE_SELECTOR} from '../libs/utils'

export function handleClose(document: vscode.TextDocument): void {
    if (document.languageId !== BLADE_SELECTOR) {
        return
    }

    clearDocumentCache(document)
    clearHtmlSymbolsCache(document)
}

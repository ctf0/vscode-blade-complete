import * as vscode from 'vscode'
import {clearDocumentCache} from '../libs/core/cache'
import {clearHtmlSymbolsCache} from '../libs/blade/html'
import {clearCompletionDebounce} from '../libs/php/intelephense'
import {BLADE_SELECTOR} from '../libs/core/utils'

export function handleClose(document: vscode.TextDocument): void {
    if (document.languageId !== BLADE_SELECTOR) {
        return
    }

    clearCompletionDebounce(document)
    clearDocumentCache(document)
    clearHtmlSymbolsCache(document)
}

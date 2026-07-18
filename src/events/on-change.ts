import * as vscode from 'vscode'
import {clearDocumentCache, shiftDocumentCache} from '../libs/cache'
import {clearHtmlSymbolsCache} from '../libs/html'
import {compileBlade, removeCompiledFile} from '../libs/compiled'
import {consumeBladeRename, consumeRenameDocument} from '../libs/rename'
import {BLADE_SELECTOR} from '../libs/utils'
import {debugLog} from '../libs/debug'
import {requestCodeLensRefresh} from '../libs/codelens-refresh'

export function handleChange(event: vscode.TextDocumentChangeEvent): void {
    const {document} = event

    if (consumeRenameDocument(document.uri)) {
        debugLog(`rename-save: change ${document.uri.fsPath} dirty=${document.isDirty}`)

        setTimeout(() => {
            debugLog(`rename-save: timeout ${document.uri.fsPath} dirty=${document.isDirty}`)

            if (document.isDirty) {
                void document.save().then(async(saved) => {
                    debugLog(`rename-save: save()=${saved} ${document.uri.fsPath}`)

                    if (!saved) {
                        try {
                            const {writeFile} = await import('fs/promises')
                            await writeFile(document.uri.fsPath, document.getText(), 'utf8')
                            debugLog(`rename-save: direct-write OK ${document.uri.fsPath}`)
                        } catch (error) {
                            debugLog(`rename-save: direct-write FAILED ${document.uri.fsPath} ${error instanceof Error ? error.message : String(error)}`)
                        }
                    }
                })
            }
        }, 0)
    }

    if (document.languageId !== BLADE_SELECTOR) {
        return
    }

    if (consumeBladeRename(document.uri)) {
        debugLog(`rename-blade: compiled-refresh ${document.uri.fsPath}`)
        clearDocumentCache(document)
        clearHtmlSymbolsCache(document)
        void removeCompiledFile(document)
            .then(() => compileBlade(document))
            .then(() => requestCodeLensRefresh())
    }

    event.contentChanges.forEach((change) => shiftDocumentCache(document, change))
}

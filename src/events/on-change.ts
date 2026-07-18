import * as vscode from 'vscode'
import {clearDocumentCache, shiftDocumentCache} from '../libs/core/cache'
import {clearHtmlSymbolsCache} from '../libs/blade/html'
import {compileBlade, removeCompiledFile} from '../libs/compiler/compiled'
import {consumeBladeRename, consumeRenameDocument, isRenameInProgress} from '../libs/rename/rename'
import {BLADE_SELECTOR} from '../libs/core/utils'
import {debugLog} from '../libs/core/debug'
import {requestCodeLensRefresh} from '../libs/core/codelens-refresh'

export function handleChange(event: vscode.TextDocumentChangeEvent): void {
    const {document} = event

    if (consumeRenameDocument(document.uri)) {
        debugLog(`rename-save: change ${document.uri.fsPath} dirty=${document.isDirty}`)

        // Rename edits applied via WorkspaceEdit leave the blade dirty; VS Code
        // does not auto-save it. Save on the next tick (after the edit settles),
        // falling back to a direct disk write when save() is refused (e.g. the
        // file was renamed on disk mid-operation).
        setTimeout(() => {
            debugLog(`rename-save: timeout ${document.uri.fsPath} dirty=${document.isDirty}`)

            if (document.isDirty) {
                void Promise.resolve(document.save()).then(async(saved) => {
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
                }).catch((error) => {
                    const message = error instanceof Error ? error.message : String(error)
                    debugLog(`rename-save: save() failed ${document.uri.fsPath} ${message}`)
                })
            }
        }, 0)
    }

    if (document.languageId !== BLADE_SELECTOR) {
        return
    }

    if (consumeBladeRename(document.uri)) {
        if (isRenameInProgress(document.uri.toString())) {
            debugLog(`rename-blade: skipped compile (rename in progress) ${document.uri.fsPath}`)
        } else {
            debugLog(`rename-blade: compiled-refresh ${document.uri.fsPath}`)
            clearDocumentCache(document)
            clearHtmlSymbolsCache(document)
            void removeCompiledFile(document)
                .then(() => compileBlade(document))
                .then(() => requestCodeLensRefresh())
                .catch((error) => {
                    const message = error instanceof Error ? error.message : String(error)
                    debugLog(`rename-blade: refresh failed ${document.uri.fsPath} ${message}`)
                })
        }
    }

    event.contentChanges.forEach((change) => shiftDocumentCache(document, change))
}

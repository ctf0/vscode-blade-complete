import * as vscode from 'vscode'
import {clearDocumentCache} from '../libs/core/cache'
import {clearHtmlSymbolsCache} from '../libs/blade/html'
import {compileBlade} from '../libs/compiler/compiled'
import {clearBladeReferenceCache} from '../libs/rename/rename'
import {invalidateViewPhpDocBlocksCache} from '../libs/blade/view-data'
import {debugLog} from '../libs/core/debug'
import {BLADE_SELECTOR} from '../libs/core/utils'
import {SAVE_DEBOUNCE_MS} from '../libs/core/constants'

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function handleSave(document: vscode.TextDocument): void {
    if (document.languageId !== BLADE_SELECTOR) {
        return
    }

    const key = document.uri.toString()
    const existing = saveTimers.get(key)

    if (existing) {
        clearTimeout(existing)
    }

    saveTimers.set(key, setTimeout(() => {
        saveTimers.delete(key)
        clearDocumentCache(document)
        clearHtmlSymbolsCache(document)
        clearBladeReferenceCache()
        invalidateViewPhpDocBlocksCache()
        void compileBlade(document).catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            debugLog(`compileBlade on save failed: ${message}`)
        })
    }, SAVE_DEBOUNCE_MS))
}

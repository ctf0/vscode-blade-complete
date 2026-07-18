import * as vscode from 'vscode'
import {clearDocumentCache} from '../libs/cache'
import {clearHtmlSymbolsCache} from '../libs/html'
import {compileBlade} from '../libs/compiled'
import {clearBladeReferenceCache} from '../libs/rename'
import {debugLog} from '../libs/debug'
import {BLADE_SELECTOR} from '../libs/utils'

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const SAVE_DEBOUNCE_MS = 150

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
        void compileBlade(document).catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            debugLog(`compileBlade on save failed: ${message}`)
        })
    }, SAVE_DEBOUNCE_MS))
}

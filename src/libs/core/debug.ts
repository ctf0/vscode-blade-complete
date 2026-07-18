import * as vscode from 'vscode'
import {getDebugMode} from './config'

export const debugOutputChannel = vscode.window.createOutputChannel('Blade Complete')

export function logResults<T>(operation: string, document: vscode.TextDocument, results: T) {
    if (!getDebugMode(document.uri)) {
        return
    }

    const count = Array.isArray(results) ? results.length : '?'

    debugOutputChannel.appendLine(`${operation}: ${document.uri.fsPath}`)
    debugOutputChannel.appendLine(`(${count})`)

    debugOutputChannel.appendLine('')
}

export function debugLog(message: string) {
    debugOutputChannel.appendLine(message)
}

export function dispose() {
    debugOutputChannel.dispose()
}

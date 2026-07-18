import * as vscode from 'vscode'

export const debugOutputChannel = vscode.window.createOutputChannel('Blade Parser')

export function logResults<T>(operation: string, document: vscode.TextDocument, results: T) {
    const count = Array.isArray(results) ? results.length : '?'

    debugOutputChannel.appendLine(`${operation}: ${document.uri.fsPath}`)
    debugOutputChannel.appendLine(`(${count})`)

    debugOutputChannel.appendLine('')
}

export function debugLog(message: string) {
    debugOutputChannel.appendLine(message)
}

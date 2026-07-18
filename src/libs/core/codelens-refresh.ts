import * as vscode from 'vscode'

// Firing the CodeLens provider's `onDidChangeCodeLenses` event is the reliable
// way to re-request lenses. The `editor.action.codeLensRefresh` command only
// exists while an active editor is focused, so calling it from background
// events (onDidChangeTextDocument during compiles) throws "command not found".
const emitter = new vscode.EventEmitter<void>()

export const onDidChangeCodeLenses = emitter.event

export function requestCodeLensRefresh(): void {
    emitter.fire()
}

export function dispose() {
    emitter.dispose()
}

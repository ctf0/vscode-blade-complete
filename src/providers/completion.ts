import * as vscode from 'vscode'
import {getCompletionsFor} from '../libs/php/intelephense'

export class CompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context: vscode.CompletionContext,
    ) {
        return getCompletionsFor(document, position, context.triggerCharacter)
    }
}

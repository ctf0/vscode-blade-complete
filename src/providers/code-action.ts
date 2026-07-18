import * as vscode from 'vscode'
import {access} from 'fs/promises'
import {getCompiledPath} from '../libs/compiler/compiled'
import {getDebugMode} from '../libs/core/config'

const compiledExists = async(filePath: string | undefined): Promise<boolean> => {
    if (!filePath) {
        return false
    }

    try {
        await access(filePath)

        return true
    } catch {
        return false
    }
}

export class CodeActionProvider implements vscode.CodeActionProvider {
    async provideCodeActions(document: vscode.TextDocument): Promise<vscode.CodeAction[] | undefined> {
        if (document.languageId !== 'blade' || !getDebugMode(document.uri)) {
            return undefined
        }

        const compiledPaths = await Promise.all([
            compiledExists(getCompiledPath(document, 'php')),
        ])

        if (!compiledPaths.some(Boolean)) {
            return undefined
        }

        const action = new vscode.CodeAction('Blade: Open Compiled Files', vscode.CodeActionKind.Empty)

        action.command = {
            command   : 'bladeComplete.openCompiledPath',
            title     : 'Open Compiled Files',
            arguments : [document],
        }

        return [action]
    }
}

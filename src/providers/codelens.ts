import * as vscode from 'vscode'
import {getCodeLensesFor} from '../libs/intelephense'
import {getDebugMode, getShowCodeLens} from '../libs/config'
import {onDidChangeCodeLenses} from '../libs/codelens-refresh'

export class CodeLensProvider implements vscode.CodeLensProvider {
    readonly onDidChangeCodeLenses = onDidChangeCodeLenses

    async provideCodeLenses(document: vscode.TextDocument) {
        if (!getShowCodeLens(document.uri)) {
            return undefined
        }

        const lenses = await getCodeLensesFor(document)

        if (getDebugMode(document.uri)) {
            return [
                ...lenses,
                new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                    command   : 'bladeParser.openCompiledPath',
                    title     : '$(go-to-file)‎ Open Compiled Files',
                    arguments : [document],
                }),
            ]
        }

        return lenses.length ? lenses : undefined
    }
}

import * as vscode from 'vscode'
import {getDefinitionsFor} from '../libs/intelephense'

export class DefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Definition | vscode.LocationLink[] | undefined> {
        const definitions = await getDefinitionsFor(document, position)

        return definitions?.length ? definitions as vscode.Definition | vscode.LocationLink[] : undefined
    }
}

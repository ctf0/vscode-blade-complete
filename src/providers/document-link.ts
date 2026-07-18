import * as vscode from 'vscode'
import {getDocumentLinksFor} from '../libs/php/intelephense'

export class DocumentLinkProvider implements vscode.DocumentLinkProvider {
    async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[] | undefined> {
        const links = await getDocumentLinksFor(document)

        return links?.length ? links : undefined
    }
}

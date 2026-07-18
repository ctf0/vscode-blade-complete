import * as vscode from 'vscode'
import {getBladeReferencesForPhp, getReferenceExcludes} from '../libs/rename'
import {debugLog} from '../libs/debug'
import {getReferencesFor} from '../libs/intelephense'

let nextPhpReferenceRequest = 0

export class ReferenceProvider implements vscode.ReferenceProvider {
    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.ReferenceContext,
        token: vscode.CancellationToken,
    ) {
        const references = await getReferencesFor(document, position, token)

        return references?.length ? references : undefined
    }
}

async function getBladePhpReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
): Promise<vscode.Location[]> {
    const requestId = ++nextPhpReferenceRequest

    debugLog(`PHP Blade references start #${requestId}: ${document.uri.fsPath}:${position.line}:${position.character}`)
    const bladeReferences = await getBladeReferencesForPhp(document, position, getReferenceExcludes(document.uri), token)

    debugLog([
        `PHP references complete #${requestId}: ${document.uri.fsPath}:${position.line}:${position.character}`,
        `blade=${bladeReferences?.length ?? 0}`,
    ].join(' | '))

    return bladeReferences?.map(({document: bladeDocument, range}) =>
        new vscode.Location(bladeDocument.uri, range),
    ) ?? []
}

export function registerPhpReferenceProvider(): vscode.Disposable {
    const provider: vscode.ReferenceProvider = {
        provideReferences : async(document, position, _context, token) => {
            const references = await getBladePhpReferences(document, position, token)

            return references.length ? references : undefined
        },
    }

    return vscode.languages.registerReferenceProvider('php', provider)
}

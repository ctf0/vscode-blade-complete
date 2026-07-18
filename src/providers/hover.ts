import * as vscode from 'vscode'
import {getHoverFor} from '../libs/intelephense'

export class HoverProvider implements vscode.HoverProvider {
    provideHover(document: vscode.TextDocument, position: vscode.Position) {
        return getHoverFor(document, position).then((hovers) => {
            if (!hovers?.length) {
                return undefined
            }

            const hover = hovers[0]
            const range = document.getWordRangeAtPosition(position, /\\?[@$]?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*/)

            return new vscode.Hover(hover.contents, range)
        })
    }
}

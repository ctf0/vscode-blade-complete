import * as vscode from 'vscode'
import {getExcludeGlob} from './config'

export const BLADE_SELECTOR = 'blade'

export function getBladeExcludeGlob(): string {
    const patterns = getExcludeGlob()

    return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`
}

export function getWorkspaceFolder(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
    if (resource) {
        return vscode.workspace.getWorkspaceFolder(resource)
    }

    return vscode.workspace.workspaceFolders?.[0]
}

export function isBladeUri(uri: vscode.Uri): boolean {
    return uri.fsPath.endsWith('.blade.php')
}

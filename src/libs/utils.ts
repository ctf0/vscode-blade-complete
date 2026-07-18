import * as vscode from 'vscode'

export const BLADE_SELECTOR = 'blade'
export const BLADE_EXCLUDE_GLOB = '**/{vendor,storage,.*}/**'

export function getWorkspaceFolder(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
    if (resource) {
        return vscode.workspace.getWorkspaceFolder(resource)
    }

    return vscode.workspace.workspaceFolders?.[0]
}

export function isBladeUri(uri: vscode.Uri): boolean {
    return uri.fsPath.endsWith('.blade.php')
}

// Keep generated compiled files (extension workspace storage) from surfacing
// in intelephense results, preserving user excludes (workspace value first).
const BLADE_PARSER_STORAGE_GLOB = '**/ctf0.blade-parser/**'

const INTELEPHENSE_EXCLUDE_SECTIONS = ['references', 'rename'] as const

export async function setIntelephenseConfig() {
    const folder = getWorkspaceFolder()

    if (!folder) {
        return
    }

    const config = vscode.workspace.getConfiguration('intelephense', folder.uri)
    const configKey = 'codeLens.references.enable'
    const codeLensEnabled = config.get(configKey)

    if (codeLensEnabled !== false) {
        await config.update(configKey, false, vscode.ConfigurationTarget.Workspace)
    }

    for (const section of INTELEPHENSE_EXCLUDE_SECTIONS) {
        const configKey = `${section}.exclude`
        const current = config.get<string[]>(configKey) ?? []

        if (current.includes(BLADE_PARSER_STORAGE_GLOB)) {
            continue
        }

        await config.update(
            configKey,
            [...current, BLADE_PARSER_STORAGE_GLOB],
            vscode.ConfigurationTarget.Workspace,
        )
    }
}

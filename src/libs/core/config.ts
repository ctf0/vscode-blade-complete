import * as vscode from 'vscode'

const section = 'bladeComplete'

function config(resource?: vscode.ConfigurationScope): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(section, resource)
}

export function getPhpCommand(resource?: vscode.ConfigurationScope): string {
    return config(resource).get<string>('phpCommand') ?? 'php'
}

export function getPhpTinkerCommand(resource?: vscode.ConfigurationScope): string {
    return config(resource).get<string>('phpTinkerCommand') ?? 'php artisan tinker --no-ansi --no-interaction --execute'
}

export function getDockerPath(resource?: vscode.ConfigurationScope): string | undefined {
    return config(resource).get<string>('dockerPath')
}

export function getDebugMode(resource?: vscode.ConfigurationScope): boolean {
    return config(resource).get<boolean>('debug') ?? false
}

export function getPhpDocBlocks(resource?: vscode.ConfigurationScope): string[] {
    return config(resource).get<string[]>('phpDocBlocks') ?? []
}

export function getPhpDefaultImports(resource?: vscode.ConfigurationScope): string[] {
    return config(resource).get<string[]>('phpDefaultImports') ?? []
}

export function getReferenceDirectives(resource?: vscode.ConfigurationScope): string[] {
    return config(resource).get<string[]>('referenceDirectives') ?? []
}

export function getShowCodeLens(resource?: vscode.ConfigurationScope): boolean {
    return config(resource).get<boolean>('showCodeLens') ?? true
}

export function getEnableDiagnostics(resource?: vscode.ConfigurationScope): boolean {
    return config(resource).get<boolean>('enableDiagnostics') ?? true
}

export function getCustomDirectives(resource?: vscode.ConfigurationScope): Record<string, string> {
    return config(resource).get<Record<string, string>>('customDirectives') ?? {}
}

export function getExcludeGlob(resource?: vscode.ConfigurationScope): string[] {
    return config(resource).get<string[]>('exclude') ?? []
}

export function getCodeLensMaxSymbols(resource?: vscode.ConfigurationScope): number {
    return config(resource).get<number>('codeLens.maxSymbols') ?? 500
}

export function getCodeLensExcludeFiles(resource?: vscode.ConfigurationScope): string[] {
    return config(resource).get<string[]>('codeLens.excludeFiles') ?? []
}

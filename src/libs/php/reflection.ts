import {existsSync, readFileSync} from 'fs'
import {execa} from 'execa'
import * as vscode from 'vscode'
import path from 'path'
import {getDockerPath, getPhpCommand} from '../core/config'
import {splitCommand} from '../text/shell'
import {debugLog} from '../core/debug'
import {getWorkspaceFolder} from '../core/utils'

export async function resolveClassFile(
    document: vscode.TextDocument,
    className: string,
): Promise<string | undefined> {
    const workspace = getWorkspaceFolder(document.uri)

    try {
        const scriptPath = path.join(__dirname, '../scripts/resolve-class-path.php')
        const phpCode = readFileSync(scriptPath, 'utf8').replace('<?php', '')
        const [phpCommand, ...phpArgs] = splitCommand(getPhpCommand(document.uri))
        const {stdout} = await execa(phpCommand, [...phpArgs, '-r', phpCode, '--', className], {cwd: workspace?.uri.fsPath})
        const filePath = stdout.trim()

        if (!filePath) {
            return undefined
        }

        const dockerPath = getDockerPath()?.replace(/[\\/]+$/, '')
        const workspacePath = workspace?.uri.fsPath
        const localPath = dockerPath && workspacePath
          && (filePath === dockerPath || filePath.startsWith(`${dockerPath}/`))
            ? path.join(workspacePath, filePath.slice(dockerPath.length))
            : filePath

        const resolved = path.resolve(workspacePath ?? process.cwd(), localPath)

        if (!existsSync(resolved)) {
            debugLog(`resolveClassFile: resolved path does not exist: ${resolved}`)

            return undefined
        }

        return resolved
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(`resolveClassFile failed for ${className}: ${message}`)

        return undefined
    }
}

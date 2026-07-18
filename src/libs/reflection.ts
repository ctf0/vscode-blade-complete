import {readFileSync} from 'fs'
import {execa} from 'execa'
import * as vscode from 'vscode'
import path from 'path'
import {getDockerPath, getPhpCommand} from './config'
import {splitCommand} from './shell'
import {debugLog} from './debug'
import {getWorkspaceFolder} from './utils'

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

        return path.resolve(workspacePath ?? process.cwd(), localPath)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(`resolveClassFile failed for ${className}: ${message}`)

        return undefined
    }
}

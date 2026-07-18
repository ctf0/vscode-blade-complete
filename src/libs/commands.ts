import * as vscode from 'vscode'
import {execa} from 'execa'
import {access} from 'fs/promises'
import {getDebugMode, getDockerPath, getPhpTinkerCommand} from './core/config'
import {getCompiledPath} from './compiler/compiled'
import {splitCommand, phpString} from './text/shell'
import {debugLog} from './core/debug'
import {getWorkspaceFolder} from './core/utils'
import {markCompiledAsUserOpened} from './blade/diagnostics'

export async function openCompiledPath(document: vscode.TextDocument) {
    let {fileName} = document
    const workspacePath = getWorkspaceFolder(document.uri)?.uri.fsPath
    const dockerPath = getDockerPath(document.uri)
    fileName = dockerPath && workspacePath ? fileName.replace(workspacePath, dockerPath) : fileName

    try {
        const [tinkerCommand, ...tinkerArgs] = splitCommand(getPhpTinkerCommand(document.uri))
        const {stdout, stderr} = await execa(tinkerCommand, tinkerArgs, {input: `print(Blade::getCompiledPath(${phpString(fileName)}));`})

        if (stderr && getDebugMode(document.uri)) {
            debugLog(stderr)
        }

        if (!stdout) {
            return undefined
        }

        const files = [
            getCompiledPath(document, 'php'),
            dockerPath && workspacePath ? stdout.replace(dockerPath, workspacePath) : stdout,
        ].filter((f): f is string => f !== undefined)

        return pickAndOpenFile(files, workspacePath ?? '')
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(message)

        return undefined
    }
}

async function pickAndOpenFile(files: string[], ws: string) {
    const existing = (
        await Promise.all(
            files.map(async(f) => {
                try {
                    await access(f)

                    return f
                } catch {
                    return undefined
                }
            }),
        )
    ).filter((f): f is string => f !== undefined)

    if (existing.length === 0) {
        return undefined
    }

    const selected = await vscode.window.showQuickPick(
        existing.map((f) => ({label: f.replace(`${ws}/`, ''), description: f})),
        {placeHolder: 'Pick compiled files to open', canPickMany: true},
    )

    if (!selected) {
        return undefined
    }

    try {
        return await Promise.all(
            selected.map(async(s) => {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.description))
                markCompiledAsUserOpened(doc.uri)
                await vscode.window.showTextDocument(doc)
            }),
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(`pickAndOpenFile failed: ${message}`)

        return undefined
    }
}

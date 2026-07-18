import * as vscode from 'vscode'
import {execa} from 'execa'
import {getDockerPath, getPhpTinkerCommand} from './config'
import {getCompiledPath} from './compiled'
import {splitCommand, phpString} from './shell'
import {debugLog} from './debug'
import {getWorkspaceFolder} from './utils'
import {markCompiledAsUserOpened} from './diagnostics'

export async function openCompiledPath(document: vscode.TextDocument) {
    let {fileName} = document
    const workspacePath = getWorkspaceFolder(document.uri)?.uri.fsPath
    const dockerPath = getDockerPath(document.uri)
    fileName = dockerPath && workspacePath ? fileName.replace(workspacePath, dockerPath) : fileName

    try {
        const [tinkerCommand, ...tinkerArgs] = splitCommand(getPhpTinkerCommand(document.uri))
        const {stdout, stderr} = await execa(tinkerCommand, [...tinkerArgs, `print(Blade::getCompiledPath(${phpString(fileName)}));`])

        if (stderr) {
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
    const selected = await vscode.window.showQuickPick(
        files.map((f) => ({label: f.replace(`${ws}/`, ''), description: f})),
        {placeHolder: 'Pick compiled files to open', canPickMany: true},
    )

    if (!selected) {
        return undefined
    }

    return Promise.all(
        selected.map((s) =>
            vscode.workspace.openTextDocument(vscode.Uri.file(s.description)).then((doc) => {
                markCompiledAsUserOpened(doc.uri)
                vscode.window.showTextDocument(doc)
            }),
        ),
    )
}

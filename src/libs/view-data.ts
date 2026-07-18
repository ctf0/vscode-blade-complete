import {readFile} from 'fs/promises'
import path from 'path'
import * as vscode from 'vscode'
import {execa} from 'execa'
import {getDebugMode, getPhpTinkerCommand} from './config'
import {debugLog} from './debug'
import {phpString, splitCommand} from './shell'
import {getWorkspaceFolder} from './utils'
import {waitForProvider} from './symbols'

type LaravelGotoViewApi = {
    getViewName(
        fileName: string,
        keepFullPath: boolean,
        workspaceFolder?: string
    ): string
    findViewNameCalls(text: string): {text: string, index: number}[]
}

const extensionId = 'ctf0.laravel-goto-view'

let laravelGotoViewPromise: Promise<LaravelGotoViewApi | undefined> | undefined

export async function activateLaravelGotoView(): Promise<void> {
    const extension = vscode.extensions.getExtension(extensionId)

    if (!extension) {
        void vscode.window.showErrorMessage(
            'Blade Parser requires the "Laravel Goto View" extension to function',
        )

        throw new Error('Laravel Goto View activation failed: extension not found')
    }

    await extension.activate()
}

export function waitForLaravelGotoView(): Promise<LaravelGotoViewApi | undefined> {
    const workspaceFolder = getWorkspaceFolder()

    if (!workspaceFolder) {
        return Promise.resolve(undefined)
    }

    laravelGotoViewPromise ??= (async() => {
        const extension = await vscode.extensions.getExtension<LaravelGotoViewApi>(extensionId)?.activate()

        await waitForProvider(
            () => Promise.resolve(
                typeof extension?.getViewName === 'function'
                && extension.getViewName(`${workspaceFolder}/resources/views/test.blade.php`, true, workspaceFolder.uri.fsPath) === 'test',
            ),
            (ready) => ready,
            'LaravelGotoView',
        )

        return extension
    })()

    return laravelGotoViewPromise
}

export async function getViewNameForPath(filePath: string, workspaceFolder?: string): Promise<string | undefined> {
    const api = await waitForLaravelGotoView()

    if (!api) {
        return undefined
    }

    return api.getViewName(filePath, true, workspaceFolder) || undefined
}

export async function getViewPhpDocBlocks(documents: vscode.TextDocument[]): Promise<Map<string, string[]>> {
    try {
        const cwd = getWorkspaceFolder(documents[0].uri)?.uri.fsPath
        const views = Object.fromEntries(
            (await Promise.all(
                documents.map(async(document) => [
                    document.uri.toString(),
                    await getViewNameForPath(document.fileName, cwd),
                ] as const),
            ))
                .filter(([, name]) => name),
        )

        const scriptPath = path.join(__dirname, '../scripts/blade-view-data.php')
        const phpCode = (await readFile(scriptPath, 'utf8'))
            .replace('<?php', `$bladeParserViews = [${Object.entries(views).map(([id, name]) => `${phpString(id)} => ${phpString(name as string)}`).join(', ')}];`)
        const [tinkerCommand, ...tinkerArgs] = splitCommand(getPhpTinkerCommand(documents[0].uri))
        const {stdout, stderr} = await execa(tinkerCommand, [...tinkerArgs, phpCode], {cwd})

        if (stderr) {
            debugLog(`getViewPhpDocBlocks stderr: ${stderr}`)
        }

        const payload = stdout.match(/__BLADE_PARSER_VIEW_DATA__([A-Za-z0-9+/=]+)/)?.[1]

        if (!payload) {
            throw new Error('view data result not found')
        }

        const results = new Map(Object.entries(JSON.parse(Buffer.from(payload, 'base64').toString()) as Record<string, string[]>))

        if (getDebugMode(documents[0].uri)) {
            debugLog(`getViewPhpDocBlocks: (${results.size})`)
        }

        return results
    } catch (error) {
        debugLog(`getViewPhpDocBlocks failed: ${error instanceof Error ? error.message : String(error)}`)

        return new Map()
    }
}

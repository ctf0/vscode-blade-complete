import {readFile} from 'fs/promises'
import path from 'path'
import * as vscode from 'vscode'
import {execa} from 'execa'
import {getDebugMode, getPhpTinkerCommand} from '../core/config'
import {debugLog, debugOutputChannel} from '../core/debug'
import {phpString, splitCommand} from '../text/shell'
import {getWorkspaceFolder} from '../core/utils'
import {waitForProvider} from './symbols'
import {TINKER_FAILURE_WARN_THRESHOLD} from '../core/constants'

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
            '"Laravel Goto View" is required',
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

let viewPhpDocBlocksCache: Map<string, string[]> | undefined
let viewPhpDocBlocksVersion = 0
let tinkerFailureCount = 0

// Marks the cache as stale so the next getViewPhpDocBlocks call re-fetches.
// In-flight callers that already read the cache will return their (now stale)
// results — callers must tolerate eventual consistency for one tick.
export function invalidateViewPhpDocBlocksCache(): void {
    viewPhpDocBlocksCache = undefined
    viewPhpDocBlocksVersion++
}

async function fetchViewData(needFetch: vscode.TextDocument[]): Promise<Map<string, string[]>> {
    const cwd = getWorkspaceFolder(needFetch[0].uri)?.uri.fsPath
    const views = Object.fromEntries(
        (await Promise.all(
            needFetch.map(async(document) => [
                document.uri.toString(),
                await getViewNameForPath(document.fileName, cwd),
            ] as const),
        ))
            .filter(([, name]) => name),
    )

    const scriptPath = path.join(__dirname, '../scripts/blade-view-data.php')
    const phpCode = (await readFile(scriptPath, 'utf8'))
        .replace('<?php', `$bladeCompleteViews = [${Object.entries(views).map(([id, name]) => `${phpString(id)} => ${phpString(name as string)}`).join(', ')}];`)
    const [tinkerCommand, ...tinkerArgs] = splitCommand(getPhpTinkerCommand(needFetch[0].uri))
    const {stdout, stderr} = await execa(tinkerCommand, tinkerArgs, {cwd, input: phpCode})

    if (stderr && getDebugMode(needFetch[0].uri)) {
        debugLog(`getViewPhpDocBlocks stderr: ${stderr}`)
    }

    const payload = stdout.match(/__BLADE_COMPLETE_VIEW_DATA__([A-Za-z0-9+/=]+)/)?.[1]

    if (!payload) {
        throw new Error('view data result not found')
    }

    return new Map(Object.entries(JSON.parse(Buffer.from(payload, 'base64').toString()) as Record<string, string[]>))
}

function warnAboutTinkerFailure(): void {
    if (tinkerFailureCount !== TINKER_FAILURE_WARN_THRESHOLD) {
        return
    }

    void vscode.window.showWarningMessage(
        'Blade Complete: unable to fetch view data from PHP. View::share/composer type hints will not be available. Check the "Blade Complete" output channel for details.',
        'Open Output',
    ).then((action) => {
        if (action === 'Open Output') {
            debugOutputChannel.show()
        }
    })
}

export async function getViewPhpDocBlocks(documents: vscode.TextDocument[]): Promise<Map<string, string[]>> {
    const version = viewPhpDocBlocksVersion

    viewPhpDocBlocksCache ??= new Map()

    // Only fetch view data for documents not already in the cache.
    const needFetch = documents.filter((doc) => !viewPhpDocBlocksCache!.has(doc.uri.toString()))

    if (needFetch.length === 0) {
        return viewPhpDocBlocksCache
    }

    try {
        const fetched = await fetchViewData(needFetch)

        if (getDebugMode(needFetch[0].uri)) {
            debugLog(`getViewPhpDocBlocks: fetched ${fetched.size}, cache ${viewPhpDocBlocksCache.size + fetched.size}`)
        }

        if (version === viewPhpDocBlocksVersion) {
            for (const [key, value] of fetched) {
                viewPhpDocBlocksCache.set(key, value)
            }
        }
    } catch (error) {
        debugLog(`getViewPhpDocBlocks failed: ${error instanceof Error ? error.message : String(error)}`)
        tinkerFailureCount++
        warnAboutTinkerFailure()
    }

    return viewPhpDocBlocksCache
}

import * as vscode from 'vscode'
import {execa} from 'execa'
import {access, mkdir, readFile, readdir, rm, writeFile} from 'fs/promises'
import path from 'path'
import {getDebugMode, getPhpCommand, getPhpDocBlocks, getReferenceDirectives} from './config'
import {contentHash, evictOldestEntries, pathHash} from './cache'
import {debugLog} from './debug'
import {BladeMarkerMap} from './mapping'
import {splitCommand} from './shell'
import {getViewPhpDocBlocks} from './view-data'
import {showBusy, setIndexProgress, clearIndexProgress} from './status'
import {BLADE_EXCLUDE_GLOB, getWorkspaceFolder} from './utils'
import {
    cleanupStaleCompiledFiles as cleanupStale,
    getCompiledDir,
    getManifestEntry,
    loadManifestOnce,
    manifestKey,
    removeManifestEntry,
    updateManifestEntry,
} from './manifest'

export function initCompiledDir(context: vscode.ExtensionContext): void {
    const dir = context.storageUri?.fsPath ?? context.globalStorageUri?.fsPath

    if (dir) {
        // Dynamic import to avoid circular dependency
        import('./manifest').then((m) => m.initCompiledDir(dir))
    }
}

export function isBladeParserCompiledPath(filePath: string): boolean {
    const dir = getCompiledDir()

    return dir !== undefined && filePath.startsWith(dir + path.sep)
}

const compilationRequests = new Map<string, Promise<string | undefined>>()

export function getCompiledPath(document: vscode.TextDocument, ext: string): string | undefined {
    const dir = getCompiledDir()

    if (!dir) {
        return undefined
    }

    evictOldestEntries(compilationRequests, MAX_COMPILATION_CACHE_SIZE)

    return path.join(dir, `${pathHash(document)}.${ext}`)
}

async function saveCompiledContent(
    document: vscode.TextDocument,
    content: string,
    ext: string = 'php',
): Promise<string> {
    const filePath = getCompiledPath(document, ext)

    if (!filePath) {
        throw new Error('Blade Parser: compiled directory not initialized')
    }

    await mkdir(path.dirname(filePath), {recursive: true})
    await writeFile(filePath, content)

    return filePath
}

// Saves synthetic probe content to a content-unique filename so intelephense
// never serves stale parses for a previously-cached URI. The compiled dir
// cleanup already removes orphaned <hash>.php files on the next index run.
export async function saveCompiledProbe(
    document: vscode.TextDocument,
    content: string,
): Promise<string> {
    const dir = getCompiledDir()

    if (!dir) {
        throw new Error('Blade Parser: compiled directory not initialized')
    }

    const filePath = path.join(dir, `${contentHash(content)}.php`)
    await mkdir(path.dirname(filePath), {recursive: true})
    await writeFile(filePath, content)

    return filePath
}

function trackCompilation(
    filePath: string,
    operation: () => Promise<string | undefined>,
): Promise<string | undefined> {
    const pending = compilationRequests.get(filePath)

    if (pending) {
        return pending
    }

    const request = operation()
    compilationRequests.set(filePath, request)

    return request.finally(() => {
        if (compilationRequests.get(filePath) === request) {
            compilationRequests.delete(filePath)
        }
    })
}

const MAX_COMPILATION_CACHE_SIZE = 500

export function compileBlade(document: vscode.TextDocument): Promise<string | undefined> {
    const filePath = getCompiledPath(document, 'php')

    if (!filePath) {
        return Promise.resolve(undefined)
    }

    return trackCompilation(filePath, () => compileBladeOnce(document, filePath))
}

export async function getCompiledContext(document: vscode.TextDocument): Promise<{
    uri       : vscode.Uri
    markerMap : BladeMarkerMap
    content   : string
} | undefined> {
    const compiledPath = await compileBlade(document)

    if (!compiledPath) {
        return undefined
    }

    try {
        const content = await readFile(compiledPath, 'utf8')

        return {
            uri       : vscode.Uri.file(compiledPath),
            markerMap : new BladeMarkerMap(content),
            content,
        }
    } catch {
        return undefined
    }
}

// Reads the last compiled output without recompiling, so read-only features (document
// links) don't trigger a PHP compile on every keystroke while the document is dirty.
export async function getCompiledContextFromDisk(document: vscode.TextDocument): Promise<{
    uri       : vscode.Uri
    markerMap : BladeMarkerMap
} | undefined> {
    const compiledPath = getCompiledPath(document, 'php')

    if (!compiledPath) {
        return undefined
    }

    try {
        return {
            uri       : vscode.Uri.file(compiledPath),
            markerMap : new BladeMarkerMap(await readFile(compiledPath, 'utf8')),
        }
    } catch {
        return undefined
    }
}

export function compileHtml(document: vscode.TextDocument): Promise<string | undefined> {
    const filePath = getCompiledPath(document, 'html')

    if (!filePath) {
        return Promise.resolve(undefined)
    }

    return trackCompilation(
        filePath,
        () => saveCompiledContent(document, document.getText(), 'html').catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            debugLog(`compileHtml failed: ${message}`)

            return undefined
        }),
    )
}

function getConfigPrefix(resource: vscode.ConfigurationScope): string {
    const phpString = (value: string) =>
        `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`

    const referenceDirectives = getReferenceDirectives(resource)
    const refPattern = referenceDirectives.length > 0
        ? `/^@(${referenceDirectives.join('|')})\\b/i`
        : '/^(?!)/'

    return [
        '$phpDocBlocks = [];',
        `\$refPattern = ${phpString(refPattern)};`,
    ].join('\n')
}

const MAX_COMPILE_FILE_SIZE = 500 * 1024 // 500KB — prevents code injection via huge files

const warnedLargeFiles = new Set<string>()

function warnIfTooLarge(uri: string, fsPath: string, length: number): void {
    if (warnedLargeFiles.has(uri)) {
        return
    }

    warnedLargeFiles.add(uri)
    void vscode.window.showWarningMessage(
        `Blade Parser: "${path.basename(fsPath)}" is too large (${(length / 1024).toFixed(0)}KB). `
        + 'Compilation, references, and rename support are disabled for this file.',
    )
}

function manifestKeyAndHash(
    document: vscode.TextDocument,
    content: string,
): {manifestPath: string, hash: string, workspaceRoot: string | undefined} {
    const sourcePath = document.uri.fsPath
    const workspaceRoot = getWorkspaceFolder(document.uri)?.uri.fsPath

    return {
        manifestPath : workspaceRoot ? manifestKey(sourcePath, workspaceRoot) : sourcePath,
        hash         : contentHash(content),
        workspaceRoot,
    }
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath)

        return true
    } catch {
        return false
    }
}

async function compileBladeOnce(document: vscode.TextDocument, filePath: string): Promise<string | undefined> {
    const content = document.getText()

    if (content.length > MAX_COMPILE_FILE_SIZE) {
        debugLog(`compileBlade skipped: file too large (${content.length} bytes)`)
        warnIfTooLarge(document.uri.toString(), document.uri.fsPath, content.length)

        return undefined
    }

    const {manifestPath, hash, workspaceRoot} = manifestKeyAndHash(document, content)
    const entry = await getManifestEntry(manifestPath)

    if (entry && entry.hash === hash && await fileExists(filePath)) {
        return filePath
    }

    await rm(filePath, {force: true})

    if (getDebugMode(document.uri)) {
        debugLog(`compileBlade recompiling ${document.uri.fsPath} (dirty=${document.isDirty})`)
    }

    const result = await executePhpCompile([document], workspaceRoot)

    return result.get(document.uri.toString()) ?? undefined
}

interface PhpInput {
    id           : string
    path         : string
    content      : string
    version      : number
    phpDocBlocks : string[]
}

function buildPhpInputs(
    documents: vscode.TextDocument[],
    viewPhpDocBlocks: Map<string, string[]>,
): PhpInput[] {
    return documents.map((doc, i) => ({
        id           : String(i),
        path         : doc.uri.fsPath,
        content      : doc.getText(),
        version      : doc.version,
        phpDocBlocks : [...getPhpDocBlocks(doc.uri), ...(viewPhpDocBlocks.get(doc.uri.toString()) ?? [])],
    }))
}

async function parseCompileOutput(
    stdout: string,
    documents: vscode.TextDocument[],
    inputs: PhpInput[],
    cwd: string | undefined,
): Promise<Map<string, string | undefined>> {
    const results = new Map<string, string | undefined>()

    if (stdout) {
        const compiledItems = JSON.parse(stdout) as {id: string, compiled: string}[]

        for (const item of compiledItems) {
            const index = Number(item.id)
            const doc = documents[index]
            const input = inputs[index]

            if (doc && input) {
                const fPath = getCompiledPath(doc, 'php')

                if (fPath) {
                    await saveCompiledContent(doc, item.compiled)
                    await updateManifestEntry(
                        cwd ? manifestKey(doc.uri.fsPath, cwd) : doc.uri.fsPath,
                        path.basename(fPath),
                        contentHash(input.content),
                    )
                }

                evictOldestEntries(compilationRequests, MAX_COMPILATION_CACHE_SIZE)
                results.set(doc.uri.toString(), fPath ?? undefined)
            }
        }
    }

    for (const doc of documents) {
        if (!results.has(doc.uri.toString())) {
            results.set(doc.uri.toString(), undefined)
        }
    }

    return results
}

function buildFailureResults(documents: vscode.TextDocument[]): Map<string, string | undefined> {
    return new Map(documents.map((doc) => [doc.uri.toString(), undefined as string | undefined]))
}

async function executePhpCompile(
    documents: vscode.TextDocument[],
    cwd: string | undefined,
): Promise<Map<string, string | undefined>> {
    if (documents.length === 0 || !cwd) {
        return new Map()
    }

    const releaseStatus = showBusy(
        documents.length === 1
            ? `Blade: compiling ${path.basename(documents[0].uri.fsPath)}`
            : `Blade: compiling ${documents.length} files`,
    )

    try {
        const scriptPath = path.join(__dirname, '../scripts/blade-compile-clean.php')
        const phpCode = (await readFile(scriptPath, 'utf8'))
            .replace('<?php', getConfigPrefix(documents[0].uri))

        const viewPhpDocBlocks = await getViewPhpDocBlocks(documents)
        const [phpCommand, ...phpArgs] = splitCommand(getPhpCommand(documents[0].uri))
        const inputs = buildPhpInputs(documents, viewPhpDocBlocks)

        const {stdout, stderr} = await execa(phpCommand, [...phpArgs, '-r', phpCode], {cwd, input: JSON.stringify(inputs)})

        if (stderr) {
            debugLog(`executePhpCompile stderr: ${stderr}`)
        }

        return await parseCompileOutput(stdout, documents, inputs, cwd)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(`executePhpCompile failed: ${message}`)

        return buildFailureResults(documents)
    } finally {
        releaseStatus()
    }
}

type DocumentClassification
    = | {kind: 'skip', uri: string}
      | {kind: 'cached', uri: string, filePath: string}
      | {kind: 'compile', document: vscode.TextDocument, filePath: string, stale: boolean}

async function classifyDocument(
    document: vscode.TextDocument,
    manifest: {files: Record<string, {compiled: string, hash: string}>},
): Promise<DocumentClassification> {
    const uri = document.uri.toString()
    const filePath = getCompiledPath(document, 'php')

    if (!filePath) {
        return {kind: 'skip', uri}
    }

    const content = document.getText()

    if (content.length > MAX_COMPILE_FILE_SIZE) {
        warnIfTooLarge(uri, document.uri.fsPath, content.length)

        return {kind: 'skip', uri}
    }

    const {manifestPath, hash} = manifestKeyAndHash(document, content)
    const entry = manifest.files[manifestPath]

    if (entry && entry.hash === hash && await fileExists(filePath)) {
        return {kind: 'cached', uri, filePath}
    }

    return {kind: 'compile', document, filePath, stale: await fileExists(filePath)}
}

function groupByWorkspaceRoot(documents: vscode.TextDocument[]): Map<string, vscode.TextDocument[]> {
    const byCwd = new Map<string, vscode.TextDocument[]>()

    for (const doc of documents) {
        const cwd = getWorkspaceFolder(doc.uri)?.uri.fsPath ?? ''
        const group = byCwd.get(cwd) ?? []
        group.push(doc)
        byCwd.set(cwd, group)
    }

    return byCwd
}

export async function compileBladeBatch(
    documents: vscode.TextDocument[],
    onProgress?: (indexed: number, total: number) => void,
): Promise<Map<string, string | undefined>> {
    if (documents.length === 0) {
        return new Map()
    }

    const total = documents.length
    let indexed = 0

    const markIndexed = (): void => {
        indexed++
        onProgress?.(indexed, total)
    }

    const results = new Map<string, string | undefined>()
    const needCompile: vscode.TextDocument[] = []
    const stalePaths: string[] = []
    const manifest = await loadManifestOnce()

    for (const document of documents) {
        const classification = await classifyDocument(document, manifest)

        if (classification.kind === 'skip') {
            results.set(classification.uri, undefined)
            markIndexed()
            continue
        }

        if (classification.kind === 'cached') {
            results.set(classification.uri, classification.filePath)
            markIndexed()
            continue
        }

        if (classification.stale) {
            stalePaths.push(classification.filePath)
        }

        needCompile.push(classification.document)
    }

    if (stalePaths.length > 0) {
        await Promise.all(stalePaths.map((p) => rm(p, {force: true})))
    }

    if (needCompile.length === 0) {
        return results
    }

    const byCwd = groupByWorkspaceRoot(needCompile)
    const COMPILE_BATCH_SIZE = 50

    for (const [cwd, group] of byCwd) {
        for (let i = 0; i < group.length; i += COMPILE_BATCH_SIZE) {
            const batch = group.slice(i, i + COMPILE_BATCH_SIZE)
            const batchResults = await executePhpCompile(batch, cwd || undefined)

            for (const doc of batch) {
                const docUri = doc.uri.toString()
                const fPath = getCompiledPath(doc, 'php')

                results.set(docUri, batchResults.get(docUri) ?? fPath ?? undefined)
                markIndexed()
            }
        }
    }

    return results
}

export async function removeCompiledFile(document: vscode.TextDocument): Promise<void> {
    const phpPath = getCompiledPath(document, 'php')
    const completionPath = getCompiledPath(document, 'completion.php')
    const htmlPath = getCompiledPath(document, 'html')

    const paths = [phpPath, completionPath, htmlPath].filter((p): p is string => p !== undefined)

    if (paths.length === 0) {
        return
    }

    try {
        await Promise.all(paths.map((p) => rm(p, {force: true})))
    } catch {
        // File doesn't exist; nothing to clean
    }

    const workspaceRoot = getWorkspaceFolder(document.uri)?.uri.fsPath
    await removeManifestEntry(workspaceRoot ? manifestKey(document.uri.fsPath, workspaceRoot) : document.uri.fsPath)
}

export {cleanupStale as cleanupStaleCompiledFiles}

let startupCompilationRunning = false
let startupCompilationPromise: Promise<void> | undefined
let startupGeneration = 0

export async function startupCompileWorkspace(): Promise<void> {
    if (startupCompilationRunning) {
        return
    }

    const generation = ++startupGeneration
    startupCompilationRunning = true
    startupCompilationPromise = (async() => {
        try {
            const uris = await vscode.workspace.findFiles('**/*.blade.php', BLADE_EXCLUDE_GLOB)

            if (uris.length === 0 || startupGeneration !== generation) {
                return
            }

            const openDocs = new Map<string, vscode.TextDocument>()

            for (const doc of vscode.workspace.textDocuments) {
                openDocs.set(doc.uri.toString(), doc)
            }

            const documents: vscode.TextDocument[] = []

            for (const uri of uris) {
                if (startupGeneration !== generation) {
                    return
                }

                const existing = openDocs.get(uri.toString())

                if (existing) {
                    documents.push(existing)
                } else {
                    documents.push(await vscode.workspace.openTextDocument(uri))
                }
            }

            setIndexProgress(0, documents.length)
            await compileBladeBatch(documents, (indexed, total) => setIndexProgress(indexed, total))
        } finally {
            clearIndexProgress()
            startupCompilationRunning = false
            startupCompilationPromise = undefined
        }
    })()

    await startupCompilationPromise
}

import * as vscode from 'vscode'
import {execa} from 'execa'
import {access, mkdir, readFile, rm, stat, writeFile} from 'fs/promises'
import path from 'path'
import {getDebugMode, getPhpCommand, getPhpDocBlocks, getPhpDefaultImports, getReferenceDirectives} from '../core/config'
import {contentHash, evictOldestEntries, pathHash} from '../core/cache'
import {debugLog, debugOutputChannel} from '../core/debug'
import {BladeMarkerMap} from './mapping'
import {phpString, splitCommand} from '../text/shell'
import {getViewPhpDocBlocks} from '../blade/view-data'
import {showBusy, setIndexProgress, clearIndexProgress} from '../core/status'
import {getBladeExcludeGlob, getWorkspaceFolder} from '../core/utils'
import {
    cleanupStaleCompiledFiles as cleanupStale,
    getCompiledDir,
    getManifestEntry,
    initCompiledDir as initManifestDir,
    loadManifestOnce,
    manifestKey,
    removeManifestEntry,
    updateManifestEntries,
} from './manifest'
import {
    MAX_COMPILATION_CACHE_SIZE,
    MAX_COMPILE_FILE_SIZE,
    COMPILE_BATCH_SIZE,
} from '../core/constants'
import {
    warnIfTooLarge,
    warnCompileFailure,
    resetCompileFailureCount,
    warnPerFileCompileFailure,
    clearPerFileCompileFailure,
} from './compile-failure-tracker'

export function initCompiledDir(context: vscode.ExtensionContext): void {
    const dir = context.storageUri?.fsPath ?? context.globalStorageUri?.fsPath

    if (dir) {
        debugLog(`initCompiledDir: storage path = ${dir}`)
        initManifestDir(dir)
    }
}

export function isBladeCompleteCompiledPath(filePath: string): boolean {
    const dir = getCompiledDir()

    return dir !== undefined && filePath.startsWith(dir + path.sep)
}

const compilationRequests = new Map<string, Promise<string | undefined>>()

export function getCompiledPath(document: vscode.TextDocument, ext: string): string | undefined {
    const dir = getCompiledDir()

    if (!dir) {
        return undefined
    }

    return path.join(dir, `${pathHash(document)}.${ext}`)
}

async function saveCompiledContent(
    document: vscode.TextDocument,
    content: string,
    ext: string = 'php',
): Promise<string> {
    const filePath = getCompiledPath(document, ext)

    if (!filePath) {
        throw new Error('Blade Complete: compiled directory not initialized')
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
        throw new Error('Blade Complete: compiled directory not initialized')
    }

    const filePath = path.join(dir, `${contentHash(content)}.php`)
    await mkdir(path.dirname(filePath), {recursive: true})

    try {
        await writeFile(filePath, content, {mode: 0o600, flag: 'wx'})
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code

        if (code !== 'EEXIST') {
            throw error
        }

        // File exists - verify content matches
        try {
            const existing = await readFile(filePath, 'utf8')

            if (existing !== content) {
                await writeFile(filePath, content, {mode: 0o600})
            }
        } catch (readError) {
            const readMessage = readError instanceof Error ? readError.message : String(readError)
            debugLog(`saveCompiledProbe: could not read existing compiled file ${filePath}: ${readMessage}`)

            // If we can't read the existing file, overwrite it
            await writeFile(filePath, content, {mode: 0o600})
        }
    }

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

    evictOldestEntries(compilationRequests, MAX_COMPILATION_CACHE_SIZE)

    const request = operation()
    compilationRequests.set(filePath, request)

    return request.finally(() => {
        if (compilationRequests.get(filePath) === request) {
            compilationRequests.delete(filePath)
        }
    })
}

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
    const referenceDirectives = getReferenceDirectives(resource)
    const refPattern = referenceDirectives.length > 0
        ? `/^@(${referenceDirectives.join('|')})\\b/i`
        : '/^(?!)/'

    return [
        '$phpDocBlocks = [];',
        `\$refPattern = ${phpString(refPattern)};`,
    ].join('\n')
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

async function removeStaleCompiledFile(filePath: string, bladePath: string): Promise<void> {
    try {
        await rm(filePath, {force: true})
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(`compileBlade: failed to remove stale compiled file for ${bladePath}: ${message}`)
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
        clearPerFileCompileFailure(document.uri.fsPath)

        return filePath
    }

    await removeStaleCompiledFile(filePath, document.uri.fsPath)

    if (getDebugMode(document.uri)) {
        debugLog(`compileBlade recompiling ${document.uri.fsPath} (dirty=${document.isDirty})`)
    }

    const result = await executePhpCompile([document], workspaceRoot)
    const compiled = result.get(document.uri.toString())

    if (compiled) {
        clearPerFileCompileFailure(document.uri.fsPath)

        return compiled
    }

    warnPerFileCompileFailure(document.uri.fsPath)

    return undefined
}

interface PhpInput {
    id                : string
    path              : string
    content           : string
    version           : number
    phpDocBlocks      : string[]
    phpDefaultImports : string[]
}

function buildPhpInputs(
    documents: vscode.TextDocument[],
    viewPhpDocBlocks: Map<string, string[]>,
): PhpInput[] {
    return documents.map((doc, i) => ({
        id                : String(i),
        path              : doc.uri.fsPath,
        content           : doc.getText(),
        version           : doc.version,
        phpDocBlocks      : [...getPhpDocBlocks(doc.uri), ...(viewPhpDocBlocks.get(doc.uri.toString()) ?? [])],
        phpDefaultImports : getPhpDefaultImports(doc.uri),
    }))
}

async function statSourceFile(doc: vscode.TextDocument): Promise<{mtime: number | undefined, size: number | undefined}> {
    try {
        const sourceStat = await stat(doc.uri.fsPath)

        return {mtime: sourceStat.mtimeMs, size: sourceStat.size}
    } catch (statError) {
        const message = statError instanceof Error ? statError.message : String(statError)
        debugLog(`parseCompileOutput: failed to stat source file ${doc.uri.fsPath}: ${message}`)

        return {mtime: undefined, size: undefined}
    }
}

// Persist one compiled output item: write the file, refresh the manifest
// entry, then record the result mapping (fPath may be undefined when the
// compiled dir is not initialized, mirroring compileBlade's contract).
async function applyCompiledItem(
    item: {id: string, compiled: string},
    documents: vscode.TextDocument[],
    inputs: PhpInput[],
    cwd: string | undefined,
    manifestUpdates: Array<[string, {compiled: string, hash: string, mtime?: number, size?: number}]>,
): Promise<{uri: string, fPath: string | undefined} | undefined> {
    const index = Number(item.id)
    const doc = documents[index]
    const input = inputs[index]

    if (!doc || !input) {
        return undefined
    }

    const fPath = getCompiledPath(doc, 'php')

    if (fPath) {
        await saveCompiledContent(doc, item.compiled)
        const {mtime, size} = await statSourceFile(doc)

        manifestUpdates.push([
            cwd ? manifestKey(doc.uri.fsPath, cwd) : doc.uri.fsPath,
            {
                compiled : path.basename(fPath),
                hash     : contentHash(input.content),
                mtime,
                size,
            },
        ])
    }

    evictOldestEntries(compilationRequests, MAX_COMPILATION_CACHE_SIZE)

    return {uri: doc.uri.toString(), fPath}
}

async function parseCompileOutput(
    stdout: string,
    documents: vscode.TextDocument[],
    inputs: PhpInput[],
    cwd: string | undefined,
): Promise<Map<string, string | undefined>> {
    const results = new Map<string, string | undefined>()
    const manifestUpdates: Array<[string, {compiled: string, hash: string, mtime?: number, size?: number}]> = []

    if (stdout) {
        for (const item of JSON.parse(stdout) as {id: string, compiled: string}[]) {
            const entry = await applyCompiledItem(item, documents, inputs, cwd, manifestUpdates)

            if (entry) {
                results.set(entry.uri, entry.fPath)
            }
        }
    }

    if (manifestUpdates.length > 0) {
        await updateManifestEntries(manifestUpdates)
    }

    for (const doc of documents) {
        const uri = doc.uri.toString()

        if (!results.has(uri)) {
            results.set(uri, undefined)
        }
    }

    return results
}

function buildFailureResults(documents: vscode.TextDocument[]): Map<string, string | undefined> {
    return new Map(documents.map((doc) => [doc.uri.toString(), undefined as string | undefined]))
}

// Read once per session — the script is static, re-reading it on every
// compile batch is wasted I/O.
let compileScriptCache: string | undefined

async function getCompileScript(): Promise<string> {
    if (compileScriptCache === undefined) {
        const scriptPath = path.join(__dirname, '../scripts/blade-compile-clean.php')
        compileScriptCache = await readFile(scriptPath, 'utf8')
    }

    return compileScriptCache
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
        const phpCode = (await getCompileScript())
            .replace('<?php', getConfigPrefix(documents[0].uri))

        const viewPhpDocBlocks = await getViewPhpDocBlocks(documents)
        const [phpCommand, ...phpArgs] = splitCommand(getPhpCommand(documents[0].uri))
        const inputs = buildPhpInputs(documents, viewPhpDocBlocks)

        const {stdout, stderr} = await execa(phpCommand, [...phpArgs, '-r', phpCode], {cwd, input: JSON.stringify(inputs)})

        if (stderr && getDebugMode(documents[0].uri)) {
            debugLog(`executePhpCompile stderr: ${stderr}`)
        }

        const result = await parseCompileOutput(stdout, documents, inputs, cwd)
        resetCompileFailureCount()

        return result
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(`executePhpCompile failed: ${message}`)
        warnCompileFailure(message)

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

async function compileGroup(
    documents: vscode.TextDocument[],
    cwd: string | undefined,
    results: Map<string, string | undefined>,
    markIndexed: () => void,
): Promise<void> {
    for (let i = 0; i < documents.length; i += COMPILE_BATCH_SIZE) {
        const batch = documents.slice(i, i + COMPILE_BATCH_SIZE)
        const batchResults = await executePhpCompile(batch, cwd)

        for (const doc of batch) {
            const docUri = doc.uri.toString()
            const fPath = getCompiledPath(doc, 'php')

            results.set(docUri, batchResults.get(docUri) ?? fPath)
            markIndexed()
        }
    }
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

    for (const [cwd, group] of groupByWorkspaceRoot(needCompile)) {
        await compileGroup(group, cwd || undefined, results, markIndexed)
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
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code

        if (code !== 'ENOENT') {
            const message = error instanceof Error ? error.message : String(error)
            debugLog(`removeCompiledFile failed: ${message}`)
        }
    }

    const workspaceRoot = getWorkspaceFolder(document.uri)?.uri.fsPath
    await removeManifestEntry(workspaceRoot ? manifestKey(document.uri.fsPath, workspaceRoot) : document.uri.fsPath)
}

export {cleanupStale as cleanupStaleCompiledFiles}

let startupCompilationRunning = false
let startupCompilationPromise: Promise<void> | undefined
let startupGeneration = 0
let startupRerunRequested = false

export async function startupCompileWorkspace(): Promise<void> {
    if (startupCompilationRunning) {
        // A run is in flight (e.g. the startup scan) — the caller wiped the
        // compiled dir (indexWorkspace) or wants a fresh pass, so queue one
        // rerun instead of silently returning.
        startupRerunRequested = true

        return
    }

    const generation = ++startupGeneration
    startupCompilationRunning = true
    startupCompilationPromise = (async() => {
        const releaseStatus = showBusy('Blade: indexing workspace ...')

        try {
            const uris = await vscode.workspace.findFiles('**/*.blade.php', getBladeExcludeGlob())

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
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            debugLog(`startupCompileWorkspace failed: ${message}`)
            void vscode.window.showErrorMessage(
                `Blade Complete: workspace compilation failed. Check the "Blade Complete" output channel for details.`,
                'Open Output',
            ).then((action) => {
                if (action === 'Open Output') {
                    debugOutputChannel.show()
                }
            })
        } finally {
            clearIndexProgress()
            releaseStatus()
            startupCompilationRunning = false
            startupCompilationPromise = undefined

            if (startupRerunRequested) {
                startupRerunRequested = false
                void startupCompileWorkspace()
            }
        }
    })()

    await startupCompilationPromise
}

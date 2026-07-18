import {access, mkdir, readFile, readdir, rename, rm, stat, writeFile} from 'fs/promises'
import path from 'path'
import {contentHash} from '../core/cache'
import {debugLog} from '../core/debug'
import {showBusy} from '../core/status'
import * as vscode from 'vscode'

let compiledDir: string | undefined

export function initCompiledDir(dir: string): void {
    compiledDir = dir
}

export function getCompiledDir(): string | undefined {
    return compiledDir
}

interface ManifestEntry {
    compiled : string
    hash     : string
    mtime?   : number
    size?    : number
}

interface Manifest {
    files : Record<string, ManifestEntry>
}

const MANIFEST_NAME = 'manifest.json'

export function manifestKey(sourcePath: string, workspaceRoot: string): string {
    return path.relative(workspaceRoot, sourcePath)
}

async function loadManifest(): Promise<Manifest> {
    const dir = getCompiledDir()

    if (!dir) {
        return {files: {}}
    }

    const manifestPath = path.join(dir, MANIFEST_NAME)

    try {
        const raw = await readFile(manifestPath, 'utf8')

        return JSON.parse(raw) as Manifest
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(`loadManifest failed: ${message}`)

        if (error instanceof SyntaxError) {
            debugLog(`loadManifest: manifest.json appears corrupted, starting fresh`)
        }

        return {files: {}}
    }
}

async function saveManifest(manifest: Manifest): Promise<void> {
    const dir = getCompiledDir()

    if (!dir) {
        return
    }

    await mkdir(dir, {recursive: true})
    const manifestPath = path.join(dir, MANIFEST_NAME)
    const tempPath = `${manifestPath}.tmp`

    try {
        await writeFile(tempPath, JSON.stringify(manifest, null, 2))
        await rename(tempPath, manifestPath)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(`saveManifest atomic write failed: ${message}`)

        try {
            await rm(tempPath, {force: true})
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            debugLog(`saveManifest: temp file cleanup failed: ${message}`)
        }

        // Fallback: attempt direct write. If this also fails, propagate the
        // error so callers know the manifest was not persisted.
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    }
}

let manifestLock: Promise<void> = Promise.resolve()

function withManifestLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = manifestLock
    let release!: () => void
    manifestLock = new Promise((resolve) => {
        release = resolve
    })

    return prev.then(fn).finally(() => release())
}

export async function getManifestEntry(sourcePath: string): Promise<ManifestEntry | undefined> {
    const manifest = await loadManifest()

    return manifest.files[sourcePath]
}

// Batch variant: one load+save cycle for many entries instead of one per file.
export async function updateManifestEntries(
    entries: Array<[string, ManifestEntry]>,
): Promise<void> {
    if (entries.length === 0) {
        return
    }

    await withManifestLock(async() => {
        const manifest = await loadManifest()

        for (const [sourcePath, entry] of entries) {
            manifest.files[sourcePath] = entry
        }

        await saveManifest(manifest)
    })
}

export async function removeManifestEntry(sourcePath: string): Promise<void> {
    await withManifestLock(async() => {
        const manifest = await loadManifest()
        delete manifest.files[sourcePath]
        await saveManifest(manifest)
    })
}

export async function loadManifestOnce(): Promise<Manifest> {
    return loadManifest()
}

export interface CompiledCleanupStats {
    kept    : number
    removed : number
}

// Wipes the whole compiled dir, not just files; recreated lazily on next write
export async function removeAllCompiledFiles(): Promise<void> {
    if (compiledDir) {
        await rm(compiledDir, {recursive: true, force: true})
    }
}

const COMPILED_FILE_PATTERN = /^[0-9a-f]{32}\.php$/

function isStaleCompiledFile(file: string, manifestCompiledFiles: Set<string>): boolean {
    return !COMPILED_FILE_PATTERN.test(file) || !manifestCompiledFiles.has(file)
}

type ManifestEntryAction
    = | {action: 'keep'}
      | {action: 'remove-compiled', log?: string}
      | {action: 'drop-entry', log: string}

async function decideManifestEntryAction(
    dir: string,
    sourcePath: string,
    entry: ManifestEntry,
    workspaceRoot: string | undefined,
): Promise<ManifestEntryAction> {
    const compiledPath = path.join(dir, entry.compiled)

    try {
        await access(compiledPath)
    } catch {
        return {
            action : 'drop-entry',
            log    : `cleanupStale: compiled file missing, removing manifest entry: ${compiledPath}`,
        }
    }

    const absoluteSource = path.isAbsolute(sourcePath)
        ? sourcePath
        : workspaceRoot ? path.join(workspaceRoot, sourcePath) : sourcePath

    try {
        await access(absoluteSource)
    } catch {
        return {
            action : 'remove-compiled',
            log    : `cleanupStale: source file missing, removing compiled: ${absoluteSource}`,
        }
    }

    try {
        const sourceStat = await stat(absoluteSource)
        const sourceContent = await readFile(absoluteSource, 'utf8')

        if (entry.mtime === sourceStat.mtimeMs && entry.size === sourceStat.size) {
            return {action: 'keep'}
        }

        if (contentHash(sourceContent) !== entry.hash) {
            // historical behaviour: content-changed removal is silent, no log
            return {action: 'remove-compiled'}
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        return {
            action : 'remove-compiled',
            log    : `cleanupStale: failed to stat/read source ${absoluteSource}: ${message}; removing compiled ${compiledPath}`,
        }
    }

    return {action: 'keep'}
}

export async function cleanupStaleCompiledFiles(): Promise<CompiledCleanupStats> {
    const dir = compiledDir

    if (!dir) {
        return {kept: 0, removed: 0}
    }

    try {
        await access(dir)
    } catch {
        debugLog('cleanupStale: compiled directory not accessible, skipping')

        return {kept: 0, removed: 0}
    }

    const releaseStatus = showBusy('Blade: cleaning workspace cache ...')
    const stats = {kept: 0, removed: 0}

    try {
        const manifest = await loadManifest()
        const newManifest: Manifest = {files: {}}
        const files = await readdir(dir)

        // Track files referenced by manifest for orphan detection
        const manifestCompiledFiles = new Set(
            Object.values(manifest.files).map((entry) => entry.compiled),
        )

        for (const file of files) {
            if (file === MANIFEST_NAME) {
                continue
            }

            if (isStaleCompiledFile(file, manifestCompiledFiles)) {
                await rm(path.join(dir, file), {force: true})
                stats.removed++
            }
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

        for (const [sourcePath, entry] of Object.entries(manifest.files)) {
            const action = await decideManifestEntryAction(dir, sourcePath, entry, workspaceRoot)

            if (action.action === 'keep') {
                newManifest.files[sourcePath] = entry
                stats.kept++
                continue
            }

            if (action.action === 'drop-entry') {
                debugLog(action.log)
                stats.removed++
                continue
            }

            if (action.log) {
                debugLog(action.log)
            }

            await rm(path.join(dir, entry.compiled), {force: true})
            stats.removed++
        }

        await saveManifest(newManifest)
    } finally {
        releaseStatus()
    }

    debugLog(`indexing done: ${stats.kept} cached, ${stats.removed} cleaned`)

    return stats
}

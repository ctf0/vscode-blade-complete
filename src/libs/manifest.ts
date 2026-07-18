import {access, mkdir, readFile, readdir, rename, rm, writeFile} from 'fs/promises'
import path from 'path'
import {contentHash} from './cache'
import {debugLog} from './debug'
import {showBusy} from './status'
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
    } catch {
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
    } catch {
        // If rename fails (e.g., cross-device), fall back to direct write
        try {
            await rm(tempPath, {force: true})
        } catch {
            // Ignore cleanup errors
        }

        await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    }
}

export async function getManifestEntry(sourcePath: string): Promise<ManifestEntry | undefined> {
    const manifest = await loadManifest()

    return manifest.files[sourcePath]
}

export async function updateManifestEntry(sourcePath: string, compiled: string, hash: string): Promise<void> {
    const manifest = await loadManifest()

    manifest.files[sourcePath] = {compiled, hash}
    await saveManifest(manifest)
}

export async function removeManifestEntry(sourcePath: string): Promise<void> {
    const manifest = await loadManifest()

    delete manifest.files[sourcePath]
    await saveManifest(manifest)
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

export async function cleanupStaleCompiledFiles(): Promise<CompiledCleanupStats> {
    const dir = compiledDir

    if (!dir) {
        return {kept: 0, removed: 0}
    }

    try {
        await access(dir)
    } catch {
        return {kept: 0, removed: 0}
    }

    const releaseStatus = showBusy('Blade: indexing workspace ...')
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

            const filePath = path.join(dir, file)

            if (!/^[0-9a-f]{32}\.php$/.test(file)) {
                await rm(filePath, {force: true})
                stats.removed++
                continue
            }

            // Remove orphaned compiled files not in manifest
            if (!manifestCompiledFiles.has(file)) {
                await rm(filePath, {force: true})
                stats.removed++
                continue
            }
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

        for (const [sourcePath, entry] of Object.entries(manifest.files)) {
            const compiledPath = path.join(dir, entry.compiled)

            try {
                await access(compiledPath)
            } catch {
                stats.removed++
                continue
            }

            const absoluteSource = path.isAbsolute(sourcePath)
                ? sourcePath
                : workspaceRoot ? path.join(workspaceRoot, sourcePath) : sourcePath

            try {
                await access(absoluteSource)
            } catch {
                await rm(compiledPath, {force: true})
                stats.removed++
                continue
            }

            try {
                const sourceContent = await readFile(absoluteSource, 'utf8')

                if (contentHash(sourceContent) !== entry.hash) {
                    await rm(compiledPath, {force: true})
                    stats.removed++
                    continue
                }
            } catch {
                await rm(compiledPath, {force: true})
                stats.removed++
                continue
            }

            newManifest.files[sourcePath] = entry
            stats.kept++
        }

        await saveManifest(newManifest)
    } finally {
        releaseStatus()
    }

    debugLog(`indexing done: ${stats.kept} cached, ${stats.removed} cleaned`)

    return stats
}

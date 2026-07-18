import {createHash} from 'crypto'
import * as vscode from 'vscode'
import {MAX_RESULTS_CACHE_SIZE} from './constants'

export function pathHash(document: vscode.TextDocument): string {
    return createHash('md5').update(document.uri.fsPath).digest('hex')
}

export function getCachedResult<T>(document: vscode.TextDocument, namespace?: string): T | undefined {
    const key = namespace ? `${namespace}:${pathHash(document)}` : pathHash(document)

    return resultsCache.get(key) as T | undefined
}

export function contentHash(content: string): string {
    return createHash('md5').update(content).digest('hex')
}

const resultsCache = new Map<string, unknown>()
const pendingCache = new Map<string, Promise<unknown>>()
const latestRequests = new Map<string,() => void>()

export function evictOldestEntries<T>(
    cache: Map<string, T>,
    maxSize: number,
    targetRatio = 0.75,
): void {
    if (cache.size <= maxSize) {
        return
    }

    const targetSize = Math.floor(maxSize * targetRatio)
    const entriesToRemove = cache.size - targetSize

    for (let i = 0; i < entriesToRemove; i++) {
        const oldest = cache.keys().next().value

        if (oldest !== undefined) {
            cache.delete(oldest)
        }
    }
}

export function getLatestResultsFor<T>(
    document: vscode.TextDocument,
    fetchResults: (isCurrent: () => boolean) => Promise<T | undefined>,
): Promise<T | undefined> {
    const documentPath = pathHash(document)

    latestRequests.get(documentPath)?.()
    latestRequests.delete(documentPath)

    let cancelled = false

    const cancel = () => {
        cancelled = true
    }

    latestRequests.set(documentPath, cancel)

    return fetchResults(() => !cancelled).finally(() => {
        if (latestRequests.get(documentPath) === cancel) {
            latestRequests.delete(documentPath)
        }
    })
}

export function shiftDocumentCache(
    document: vscode.TextDocument,
    change: vscode.TextDocumentContentChangeEvent,
): boolean {
    const hash = pathHash(document)
    const editLine = change.range.end.line
    const lineDelta = change.text.split('\n').length - 1 - (change.range.end.line - change.range.start.line)

    if (lineDelta === 0) {
        return false
    }

    const shiftRange = (range: vscode.Range): vscode.Range => {
        if (range.end.line < editLine) {
            return range
        }

        return new vscode.Range(
            new vscode.Position(range.start.line + lineDelta, range.start.character),
            new vscode.Position(range.end.line + lineDelta, range.end.character),
        )
    }

    const shiftSymbol = (symbol: vscode.DocumentSymbol): vscode.DocumentSymbol => {
        symbol.range = shiftRange(symbol.range)
        symbol.selectionRange = shiftRange(symbol.selectionRange)
        symbol.children = symbol.children.map(shiftSymbol)

        return symbol
    }

    const shiftLensArguments = (lens: vscode.CodeLens): void => {
        const args = lens.command?.arguments

        if (!Array.isArray(args) || args.length < 3) {
            return
        }

        const [, anchor, locations] = args

        if (!(anchor instanceof vscode.Position) || !Array.isArray(locations)) {
            return
        }

        const docUri = document.uri.toString()

        args[1] = shiftRange(new vscode.Range(anchor, anchor)).start

        args[2] = locations.map((location) =>
            location instanceof vscode.Location && location.uri.toString() === docUri
                ? new vscode.Location(location.uri, shiftRange(location.range))
                : location,
        )
    }

    const lenses = resultsCache.get(`lenses:${hash}`) as vscode.CodeLens[] | undefined

    if (lenses) {
        for (const lens of lenses) {
            lens.range = shiftRange(lens.range)
            shiftLensArguments(lens)
        }
    }

    const symbols = resultsCache.get(`symbols:${hash}`) as vscode.DocumentSymbol[] | undefined

    if (symbols) {
        for (const symbol of symbols) {
            shiftSymbol(symbol)
        }
    }

    return true
}

export function clearDocumentCache(document: vscode.TextDocument): void {
    const hash = pathHash(document)
    const keys = [`symbols:${hash}`, `lenses:${hash}`, hash]

    latestRequests.get(hash)?.()
    latestRequests.delete(hash)

    for (const key of keys) {
        resultsCache.delete(key)
        pendingCache.delete(key)
    }
}

export function getOrCacheResultsFor<T>(
    document: vscode.TextDocument,
    fetchResults: () => Promise<T>,
    namespace?: string,
): Promise<T> {
    const key = namespace ? `${namespace}:${pathHash(document)}` : pathHash(document)
    const cached = resultsCache.get(key)

    if (cached !== undefined) {
        resultsCache.delete(key)
        resultsCache.set(key, cached)

        return Promise.resolve(cached as T)
    }

    const pending = pendingCache.get(key)

    if (pending) {
        return pending as Promise<T>
    }

    const promise: Promise<T> = fetchResults()
        .then((value) => {
            if (pendingCache.get(key) === promise) {
                resultsCache.set(key, value)
                evictOldestEntries(resultsCache, MAX_RESULTS_CACHE_SIZE)
                pendingCache.delete(key)
            }

            return value
        }).catch((error) => {
            if (pendingCache.get(key) === promise) {
                pendingCache.delete(key)
            }

            throw error
        })

    pendingCache.set(key, promise)
    evictOldestEntries(pendingCache, MAX_RESULTS_CACHE_SIZE)

    return promise
}

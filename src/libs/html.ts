import * as vscode from 'vscode'
import * as cache from './cache'
import {compileHtml} from './compiled'
import {waitForProvider, flattenDocumentSymbols, isDocumentSymbol} from './symbols'

const htmlSymbolsCache = new Map<string, vscode.DocumentSymbol[]>()
const pendingHtmlFetches = new Map<string, Promise<void>>()

export const onHtmlSymbolsReady = new vscode.EventEmitter<vscode.TextDocument>()

function normalizeSymbols(
    symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[],
): vscode.DocumentSymbol[] {
    if (symbols.length === 0) {
        return []
    }

    if (isDocumentSymbol(symbols[0])) {
        return flattenDocumentSymbols(symbols as vscode.DocumentSymbol[])
    }

    return (symbols as vscode.SymbolInformation[]).map((symbol) =>
        new vscode.DocumentSymbol(
            symbol.name,
            symbol.containerName ?? '',
            symbol.kind,
            symbol.location.range,
            symbol.location.range,
        ),
    )
}

async function getHtmlSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    const htmlPath = await compileHtml(document)
    const htmlResults = htmlPath
        ? await waitForProvider(
            () => vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
                'vscode.executeDocumentSymbolProvider',
                vscode.Uri.file(htmlPath),
            ),
            (symbols) => true,
            'HTML symbol provider',
            5,
        )
        : undefined

    return normalizeSymbols(htmlResults ?? [])
}

function ensureHtmlSymbols(document: vscode.TextDocument, key: string): void {
    if (htmlSymbolsCache.has(key) || pendingHtmlFetches.has(key)) {
        return
    }

    const fetch = getHtmlSymbols(document).then((html) => {
        htmlSymbolsCache.set(key, html)

        if (html.length > 0) {
            onHtmlSymbolsReady.fire(document)
        }
    }).catch(() => {
        htmlSymbolsCache.set(key, [])
    }).finally(() => {
        pendingHtmlFetches.delete(key)
    })

    pendingHtmlFetches.set(key, fetch)
}

export function getCachedHtmlSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const key = cache.pathHash(document)
    ensureHtmlSymbols(document, key)

    return htmlSymbolsCache.get(key) ?? []
}

export function clearHtmlSymbolsCache(document: vscode.TextDocument) {
    const key = cache.pathHash(document)
    htmlSymbolsCache.delete(key)
    pendingHtmlFetches.delete(key)
}

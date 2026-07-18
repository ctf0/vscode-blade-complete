import * as vscode from 'vscode'
import {BladeMarkerMap} from './mapping'
import {debugLog} from './debug'

const retryTimeout = 2000
const retryMax = 10

export const referenceableKinds = new Set([
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Property,
    vscode.SymbolKind.Field,
    vscode.SymbolKind.Constant,
    vscode.SymbolKind.Enum,
    vscode.SymbolKind.EnumMember,
])

export async function waitForProvider<T>(
    request: () => Thenable<T | undefined>,
    isReady: (result: T) => boolean,
    name: string,
    maxRetry: number = retryMax,
): Promise<T | undefined> {
    for (let iteration = 0; iteration <= maxRetry; iteration++) {
        try {
            const result = await request()

            if (result !== undefined && isReady(result)) {
                debugLog(`${name} ready`)

                return result
            }
        } catch {
            // The provider is still starting.
        }

        if (iteration < maxRetry) {
            await new Promise((resolve) => setTimeout(resolve, retryTimeout))
            debugLog(`${name} retry : ${iteration + 1}`)
        }
    }
}

export function isDocumentSymbol(
    symbol: vscode.SymbolInformation | vscode.DocumentSymbol,
): symbol is vscode.DocumentSymbol {
    return 'children' in symbol
}

export function flattenDocumentSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
    return symbols.flatMap(({children, ...symbol}) => [
        {...symbol, children: []},
        ...flattenDocumentSymbols(children),
    ])
}

export function mapPosition(
    position: vscode.Position,
    markerMap?: BladeMarkerMap,
): vscode.Position {
    return markerMap?.toGeneratedPosition(position) ?? position
}

export function dedupe(symbols: vscode.DocumentSymbol[], seen = new Set<string>()): vscode.DocumentSymbol[] {
    return symbols.filter((sym) => {
        if (sym.children.length > 0) {
            sym.children = dedupe(sym.children, seen)
        }

        const key = `${sym.name}\x00${sym.kind}\x00${sym.range.start.line}:${sym.range.start.character}`

        if (seen.has(key)) {
            return false
        }

        seen.add(key)

        return true
    })
}

export function byUniqueNameAndLine() {
    const seen = new Set<string>()

    return (s: vscode.DocumentSymbol): boolean => {
        const key = `${s.name}\x00${s.range.start.line}`

        if (seen.has(key)) {
            return false
        }

        seen.add(key)

        return true
    }
}

function locationKey(location: vscode.Location): string {
    return [
        location.uri.toString(),
        location.range.start.line,
        location.range.start.character,
        location.range.end.line,
        location.range.end.character,
    ].join(':')
}

export function dedupeLocations(locations: vscode.Location[]): vscode.Location[] {
    const seen = new Set<string>()

    return locations.filter((location) => {
        const key = locationKey(location)

        if (seen.has(key)) {
            return false
        }

        seen.add(key)

        return true
    })
}

export function dedupeLinks(links: vscode.DocumentLink[]): vscode.DocumentLink[] {
    const seen = new Set<string>()

    return links.filter((link) => {
        const key = [
            link.target?.toString() ?? '',
            link.range.start.line,
            link.range.start.character,
            link.range.end.line,
            link.range.end.character,
        ].join(':')

        if (seen.has(key)) {
            return false
        }

        seen.add(key)

        return true
    })
}

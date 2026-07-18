import * as vscode from 'vscode'
import {debugLog} from '../libs/debug'
import {byUniqueNameAndLine, dedupeLocations, referenceableKinds} from '../libs/symbols'
import {clearBladeReferenceCache, getBladeReferencesForPhp, getReferenceExcludes, prepareBladeReferencesForPhp} from '../libs/rename'
import type {BladeReference} from '../libs/rename'

let nextCodeLensRequest = 0

function flattenSymbols(
    symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[],
    result: vscode.DocumentSymbol[] = [],
): vscode.DocumentSymbol[] {
    for (const symbol of symbols) {
        if ('selectionRange' in symbol) {
            result.push(symbol)
            flattenSymbols(symbol.children, result)
        } else {
            result.push(new vscode.DocumentSymbol(
                symbol.name,
                '',
                symbol.kind,
                symbol.location.range,
                symbol.location.range,
            ))
        }
    }

    return result
}

function lensKey(uri: vscode.Uri, range: vscode.Range): string {
    return [
        uri.toString(),
        range.start.line,
        range.start.character,
        range.end.line,
        range.end.character,
    ].join(':')
}

// `null` marks a symbol whose reference count resolved to zero: it is excluded
// from every subsequent `provideCodeLenses` so the lens is never created in the
// first place (a lens without a command would briefly render as "no command").
const commands = new Map<string, vscode.Command | null>()
const pendingCommands = new Map<string, Promise<vscode.Command | undefined>>()

async function resolveReferencesCommand(
    document: vscode.TextDocument,
    range: vscode.Range,
    excludes: string[],
): Promise<vscode.Command | undefined> {
    const bladeDocument = vscode.workspace.textDocuments.find((doc) =>
        doc.uri.toString() === document.uri.toString(),
    )

    const [queriedReferences, bladeReferences] = await Promise.all([
        vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            document.uri,
            range.start,
        ).then((references) => references ?? []),
        bladeDocument
            ? getBladeReferencesForPhp(bladeDocument, range.start, excludes)
                .then((references) => references ?? [])
                .catch(() => [] as BladeReference[])
            : Promise.resolve([] as BladeReference[]),
    ])

    const queried = dedupeLocations(queriedReferences).filter((reference) =>
        reference.uri.toString() !== document.uri.toString()
        || !reference.range.isEqual(range),
    )
    const scanned = bladeReferences.filter((reference) => !reference.range.isEqual(range))
    const filtered = dedupeLocations([
        ...queried,
        ...scanned.map((reference) => new vscode.Location(reference.document.uri, reference.range)),
    ])

    if (filtered.length === 0) {
        return undefined
    }

    return {
        title     : `${filtered.length} reference${filtered.length === 1 ? '' : 's'}`,
        command   : 'editor.action.showReferences',
        arguments : [document.uri, range.start, filtered],
    }
}

async function getCommandFor(
    document: vscode.TextDocument,
    range: vscode.Range,
): Promise<vscode.Command | undefined> {
    const key = lensKey(document.uri, range)
    const cachedCommand = commands.get(key)

    if (cachedCommand !== undefined) {
        return cachedCommand ?? undefined
    }

    let pending = pendingCommands.get(key)

    if (!pending) {
        pending = resolveReferencesCommand(document, range, getReferenceExcludes(document.uri))
            .then((command) => {
                commands.set(key, command ?? null)

                return command
            })
        pendingCommands.set(key, pending)
    }

    const command = await pending
    pendingCommands.delete(key)

    return command
}

export function registerPhpCodeLensProvider(): vscode.Disposable {
    const onDidChangeCodeLenses = new vscode.EventEmitter<void>()
    const lensDocuments = new WeakMap<vscode.CodeLens, vscode.Uri>()

    const provider: vscode.CodeLensProvider = {
        onDidChangeCodeLenses : onDidChangeCodeLenses.event,
        provideCodeLenses     : async(document, token) => {
            const requestId = ++nextCodeLensRequest

            debugLog(`PHP code lens start #${requestId}: ${document.uri.fsPath}`)

            if (token.isCancellationRequested) {
                return undefined
            }

            const symbols = await vscode.commands.executeCommand<
                vscode.DocumentSymbol[] | vscode.SymbolInformation[]
            >(
                'vscode.executeDocumentSymbolProvider',
                document.uri,
            ) ?? []
            const targetSymbols = flattenSymbols(symbols)
                .filter((symbol) => referenceableKinds.has(symbol.kind))
                .filter(byUniqueNameAndLine())
                .filter((symbol) => commands.get(lensKey(document.uri, symbol.selectionRange)) !== null)

            // Warm the blade reference cache WITHOUT the lens cancellation token:
            // the scan must run to completion so `getCommandFor` below can reuse
            // the batch instead of scanning again.
            void prepareBladeReferencesForPhp(
                document,
                targetSymbols.map((symbol) => ({
                    position : symbol.selectionRange.start,
                    kind     : symbol.kind,
                })),
                getReferenceExcludes(document.uri),
            ).catch((error) => {
                debugLog(`PHP code lens Blade batch failed: ${error instanceof Error ? error.message : String(error)}`)
            })

            // Resolve the reference count for every candidate BEFORE creating any
            // lens so symbols with zero references never reach the editor.
            const resolved = await Promise.all(targetSymbols.map(async(symbol) => {
                const command = await getCommandFor(document, symbol.selectionRange)

                return command ? {symbol, command} : undefined
            }))

            if (token.isCancellationRequested) {
                return undefined
            }

            const lenses = resolved
                .filter((entry): entry is {symbol: vscode.DocumentSymbol, command: vscode.Command} => Boolean(entry))
                .map(({symbol, command}) => {
                    const lens = new vscode.CodeLens(symbol.selectionRange, command)
                    lensDocuments.set(lens, document.uri)

                    return lens
                })

            debugLog(`PHP code lens complete #${requestId}: all=${symbols.length}, targets=${resolved.filter(Boolean).length}, shown=${lenses.length}`)

            return lenses
        },
        resolveCodeLens : async(lens, token) => {
            if (token.isCancellationRequested) {
                return lens
            }

            const documentUri = lensDocuments.get(lens)

            if (!documentUri) {
                return lens
            }

            const cachedCommand = commands.get(lensKey(documentUri, lens.range))

            if (cachedCommand !== undefined) {
                if (cachedCommand) {
                    lens.command = cachedCommand
                } else {
                    // The count dropped to zero after this lens was rendered,
                    // ask for a refresh so it disappears.
                    onDidChangeCodeLenses.fire()
                }

                return lens
            }

            const document = vscode.workspace.textDocuments.find((doc) =>
                doc.uri.toString() === documentUri.toString(),
            )

            if (document) {
                const command = await getCommandFor(document, lens.range)

                if (command) {
                    lens.command = command
                }
            }

            return lens
        },
    }

    const registration = vscode.languages.registerCodeLensProvider('php', provider)
    const documentChanges = vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.languageId === 'php' || document.languageId === 'blade') {
            clearBladeReferenceCache()
            commands.clear()
            pendingCommands.clear()
            onDidChangeCodeLenses.fire()
        }
    })

    return {
        dispose : () => {
            registration?.dispose()
            documentChanges.dispose()
            onDidChangeCodeLenses.dispose()
        },
    }
}

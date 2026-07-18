import * as vscode from 'vscode'
import {getCompiledContext, isBladeCompleteCompiledPath} from '../compiler/compiled'
import {debugLog} from '../core/debug'
import {isBladeUri} from '../core/utils'
import {mapUri} from '../compiler/result-mapper'
import {dedupeLocations} from '../blade/symbols'
import {getBladeReferencesForPhp, getReferenceExcludes, isExcludedLocation} from '../rename/rename'
import type {BladeReference} from '../rename/rename'

/**
 * ReferenceResolver — fuses the compiled-query + Blade-scan + filter
 * pipeline into one interface. Three call sites previously duplicated
 * this logic: intelephense.ts:getReferencesFor, intelephense.ts:buildCodeLens,
 * and php-codelens.ts:resolveReferencesCommand.
 */

export async function resolveReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
): Promise<vscode.Location[]> {
    const excludes = getReferenceExcludes(document.uri)

    const [queried, bladeScan] = await Promise.all([
        queryCompiledReferences(document, position),
        getBladeReferencesForPhp(document, position, excludes, token).catch((error) => {
            debugLog(`resolveReferences blade scan failed: ${error instanceof Error ? error.message : String(error)}`)

            return [] as BladeReference[]
        }),
    ])

    return dedupeLocations([
        ...queried
            .filter((location) => !isExcludedLocation(location.uri, excludes))
            .filter((location) =>
                location.uri.scheme !== 'file' || !isBladeCompleteCompiledPath(location.uri.fsPath),
            )
            .filter((location) => !isBladeUri(location.uri)),
        ...(bladeScan ?? []).map((reference) => new vscode.Location(reference.document.uri, reference.range)),
    ])
}

async function queryCompiledReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
): Promise<vscode.Location[]> {
    const context = await getCompiledContext(document)

    if (!context) {
        return []
    }

    const mappedPosition = context.markerMap.toGeneratedPosition(position)

    if (position && !mappedPosition) {
        return []
    }

    const results = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        context.uri,
        mappedPosition,
    ) ?? []

    return mapUri(results, context.uri, document, context.markerMap, false, position)
}

export async function resolveReferencesForSymbol(
    document: vscode.TextDocument,
    range: vscode.Range,
    excludes: string[],
): Promise<vscode.Location[]> {
    const [queriedReferences, bladeReferences] = await Promise.all([
        vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            document.uri,
            range.start,
        ).then((references) => references ?? []),
        getBladeReferencesForPhp(document, range.start, excludes)
            .then((references) => references ?? [])
            .catch(() => [] as BladeReference[]),
    ])

    // Intelephense indexes every compiled doc this extension opens; without this
    // filter the PHP code lens counts compiled-file locations (mirrors resolveReferences).
    const queried = dedupeLocations(queriedReferences)
        .filter((location) => !isExcludedLocation(location.uri, excludes))
        .filter((location) =>
            location.uri.scheme !== 'file' || !isBladeCompleteCompiledPath(location.uri.fsPath),
        )
        .filter((location) => !isBladeUri(location.uri))
    const scanned = bladeReferences

    return dedupeLocations([
        ...queried,
        ...scanned.map((reference) => new vscode.Location(reference.document.uri, reference.range)),
    ])
}

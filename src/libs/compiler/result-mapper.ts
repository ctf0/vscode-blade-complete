import * as vscode from 'vscode'
import {BladeMarkerMap} from './mapping'
import {isGeneratedNoise} from './generated-noise'
import {comparePositions} from '../text/position-utils'

function isCompiledUri(uri: vscode.Uri | undefined, compiledUri: vscode.Uri): boolean {
    return uri?.toString() === compiledUri.toString()
}

function mapRange(range: vscode.Range | undefined, markerMap: BladeMarkerMap): vscode.Range | undefined {
    return range ? markerMap.toSourceRange(range) : undefined
}

function isRange(value: any): boolean {
    return !!value?.start && !!value?.end
}

function mapCompletionRange(range: any, markerMap: BladeMarkerMap): any {
    if (isRange(range)) {
        return mapRange(range, markerMap)
    }

    if (range?.inserting && range?.replacing) {
        const inserting = mapRange(range.inserting, markerMap)
        const replacing = mapRange(range.replacing, markerMap)

        return inserting && replacing ? {inserting, replacing} : undefined
    }
}

function mapCompletionEdit(edit: any, markerMap: BladeMarkerMap): any {
    if (edit?.range) {
        const range = mapCompletionRange(edit.range, markerMap)

        return range ? {...edit, range} : undefined
    }

    if (edit?.insert && edit?.replace) {
        const insert = mapRange(edit.insert, markerMap)
        const replace = mapRange(edit.replace, markerMap)

        return insert && replace ? {...edit, insert, replace} : undefined
    }

    return edit
}

function mapCompletionItem(result: any, markerMap: BladeMarkerMap): any | null | undefined {
    const hasStructuredRange = result.range && !isRange(result.range)

    if (!hasStructuredRange && !result.textEdit) {
        return undefined
    }

    const mapped = {...result}

    if (result.range) {
        const range = mapCompletionRange(result.range, markerMap)

        if (!range) {
            return null
        }

        mapped.range = range
    }

    if (result.textEdit) {
        const textEdit = mapCompletionEdit(result.textEdit, markerMap)

        if (!textEdit) {
            return null
        }

        mapped.textEdit = textEdit
    }

    return mapped
}

function hasFileContext(result: any): boolean {
    return !!result.uri || !!result.targetUri || !!result.location
}

function mapCompiledUriResult(result: any, markerMap: BladeMarkerMap, document: vscode.TextDocument, exactOnly: boolean): any[] {
    if (exactOnly && result.range && !markerMap.isExactRange(result.range)) {
        return []
    }

    const range = mapRange(result.range, markerMap)

    return result.range && !range
        ? []
        : [{...result, uri: document.uri, ...(range ? {range} : {})}]
}

function mapTargetUriResult(result: any, markerMap: BladeMarkerMap, document: vscode.TextDocument): any[] {
    const targetRange = mapRange(result.targetRange, markerMap)
    const targetSelectionRange = mapRange(result.targetSelectionRange, markerMap) ?? targetRange
    const originSelectionRange = mapRange(result.originSelectionRange, markerMap)

    if (result.targetRange && !targetRange) {
        return []
    }

    return [{
        ...result,
        targetUri : document.uri,
        ...(targetRange ? {targetRange} : {}),
        ...(targetSelectionRange ? {targetSelectionRange} : {}),
        ...(originSelectionRange ? {originSelectionRange} : {}),
    }]
}

function mapLocationResult(result: any, markerMap: BladeMarkerMap, document: vscode.TextDocument): any[] {
    const range = mapRange(result.location.range, markerMap)

    return result.location.range && !range
        ? []
        : [{
            ...result,
            location : {
                ...result.location,
                uri : document.uri,
                ...(range ? {range} : {}),
            },
        }]
}

function mapOriginSelectionResult(result: any, markerMap: BladeMarkerMap): any[] {
    const originSelectionRange = mapRange(result.originSelectionRange, markerMap)

    return originSelectionRange ? [{...result, originSelectionRange}] : []
}

function mapRangeOnlyResult(result: any, markerMap: BladeMarkerMap, exactOnly: boolean, sourcePosition: vscode.Position | undefined, document: vscode.TextDocument): any[] {
    if (exactOnly && !markerMap.isExactRange(result.range)) {
        return []
    }

    const mappedRange = mapRange(result.range, markerMap)
    const sourceRange = sourcePosition
        ? document.getWordRangeAtPosition(sourcePosition, /[@$]?[A-Za-z_]\w*/)
        : undefined
    const range = sourceRange && mappedRange && containsRange(mappedRange, sourceRange)
        ? sourceRange
        : mappedRange ?? sourceRange

    return range ? [{...result, range}] : []
}

function containsRange(outer: vscode.Range, inner: vscode.Range): boolean {
    return comparePositions(outer.start, inner.start) <= 0
      && comparePositions(outer.end, inner.end) >= 0
}

function mapNonCompletionResult(
    result: any,
    markerMap: BladeMarkerMap,
    compiledUri: vscode.Uri,
    document: vscode.TextDocument,
    exactOnly: boolean,
    sourcePosition: vscode.Position | undefined,
): any[] {
    if (isCompiledUri(result.uri, compiledUri)) {
        return mapCompiledUriResult(result, markerMap, document, exactOnly)
    }

    if (isCompiledUri(result.targetUri, compiledUri)) {
        return mapTargetUriResult(result, markerMap, document)
    }

    if (result.location && isCompiledUri(result.location.uri, compiledUri)) {
        return mapLocationResult(result, markerMap, document)
    }

    if (result.targetUri && result.originSelectionRange) {
        return mapOriginSelectionResult(result, markerMap)
    }

    if (result.range && !hasFileContext(result)) {
        return mapRangeOnlyResult(result, markerMap, exactOnly, sourcePosition, document)
    }

    return [result]
}

export function mapUri<T>(
    results: T[],
    compiledUri: vscode.Uri,
    document: vscode.TextDocument,
    markerMap: BladeMarkerMap,
    exactOnly = false,
    sourcePosition?: vscode.Position,
): T[] {
    const source = document.getText()

    return results.flatMap((result: any) => {
        if (!result || isGeneratedNoise(result.name, source)) {
            return []
        }

        const completion = mapCompletionItem(result, markerMap)

        if (completion) {
            return [completion]
        }

        if (completion === null) {
            return []
        }

        return mapNonCompletionResult(result, markerMap, compiledUri, document, exactOnly, sourcePosition)
    }) as T[]
}

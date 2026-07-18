import * as vscode from 'vscode'

const generatedNoise = new Set([
    'renderComponent', 'startComponent', 'endComponent', 'withAttributes',
    'shouldRender', 'resolveView', 'getCurrentComponentData',
    'sanitizeComponentAttribute',
])

export interface MarkerSegment {
    kind           : string
    generatedStart : number
    generatedEnd   : number
    sourceRange    : vscode.Range
}

export function positionAt(text: string, offset: number): vscode.Position {
    const before = text.slice(0, Math.max(0, Math.min(offset, text.length)))
    const line = before.lastIndexOf('\n')

    return new vscode.Position(
        before.split('\n').length - 1,
        line === -1 ? before.length : before.length - line - 1,
    )
}

export function offsetAt(text: string, position: vscode.Position): number {
    const lines = text.split('\n')
    const line = Math.max(0, Math.min(position.line, lines.length - 1))

    return lines.slice(0, line).reduce((offset, value) => offset + value.length + 1, 0)
      + Math.min(position.character, lines[line].length)
}

function contains(range: vscode.Range, position: vscode.Position): boolean {
    return range.contains(position)
      || (position.line === range.end.line && position.character === range.end.character)
}

function markerPriority(kind: string): number {
    return kind === 'expression' || kind === 'directive' || kind === 'php' ? 0 : 1
}

function isExactMarker(segment: MarkerSegment): boolean {
    return markerPriority(segment.kind) === 0
}

function comparePositions(left: vscode.Position, right: vscode.Position): number {
    return left.line - right.line || left.character - right.character
}

function containsRange(outer: vscode.Range, inner: vscode.Range): boolean {
    return comparePositions(outer.start, inner.start) <= 0
      && comparePositions(outer.end, inner.end) >= 0
}

export class BladeMarkerMap {
    readonly segments              : MarkerSegment[]
    private readonly generatedText : string

    constructor(generatedText: string) {
        this.generatedText = generatedText
        this.segments = []

        const pending = new Map<string, {kind: string, start: number, end: number, range: vscode.Range}[]>()
        const markerPattern = /(?:<!--|\/\*)\s*blade-parser:([\w-]+):(start|end):(\d+):(\d+):(\d+):(\d+)\s*(?:-->|\*\/)/g
        let match: RegExpExecArray | null

        while ((match = markerPattern.exec(generatedText)) !== null) {
            const [, kind, phase, startLine, startCharacter, endLine, endCharacter] = match
            const range = new vscode.Range(
                Number(startLine),
                Number(startCharacter),
                Number(endLine),
                Number(endCharacter),
            )
            const key = `${kind}:${startLine}:${startCharacter}:${endLine}:${endCharacter}`
            const entries = pending.get(key) ?? []

            if (phase === 'start') {
                entries.push({kind, start: match.index, end: markerPattern.lastIndex, range})
            } else {
                const start = entries.pop()

                if (start) {
                    this.segments.push({
                        kind,
                        generatedStart : start.end,
                        generatedEnd   : match.index,
                        sourceRange    : start.range,
                    })
                }
            }

            if (entries.length > 0) {
                pending.set(key, entries)
            } else {
                pending.delete(key)
            }
        }

        this.segments.sort((left, right) =>
            left.generatedStart - right.generatedStart
            || markerPriority(left.kind) - markerPriority(right.kind)
            || (left.generatedEnd - left.generatedStart) - (right.generatedEnd - right.generatedStart),
        )
    }

    private segmentAt(offset: number): MarkerSegment | undefined {
        return this.segments
            .filter((segment) => offset >= segment.generatedStart && offset <= segment.generatedEnd)
            .sort((left, right) =>
                markerPriority(left.kind) - markerPriority(right.kind)
                || (left.generatedEnd - left.generatedStart) - (right.generatedEnd - right.generatedStart),
            )[0]
    }

    private segmentsAtRange(range: vscode.Range): (MarkerSegment | undefined)[] {
        const startOffset = offsetAt(this.generatedText, range.start)
        const endOffset = offsetAt(this.generatedText, range.end)

        return [
            this.segmentAt(startOffset),
            this.segmentAt(Math.max(endOffset - 1, startOffset)),
        ]
    }

    private sourceSegmentAt(position: vscode.Position): MarkerSegment | undefined {
        return this.segments
            .filter((segment) => contains(segment.sourceRange, position))
            .sort((left, right) =>
                markerPriority(left.kind) - markerPriority(right.kind)
                || (left.sourceRange.end.line - left.sourceRange.start.line) - (right.sourceRange.end.line - right.sourceRange.start.line),
            )[0]
    }

    private mapExactPosition(offset: number, segment: MarkerSegment): vscode.Position {
        if (offset <= segment.generatedStart) {
            return segment.sourceRange.start
        }

        if (offset >= segment.generatedEnd) {
            return segment.sourceRange.end
        }

        const generatedStart = positionAt(this.generatedText, segment.generatedStart)
        const generated = positionAt(this.generatedText, offset)
        const lineDelta = generated.line - generatedStart.line
        const character = lineDelta === 0
            ? segment.sourceRange.start.character + generated.character - generatedStart.character
            : generated.character
        const mapped = new vscode.Position(segment.sourceRange.start.line + lineDelta, character)

        if (comparePositions(mapped, segment.sourceRange.start) < 0) {
            return segment.sourceRange.start
        }

        if (comparePositions(mapped, segment.sourceRange.end) > 0) {
            return segment.sourceRange.end
        }

        return mapped
    }

    private mapSourcePosition(position: vscode.Position, segment: MarkerSegment): vscode.Position {
        if (segment.kind === 'directive' || segment.kind === 'cursor') {
            const generated = this.generatedText.slice(segment.generatedStart, segment.generatedEnd)
            const importMatch = generated.match(/\buse\s*(?:\(\s*)?(?:(?:function|const)\s+)?(['"]?)(\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*)\1/)

            if (generated.includes('<?php') && importMatch?.index !== undefined) {
                return positionAt(
                    this.generatedText,
                    segment.generatedStart + importMatch.index + importMatch[0].lastIndexOf(importMatch[2]),
                )
            }

            const callOffset = generated.search(/\b[A-Za-z_]\w*\s*\(/)

            if (generated.includes('<?php') && callOffset >= 0) {
                return positionAt(this.generatedText, segment.generatedStart + callOffset)
            }
        }

        if (comparePositions(position, segment.sourceRange.start) <= 0) {
            return positionAt(this.generatedText, segment.generatedStart)
        }

        if (comparePositions(position, segment.sourceRange.end) >= 0) {
            return positionAt(this.generatedText, segment.generatedEnd)
        }

        const generatedStart = positionAt(this.generatedText, segment.generatedStart)
        const lineDelta = position.line - segment.sourceRange.start.line
        const character = lineDelta === 0
            ? generatedStart.character + position.character - segment.sourceRange.start.character
            : position.character

        return new vscode.Position(generatedStart.line + lineDelta, character)
    }

    isExactRange(range: vscode.Range): boolean {
        const [start, end] = this.segmentsAtRange(range)

        return !!start && start === end && isExactMarker(start)
    }

    toGeneratedPosition(position: vscode.Position): vscode.Position | undefined {
        const segment = this.sourceSegmentAt(position)

        if (!segment) {
            return undefined
        }

        return isExactMarker(segment) || segment.kind === 'cursor'
            ? this.mapSourcePosition(position, segment)
            : positionAt(this.generatedText, segment.generatedStart)
    }

    toSourceRange(range: vscode.Range): vscode.Range | undefined {
        const [start, end] = this.segmentsAtRange(range)

        if (!start || !end) {
            return start?.sourceRange ?? end?.sourceRange
        }

        if (start === end) {
            return isExactMarker(start)
                ? new vscode.Range(
                    this.mapExactPosition(offsetAt(this.generatedText, range.start), start),
                    this.mapExactPosition(offsetAt(this.generatedText, range.end), end),
                )
                : start.sourceRange
        }

        return new vscode.Range(
            isExactMarker(start) ? this.mapExactPosition(offsetAt(this.generatedText, range.start), start) : start.sourceRange.start,
            isExactMarker(end) ? this.mapExactPosition(offsetAt(this.generatedText, range.end), end) : end.sourceRange.end,
        )
    }
}

export function isGeneratedNoise(name: unknown, source = ''): boolean {
    if (typeof name !== 'string') {
        return false
    }

    const normalized = name.replace(/^\$/, '')

    if (name.startsWith('$') && (normalized === '__currentLoopData' || normalized === 'loop')) {
        return !new RegExp(`\\$${normalized}\\b`).test(source)
    }

    return normalized === '__env'
      || normalized === '__newAttributes'
      || normalized === '__propNames'
      || normalized === '__defined_vars'
      || normalized === '__key'
      || normalized === '__value'
      || normalized.startsWith('__componentOriginal')
      || normalized.startsWith('__attributesOriginal')
      || normalized === 'component'
      || normalized === 'attributes'
      || generatedNoise.has(normalized)
}

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

    const range = result.range ? mapCompletionRange(result.range, markerMap) : result.range
    const textEdit = result.textEdit ? mapCompletionEdit(result.textEdit, markerMap) : result.textEdit

    if ((result.range && !range) || (result.textEdit && !textEdit)) {
        return null
    }

    return {
        ...result,
        ...(result.range ? {range} : {}),
        ...(result.textEdit ? {textEdit} : {}),
    }
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

        if (completion === null) {
            return []
        }

        if (completion) {
            return [completion]
        }

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
    }) as T[]
}

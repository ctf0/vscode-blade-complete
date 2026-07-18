import * as vscode from 'vscode'
import {positionAt, offsetAt, comparePositions} from '../text/position-utils'

export {isGeneratedNoise} from './generated-noise'

export interface MarkerSegment {
    kind           : string
    generatedStart : number
    generatedEnd   : number
    sourceRange    : vscode.Range
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

function isBetterSegment(candidate: MarkerSegment, current: MarkerSegment, byRange: (segment: MarkerSegment) => number): boolean {
    const candidatePriority = markerPriority(candidate.kind)
    const currentPriority = markerPriority(current.kind)

    return candidatePriority < currentPriority
      || (candidatePriority === currentPriority && byRange(candidate) < byRange(current))
}

export class BladeMarkerMap {
    readonly segments              : MarkerSegment[]
    private readonly generatedText : string

    constructor(generatedText: string) {
        this.generatedText = generatedText
        this.segments = []

        const pending = new Map<string, {kind: string, start: number, end: number, range: vscode.Range}[]>()
        const markerPattern = /(?:<!--|\/\*)\s*blade-complete:([\w-]+):(start|end):(\d+):(\d+):(\d+):(\d+)\s*(?:-->|\*\/)/g
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
        let best: MarkerSegment | undefined

        for (const segment of this.segments) {
            if (segment.generatedStart > offset) {
                break
            }

            if (offset > segment.generatedEnd) {
                continue
            }

            if (!best || isBetterSegment(segment, best, (s) => s.generatedEnd - s.generatedStart)) {
                best = segment
            }
        }

        return best
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
        let best: MarkerSegment | undefined

        for (const segment of this.segments) {
            if (!contains(segment.sourceRange, position)) {
                continue
            }

            if (!best || isBetterSegment(segment, best, (s) => s.sourceRange.end.line - s.sourceRange.start.line)) {
                best = segment
            }
        }

        return best
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
            return isExactMarker(start ?? end ?? {kind: ''} as MarkerSegment)
                ? start?.sourceRange ?? end?.sourceRange
                : undefined
        }

        if (start === end) {
            return this.mapExactRangeWithinSegment(range, start)
        }

        // When start and end fall in different segments, prefer the narrower
        // segment if one contains the other — e.g. an expression inside a
        // component tag. Without this, a link spanning from an expression
        // into the surrounding component tag maps to the entire component.
        if (contains(start.sourceRange, end.sourceRange.start) && contains(start.sourceRange, end.sourceRange.end)) {
            return this.mapExactRangeWithinSegment(range, end)
        }

        if (contains(end.sourceRange, start.sourceRange.start) && contains(end.sourceRange, start.sourceRange.end)) {
            return this.mapExactRangeWithinSegment(range, start)
        }

        const mappedStart = isExactMarker(start)
            ? this.mapExactPosition(offsetAt(this.generatedText, range.start), start)
            : undefined
        const mappedEnd = isExactMarker(end)
            ? this.mapExactPosition(offsetAt(this.generatedText, range.end), end)
            : undefined

        return mappedStart && mappedEnd
            ? new vscode.Range(mappedStart, mappedEnd)
            : undefined
    }

    private mapExactRangeWithinSegment(range: vscode.Range, segment: MarkerSegment): vscode.Range | undefined {
        return isExactMarker(segment)
            ? new vscode.Range(
                this.mapExactPosition(offsetAt(this.generatedText, range.start), segment),
                this.mapExactPosition(offsetAt(this.generatedText, range.end), segment),
            )
            : undefined
    }
}

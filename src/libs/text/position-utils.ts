import * as vscode from 'vscode'

/**
 * Pure position/offset utilities — no Blade-specific logic.
 * These are stable and used by 12+ files across the codebase.
 */

// Line-start offsets per text, LRU-capped: positionAt/offsetAt are called in
// loops over the same document text, and splitting/scanning the full string
// per call showed up as the hot path in reference scans.
const lineOffsetCache = new Map<string, number[]>()
const MAX_LINE_OFFSET_CACHE = 8

function lineOffsets(text: string): number[] {
    const cached = lineOffsetCache.get(text)

    if (cached) {
        lineOffsetCache.delete(text)
        lineOffsetCache.set(text, cached)

        return cached
    }

    const offsets = [0]

    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            offsets.push(i + 1)
        }
    }

    lineOffsetCache.set(text, offsets)

    if (lineOffsetCache.size > MAX_LINE_OFFSET_CACHE) {
        const oldest = lineOffsetCache.keys().next().value

        if (oldest !== undefined) {
            lineOffsetCache.delete(oldest)
        }
    }

    return offsets
}

export function positionAt(text: string, offset: number): vscode.Position {
    const offsets = lineOffsets(text)
    const clamped = Math.max(0, Math.min(offset, text.length))

    // Last line start <= clamped
    let low = 0
    let high = offsets.length - 1

    while (low < high) {
        const mid = (low + high + 1) >> 1

        if (offsets[mid] <= clamped) {
            low = mid
        } else {
            high = mid - 1
        }
    }

    return new vscode.Position(low, clamped - offsets[low])
}

export function comparePositions(left: vscode.Position, right: vscode.Position): number {
    return left.line - right.line || left.character - right.character
}

export function offsetAt(text: string, position: vscode.Position): number {
    const offsets = lineOffsets(text)
    const line = Math.max(0, Math.min(position.line, offsets.length - 1))
    const lineEnd = line + 1 < offsets.length ? offsets[line + 1] - 1 : text.length

    return offsets[line] + Math.min(position.character, lineEnd - offsets[line])
}

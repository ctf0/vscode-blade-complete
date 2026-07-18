import * as vscode from 'vscode'
import {getPhpDocBlocks} from '../core/config'
import {positionAt, offsetAt} from '../text/position-utils'
import {saveCompiledProbe} from '../compiler/compiled'
import {getBladePropsWithValues} from '../../parsers/blade'
import type {LivePhpRegion} from '../blade/completion'

/**
 * LivePhpProbe — builds synthetic PHP files from dirty Blade regions
 * so hover/definition/completion work without compiling the full document.
 */

interface LivePhpProbe {
    uri            : vscode.Uri
    position       : vscode.Position
    // maps a probe offset back to a source document offset; undefined when the
    // offset lies in the header/preamble (before the queried region content)
    toSourceOffset : (offset: number) => number | undefined
    // probe text, for converting probe positions to offsets
    text           : string
}

// Builds a synthetic PHP file from the dirty blade region so hover/definition work
// without compiling. The header mirrors the compiler's docblock preamble so
// global `@var` annotations (e.g. `$vs_auth_user`, `$errors`) still resolve.
async function buildLivePhpProbe(
    document: vscode.TextDocument,
    sourceOffset: number,
    region: LivePhpRegion,
): Promise<LivePhpProbe | undefined> {
    const text = document.getText()
    const regionText = text.slice(region.start, region.end)

    // config docblocks + file-local `{{-- @var ... --}}` annotations, mirroring
    // the compiler's preamble so local types resolve while typing
    const localBlocks = [...text.matchAll(/\{\{--\s*@var\b([\s\S]*?)--\}\}/g)]
        .map((m) => m[1].trim())
    const header = [
        ...getPhpDocBlocks(document.uri),
        ...localBlocks,
    ].map((block) => `/** @var ${block} */`).join('\n')

    // For non-php regions, hoist @php block contents and @props type hints into the
    // probe header so variable usages outside the directive resolve with proper types
    // instead of `unset`. PHP regions already include their own @php block content.
    const typePreamble = region.kind === 'php' ? '' : buildTypePreamble(document, text)

    let body: string
    let innerStartProbe: number
    let innerStartRegion: number

    if (region.kind === 'php') {
        const inner = regionText.replace(/^\s*@php\b/, '').replace(/@endphp\b\s*$/, '').trim()
        innerStartRegion = regionText.indexOf(inner)
        body = `<?php\n${header}\n${typePreamble}\n${inner}\n`
        innerStartProbe = body.length - inner.length
    } else if (region.kind === 'expression') {
        const inner = regionText
            .replace(/^\s*\{\{(?!\{)\-?\s*/, '')
            .replace(/\s*\-?\}\}\s*$/, '')
            .trim()
        innerStartRegion = regionText.indexOf(inner)
        body = `<?php\n${header}\n${typePreamble}\n$__blade = ${inner};\n`
        innerStartProbe = body.length - inner.length
    } else {
        return undefined
    }

    const toSourceOffset = (offset: number): number | undefined => {
        if (offset < innerStartProbe) {
            return undefined
        }

        return region.start + (offset - innerStartProbe) + innerStartRegion
    }

    const probeCursorOffset = innerStartProbe + (sourceOffset - region.start - innerStartRegion)

    const probePosAt = (offset: number): vscode.Position =>
        positionAt(body, Math.max(0, Math.min(offset, body.length)))

    return {
        uri      : vscode.Uri.file(await saveCompiledProbe(document, body)),
        position : probePosAt(probeCursorOffset),
        toSourceOffset,
        text     : body,
    }
}

function buildTypePreamble(document: vscode.TextDocument, text: string): string {
    const segments: string[] = []

    for (const block of text.matchAll(/@php\b([\s\S]*?)@endphp\b/gi)) {
        const inner = block[1].trim()

        if (inner) {
            segments.push(inner)
        }
    }

    for (const prop of getBladePropsWithValues(document)) {
        if (!prop.valueExpression || !prop.valueExpression.trim()) {
            continue
        }

        segments.push(`$${prop.name} = ${prop.valueExpression};`)
    }

    return segments.filter(Boolean).join('\n')
}

// Runs an intelephense command against the live probe and maps probe-URI results
// back to the source document. Results pointing at external files pass through.
export async function queryLivePhp<T>(
    document: vscode.TextDocument,
    command: string,
    position: vscode.Position,
    getLivePhpRegion: (document: vscode.TextDocument, position: vscode.Position) => LivePhpRegion | undefined,
): Promise<T[]> {
    const sourceOffset = document.offsetAt(position)
    const region = getLivePhpRegion(document, position)

    if (!region) {
        return []
    }

    const probe = await buildLivePhpProbe(document, sourceOffset, region)

    if (!probe) {
        return []
    }

    const results = await vscode.commands.executeCommand<T[]>(command, probe.uri, probe.position) ?? []

    return mapLiveResults(results, probe, document)
}

interface MappedResult {
    uri           : vscode.Uri
    range         : vscode.Range
    [key: string] : unknown
}

interface MappedDefinitionResult {
    targetUri             : vscode.Uri
    targetRange           : vscode.Range
    targetSelectionRange? : vscode.Range
    [key: string]         : unknown
}

interface MappedLocationResult {
    location : {
        uri           : vscode.Uri
        range         : vscode.Range
        [key: string] : unknown
    }
    [key: string] : unknown
}

function hasProbeUri(result: unknown, probeUri: vscode.Uri): boolean {
    return (result as MappedResult)?.uri?.toString() === probeUri.toString()
}

function hasProbeTargetUri(result: unknown, probeUri: vscode.Uri): boolean {
    return (result as MappedDefinitionResult)?.targetUri?.toString() === probeUri.toString()
}

function hasProbeLocationUri(result: unknown, probeUri: vscode.Uri): boolean {
    return (result as MappedLocationResult)?.location?.uri?.toString() === probeUri.toString()
}

function mapLiveResults<T>(results: T[], probe: LivePhpProbe, document: vscode.TextDocument): T[] {
    const probeOffsetAt = (pos: vscode.Position): number => offsetAt(probe.text, pos)

    const mapPos = (pos: vscode.Position): vscode.Position | undefined => {
        const sourceOffset = probe.toSourceOffset(probeOffsetAt(pos))

        return sourceOffset === undefined ? undefined : document.positionAt(sourceOffset)
    }

    const mapRange = (range: vscode.Range): vscode.Range | undefined => {
        const start = mapPos(range.start)
        const end = mapPos(range.end)

        return start && end ? new vscode.Range(start, end) : undefined
    }

    return results.flatMap((result) => {
        if (hasProbeUri(result, probe.uri)) {
            const r = result as MappedResult
            const range = mapRange(r.range)

            return range
                ? [{...r, uri: document.uri, range}] as T[]
                : []
        }

        if (hasProbeTargetUri(result, probe.uri)) {
            const r = result as MappedDefinitionResult
            const targetRange = mapRange(r.targetRange)

            if (!targetRange) {
                return []
            }

            const targetSelectionRange = r.targetSelectionRange
                ? mapRange(r.targetSelectionRange)
                : undefined

            return [{
                ...r,
                targetUri : document.uri,
                targetRange,
                ...(targetSelectionRange ? {targetSelectionRange} : {}),
            }] as T[]
        }

        if (hasProbeLocationUri(result, probe.uri)) {
            const r = result as MappedLocationResult
            const range = mapRange(r.location.range)

            return range
                ? [{
                    ...r,
                    location : {
                        ...r.location,
                        uri : document.uri,
                        range,
                    },
                }] as T[]
                : []
        }

        return [result]
    })
}

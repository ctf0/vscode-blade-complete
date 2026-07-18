import * as vscode from 'vscode'
import escapeStringRegexp from 'escape-string-regexp'
import {markBladeRename} from './rename'
import {positionAt} from '../text/position-utils'

/**
 * ViewNameReplacer — builds replacement ranges for Blade view-name
 * references and component tags across files. Extracted from
 * on-file-rename.ts to eliminate 26 lines of duplication between
 * replaceInBladeFiles and replaceViewCalls.
 */

export type RenameMapping = {
    oldViewName : string
    newViewName : string
    oldTagName  : string
    newTagName  : string
}

export type PendingEdit = {
    uri     : vscode.Uri
    content : string
    ranges  : {start: number, end: number, replacement: string}[]
}

type LaravelGotoViewApi = NonNullable<Awaited<ReturnType<typeof import('../blade/view-data')['waitForLaravelGotoView']>>>

function buildViewNameMap(mappings: RenameMapping[]): Map<string, string> {
    return new Map(mappings.map(({oldViewName, newViewName}) => [oldViewName, newViewName]))
}

function buildTagNameMap(mappings: RenameMapping[]): Map<string, string> {
    return new Map(mappings
        .filter(({oldTagName, newTagName}) => oldTagName !== newTagName)
        .map(({oldTagName, newTagName}) => [oldTagName, newTagName]))
}

function findViewNameRanges(
    content: string,
    api: LaravelGotoViewApi,
    viewNameMap: Map<string, string>,
): PendingEdit['ranges'] {
    const ranges: PendingEdit['ranges'] = []

    for (const {text, index} of api.findViewNameCalls(content)) {
        const replacement = viewNameMap.get(text)

        if (replacement) {
            ranges.push({start: index + 1 - text.length, end: index + 1, replacement})
        }
    }

    return ranges
}

function findComponentTagRanges(
    content: string,
    tagNameMap: Map<string, string>,
): PendingEdit['ranges'] {
    const ranges: PendingEdit['ranges'] = []

    for (const [oldTagName, newTagName] of tagNameMap) {
        const componentPattern = new RegExp(`<\\/?x-(${escapeStringRegexp(oldTagName)})(?![\\w.-])`, 'g')

        for (const match of content.matchAll(componentPattern)) {
            ranges.push({
                start       : match.index! + match[0].indexOf(match[1]),
                end         : match.index! + match[0].indexOf(match[1]) + match[1].length,
                replacement : newTagName,
            })
        }
    }

    return ranges
}

function hasAnyOldName(content: string, mappings: RenameMapping[], checkTagNames: boolean): boolean {
    return mappings.some(({oldViewName, oldTagName}) =>
        content.includes(oldViewName) || (checkTagNames && content.includes(oldTagName)))
}

function applyRanges(
    pending: PendingEdit,
    documents: Map<string, vscode.TextDocument>,
    edit: vscode.WorkspaceEdit,
    diskEdits: PendingEdit[],
): vscode.Uri | undefined {
    if (pending.ranges.length === 0) {
        return undefined
    }

    const document = documents.get(pending.uri.toString())

    if (document) {
        for (const {start, end, replacement} of pending.ranges) {
            edit.replace(
                pending.uri,
                new vscode.Range(positionAt(pending.content, start), positionAt(pending.content, end)),
                replacement,
            )
        }

        return pending.uri
    }

    diskEdits.push(pending)

    return undefined
}

export function replaceViewNamesInFiles(
    api: LaravelGotoViewApi,
    files: {uri: vscode.Uri, content: string}[],
    mappings: RenameMapping[],
    documents: Map<string, vscode.TextDocument>,
    edit: vscode.WorkspaceEdit,
    diskEdits: PendingEdit[],
    includeComponentTags: boolean,
): void {
    const viewNameMap = buildViewNameMap(mappings)
    const tagNameMap = includeComponentTags ? buildTagNameMap(mappings) : new Map<string, string>()

    for (const {uri, content} of files) {
        if (!hasAnyOldName(content, mappings, includeComponentTags)) {
            continue
        }

        const ranges = findViewNameRanges(content, api, viewNameMap)

        if (includeComponentTags) {
            ranges.push(...findComponentTagRanges(content, tagNameMap))
        }

        const openUri = applyRanges({uri, content, ranges}, documents, edit, diskEdits)

        if (openUri) {
            markBladeRename(openUri)
        }
    }
}

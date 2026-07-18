import * as vscode from 'vscode'
import escapeStringRegexp from 'escape-string-regexp'
import {getPhpDocBlocks} from './config'

export interface TypedCompletionContext {
    type       : string
    expression : string
    range      : vscode.Range
}

export interface CompletionResult {
    items        : vscode.CompletionItem[]
    isIncomplete : boolean
}

export const typedCompletionKinds = new Set([
    vscode.CompletionItemKind.Method,
    vscode.CompletionItemKind.Field,
    vscode.CompletionItemKind.Property,
    vscode.CompletionItemKind.Value,
    vscode.CompletionItemKind.Constant,
    vscode.CompletionItemKind.EnumMember,
])

// type positions (`@var`/`@see`, `new`, leading `\`) plus member kinds
export const classCompletionKinds = new Set([
    ...typedCompletionKinds,
    vscode.CompletionItemKind.Class,
    vscode.CompletionItemKind.Interface,
    vscode.CompletionItemKind.Enum,
    vscode.CompletionItemKind.Module,
])

// Class-like kinds only (no members). Used to decide whether a compiled-context
// completion should inline the FQCN instead of letting Intelephense insert a `use` import.
export const classOnlyKinds = new Set([
    vscode.CompletionItemKind.Class,
    vscode.CompletionItemKind.Interface,
    vscode.CompletionItemKind.Enum,
    vscode.CompletionItemKind.Module,
])

function getUseAliases(text: string, offset: number): Map<string, string> {
    const aliases = new Map<string, string>()
    const usePattern = /@use\s*\(\s*(?:(function|const)\s+)?(['"]?)\s*(\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*)\s*\2(?:\s+as\s+([A-Za-z_]\w*)|\s*,\s*(['"])\s*([A-Za-z_]\w*)\s*\5)?\s*\)/g
    let imported: RegExpExecArray | null

    while ((imported = usePattern.exec(text)) !== null) {
        if (imported.index >= offset) {
            break
        }

        if (imported[1]) {
            continue
        }

        const className = imported[3]
        const alias = imported[4] ?? imported[6] ?? className.split('\\').pop()!
        aliases.set(alias, className)
    }

    return aliases
}

function getAnnotatedType(text: string, target: string, offset: number): string {
    const annotationPattern = new RegExp(`@var\\s+(.+?)\\s+${escapeStringRegexp(target)}\\b`, 'g')
    const aliases = getUseAliases(text, offset)
    let type = ''
    let annotation: RegExpExecArray | null

    while ((annotation = annotationPattern.exec(text)) !== null) {
        if (annotation.index < offset) {
            type = annotation[1].trim()
        }
    }

    return aliases.get(type) ?? type
}

function getConfiguredType(target: string): string {
    const annotationPattern = new RegExp(`^(.+?)\\s+${escapeStringRegexp(target)}\\b`)

    for (const block of getPhpDocBlocks()) {
        const annotation = annotationPattern.exec(block)

        if (annotation) {
            return annotation[1].trim()
        }
    }

    return ''
}

export function getAnnotatedVariableType(
    document: vscode.TextDocument,
    position: vscode.Position,
): string | undefined {
    const range = document.getWordRangeAtPosition(position, /\$[A-Za-z_]\w*/)

    if (!range) {
        return undefined
    }

    const text = document.getText()
    const target = document.getText(range)
    const type = getAnnotatedType(text, target, document.offsetAt(position)) || getConfiguredType(target)

    return type || undefined
}

function resolveUseAlias(text: string, target: string, offset: number): string {
    return getUseAliases(text, offset).get(target) ?? target
}

export function getTypedCompletionContext(
    document: vscode.TextDocument,
    position: vscode.Position,
): TypedCompletionContext | undefined {
    const offset = document.offsetAt(position)
    const text = document.getText()
    const before = text.slice(0, offset)
    const expression = before.match(/(\$[A-Za-z_]\w*|\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*)\s*(->|::)([A-Za-z_]\w*)?$/)

    if (!expression) {
        return undefined
    }

    const target = expression[1]
    const operator = expression[2] as '->' | '::'
    const prefix = expression[3] ?? ''
    const type = target.startsWith('$')
        ? getAnnotatedType(text, target, offset)
        : resolveUseAlias(text, target, offset)

    if (!type) {
        return undefined
    }

    const prefixStart = document.positionAt(offset - prefix.length)

    return {
        type,
        expression : `${target}${operator}${prefix}`,
        range      : new vscode.Range(prefixStart, position),
    }
}

export interface ClassCompletionContext {
    prefix : string
    range  : vscode.Range
}

interface BladeRegion {
    kind  : 'php' | 'expression' | 'comment' | 'directive'
    start : number
    end   : number
}

// Allowed live regions for PHP completions: `@php … @endphp`, `{{ }}`/`{!! !!}`, and
// `{{-- @var/@see … --}}` comments. Closers are optional so completion works while
// the region is still being typed. Mirrors the compiler's `expression`/`php` markers.
const regionPatterns: Array<[RegExp, BladeRegion['kind']]> = [
    [/@php\b([\s\S]*?)(?:@endphp\b|$)/is, 'php'],
    [/\{\{--\s*@(?:var|see)\b[\s\S]*?(?:--\}\}|$)/g, 'comment'],
    [/\{\{(?!\{)[\s\S]*?(?:\}\}|$)/g, 'expression'],
    [/\{!![\s\S]*?(?:!!|$)/g, 'expression'],
]

function findBladeRegion(text: string, offset: number): BladeRegion | undefined {
    let best: BladeRegion | undefined

    for (const [pattern, kind] of regionPatterns) {
        const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
        let match: RegExpExecArray | null

        while ((match = re.exec(text)) !== null) {
            if (match.index > offset) {
                break
            }

            const start = match.index
            const end = match.index + match[0].length

            if (start <= offset && offset <= end) {
                if (!best || end - start < best.end - best.start) {
                    best = {kind, start, end}
                }
            }
        }
    }

    const directive = findDirectiveRegion(text, offset)

    if (directive && (!best || directive.end - directive.start < best.end - best.start)) {
        best = directive
    }

    return best
}

// Paren-depth aware so nested calls / multi-line conditions work while the closing paren is still being typed
function findDirectiveRegion(text: string, offset: number): BladeRegion | undefined {
    const re = /@([A-Za-z_]\w*)\s*\(/g
    let best: BladeRegion | undefined
    let match: RegExpExecArray | null

    while ((match = re.exec(text)) !== null) {
        const open = match.index + match[0].length - 1

        if (open > offset) {
            break
        }

        let depth = 0
        let end = text.length

        for (let i = open; i < text.length; i++) {
            const char = text[i]

            if (char === '(') {
                depth++
            } else if (char === ')') {
                depth--

                if (depth === 0) {
                    end = i
                    break
                }
            }
        }

        if (open <= offset && offset <= end && (!best || end - open < best.end - best.start)) {
            best = {kind: 'directive', start: open, end}
        }
    }

    return best
}

const fqcnToken = /(\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*\\?)$/

function getClassPrefixInRegion(text: string, region: BladeRegion, offset: number): {prefix: string, start: number} | undefined {
    const regionText = text.slice(region.start, offset)
    const match = regionText.match(fqcnToken)

    if (!match) {
        return undefined
    }

    const token = match[1]
    const absoluteStart = region.start + (offset - region.start - token.length)
    const before = text.slice(0, absoluteStart)
    const isValid = token.startsWith('\\')
      || /(?:^|[\s(,:])(?:new|@var|@see)\s*$/i.test(before)

    if (!isValid) {
        return undefined
    }

    return {prefix: token, start: absoluteStart}
}

export function getClassCompletionContext(
    document: vscode.TextDocument,
    position: vscode.Position,
): ClassCompletionContext | undefined {
    const offset = document.offsetAt(position)
    const text = document.getText()
    const region = findBladeRegion(text, offset)

    if (!region) {
        return undefined
    }

    const found = getClassPrefixInRegion(text, region, offset)

    if (!found) {
        return undefined
    }

    return {
        prefix : found.prefix,
        range  : new vscode.Range(document.positionAt(found.start), position),
    }
}

export interface LivePhpRegion {
    kind  : 'php' | 'expression' | 'comment' | 'directive'
    start : number
    end   : number
}

export function getLivePhpRegion(
    document: vscode.TextDocument,
    position: vscode.Position,
): LivePhpRegion | undefined {
    const region = findBladeRegion(document.getText(), document.offsetAt(position))

    if (!region) {
        return undefined
    }

    return {kind: region.kind, start: region.start, end: region.end}
}

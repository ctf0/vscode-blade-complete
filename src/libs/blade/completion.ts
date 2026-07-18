import * as vscode from 'vscode'
import escapeStringRegexp from 'escape-string-regexp'
import {getPhpDocBlocks, getPhpDefaultImports} from '../core/config'

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

    return aliases.get(type) ?? getConfiguredImports().get(type) ?? type
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

// phpDefaultImports supports "Root\Ns\{A, B}" (grouped) and "Root\Ns\Class" (plain).
function getConfiguredImports(): Map<string, string> {
    const imports = new Map<string, string>()

    for (const entry of getPhpDefaultImports()) {
        const trimmed = entry.trim()
        const grouped = /^(.+?)\\\{(.+?)\}$/.exec(trimmed)

        if (grouped) {
            for (const name of grouped[2].split(',')) {
                const short = name.trim()

                if (short) {
                    imports.set(short, `${grouped[1]}\\${short}`)
                }
            }

            continue
        }

        const short = trimmed.split('\\').pop()

        if (short) {
            imports.set(short, trimmed)
        }
    }

    return imports
}

// '' routes unresolvable names to the compiled fallback, whose prelude has the imports.
function resolveImportedType(text: string, target: string, offset: number): string {
    if (target.startsWith('\\')) {
        return target
    }

    return getUseAliases(text, offset).get(target)
      ?? getConfiguredImports().get(target)
      ?? ''
}

function resolveClassPrefix(prefix: string, text: string, offset: number): string {
    if (prefix.startsWith('\\')) {
        return prefix
    }

    return getUseAliases(text, offset).get(prefix)
      ?? getConfiguredImports().get(prefix)
      ?? prefix
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
    // Config phpDocBlocks carry reserved $attributes/$errors types no document annotation provides.
    const type = target.startsWith('$')
        ? getAnnotatedType(text, target, offset) || getConfiguredType(target)
        : resolveImportedType(text, target, offset)

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

const regionPatterns: Array<[RegExp, BladeRegion['kind']]> = [
    [/@php\b([\s\S]*?)(?:@endphp\b|$)/is, 'php'],
    [/\{\{--\s*@(?:var|see)\b[\s\S]*?(?:--\}\}|$)/g, 'comment'],
    [/\{\{(?!\{)[\s\S]*?(?:\}\}|$)/g, 'expression'],
    [/\{!![\s\S]*?(?:!!|$)/g, 'expression'],
]

// A region is a better match than the current best when it is strictly
// smaller (more specific). On equal spans the first-found region stays.
function isTighter(candidate: BladeRegion, current: BladeRegion | undefined): boolean {
    return !current || candidate.end - candidate.start < current.end - current.start
}

function findBladeRegion(text: string, offset: number): BladeRegion | undefined {
    const patternRegion = findSmallestPatternRegion(text, offset)
    const directiveRegion = findDirectiveRegion(text, offset)

    if (directiveRegion && isTighter(directiveRegion, patternRegion)) {
        return directiveRegion
    }

    return patternRegion
}

// Smallest of the static region patterns (`@php`, `{{-- @var --}}`, `{{ }}`,
// `{!! !!}`) that contains the offset.
function findSmallestPatternRegion(text: string, offset: number): BladeRegion | undefined {
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
                const region: BladeRegion = {kind, start, end}

                if (isTighter(region, best)) {
                    best = region
                }
            }
        }
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

        const end = findDirectiveEnd(text, open)

        if (open <= offset && offset <= end) {
            const region: BladeRegion = {kind: 'directive', start: open, end}

            if (isTighter(region, best)) {
                best = region
            }
        }
    }

    return best
}

// Index of the `)` that closes the paren opened at `open`, or the end of the
// text when the call is still being typed and never closes.
function findDirectiveEnd(text: string, open: number): number {
    let depth = 0

    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') {
            depth++
        } else if (text[i] === ')') {
            depth--

            if (depth === 0) {
                return i
            }
        }
    }

    return text.length
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
        prefix : resolveClassPrefix(found.prefix, text, offset),
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

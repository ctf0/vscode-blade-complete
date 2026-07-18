import * as vscode from 'vscode'
import {parsePhpExpression} from './php'
import {getCustomDirectives} from '../libs/core/config'
import {getBladePropsExpressions, extractPropsFromExpression, matchingParen} from '../libs/text/blade-string'

// `@word` followed by space, newline, or `(` — real Blade directive context
// This excludes Alpine.js `@click="..."` (followed by `=`) and other non-Blade `@` syntax
const directivePattern = /@\w+(?=[\s(]|$)/g

// Native Blade directive pairs (opener → closer)
const nativeOpenClose: Record<string, string> = {
    '@if'          : '@endif',
    '@unless'      : '@endunless',
    '@isset'       : '@endisset',
    '@empty'       : '@endempty',
    '@auth'        : '@endauth',
    '@guest'       : '@endguest',
    '@env'         : '@endenv',
    '@production'  : '@endproduction',
    '@switch'      : '@endswitch',
    '@for'         : '@endfor',
    '@foreach'     : '@endforeach',
    '@forelse'     : '@endforelse',
    '@while'       : '@endwhile',
    '@section'     : '@endsection',
    '@push'        : '@endpush',
    '@pushIf'      : '@endPushIf',
    '@pushOnce'    : '@endPushOnce',
    '@prepend'     : '@endprepend',
    '@prependOnce' : '@endPrependOnce',
    '@once'        : '@endonce',
    '@php'         : '@endphp',
    '@verbatim'    : '@endverbatim',
    '@slot'        : '@endslot',
    '@error'       : '@enderror',
    '@can'         : '@endcan',
    '@cannot'      : '@endcannot',
    '@canany'      : '@endcanany',
    '@fragment'    : '@endfragment',
    '@component'   : '@endcomponent',
}

// Directives that close with @endif instead of @end<name>
const endifAliases = new Set(['@hasSection', '@sectionMissing', '@hasstack'])

// Alternative closers for @section that aren't @endsection
const sectionClosers = new Set(['@show', '@stop', '@overwrite', '@append'])

export interface BladeProp {
    name  : string
    range : vscode.Range
}

export interface BladePropWithValue extends BladeProp {
    valueExpression : string
}

export function getBladeProps(document: vscode.TextDocument): BladeProp[] {
    return getBladePropsWithValues(document).map(({name, range}) => ({name, range}))
}

export function getBladePropsWithValues(document: vscode.TextDocument): BladePropWithValue[] {
    const source = document.getText()

    return getBladePropsExpressions(source).flatMap(({start, end}) =>
        extractPropsFromExpression(source, start, end).map((prop) => ({
            name            : prop.name,
            range           : new vscode.Range(document.positionAt(prop.keyStart), document.positionAt(prop.keyEnd + 1)),
            valueExpression : prop.valueExpression,
        })),
    )
}

function offsetPosition(position: vscode.Position, base: vscode.Position): vscode.Position {
    return new vscode.Position(
        base.line + position.line,
        position.line === 0 ? base.character + position.character : position.character,
    )
}

function offsetPhpSymbols(symbols: vscode.DocumentSymbol[], base: vscode.Position): vscode.DocumentSymbol[] {
    return symbols.map((symbol) => {
        const range = new vscode.Range(
            offsetPosition(symbol.range.start, base),
            offsetPosition(symbol.range.end, base),
        )
        const selectionRange = new vscode.Range(
            offsetPosition(symbol.selectionRange.start, base),
            offsetPosition(symbol.selectionRange.end, base),
        )
        const mapped = new vscode.DocumentSymbol(symbol.name, symbol.detail, symbol.kind, range, selectionRange)
        mapped.children = offsetPhpSymbols(symbol.children, base)

        return mapped
    })
}

function getOpenCloseMap(): Map<string, string> {
    const map = new Map(Object.entries(nativeOpenClose))
    const custom = getCustomDirectives()

    for (const [opener, closer] of Object.entries(custom)) {
        map.set(`@${opener}`, `@${closer}`)
    }

    return map
}

interface DirectiveMatch {
    name     : string
    index    : number
    startPos : vscode.Position
    endPos   : vscode.Position
}

function collectCommentRanges(text: string): Array<{start: number, end: number}> {
    const commentRanges: Array<{start: number, end: number}> = []
    const commentPattern = /\{\{\-\-[\s\S]*?\-\-\}\}/g
    let commentMatch: RegExpExecArray | null

    while ((commentMatch = commentPattern.exec(text)) !== null) {
        commentRanges.push({start: commentMatch.index, end: commentMatch.index + commentMatch[0].length})
    }

    return commentRanges
}

// Binary search: comments are sorted by start and non-overlapping, so an
// "inside a comment?" answer costs O(log n) instead of O(comments) per directive.
function isInsideComment(index: number, commentRanges: Array<{start: number, end: number}>): boolean {
    let low = 0
    let high = commentRanges.length - 1

    while (low <= high) {
        const mid = (low + high) >> 1
        const range = commentRanges[mid]

        if (index < range.start) {
            high = mid - 1
        } else if (index >= range.end) {
            low = mid + 1
        } else {
            return true
        }
    }

    return false
}

function buildCloserToOpener(openClose: Map<string, string>): Map<string, string> {
    // Reverse: closer → opener (for @endX matching)
    const closerToOpener = new Map<string, string>()

    for (const [opener, closer] of openClose) {
        closerToOpener.set(closer, opener)
    }

    // Alternate closers for @section
    for (const closer of sectionClosers) {
        closerToOpener.set(closer, '@section')
    }

    return closerToOpener
}

function collectDirectives(
    text: string,
    commentRanges: Array<{start: number, end: number}>,
    document: vscode.TextDocument,
): DirectiveMatch[] {
    const directives: DirectiveMatch[] = []
    let match: RegExpExecArray | null

    while ((match = directivePattern.exec(text)) !== null) {
        if (isInsideComment(match.index, commentRanges)) {
            continue
        }

        directives.push({
            name     : match[0],
            index    : match.index,
            startPos : document.positionAt(match.index),
            endPos   : document.positionAt(match.index + match[0].length),
        })
    }

    return directives
}

function getDirectiveRange(
    text: string,
    directive: DirectiveMatch,
    document: vscode.TextDocument,
): {range: vscode.Range, selectionRange: vscode.Range} {
    const selectionRange = new vscode.Range(directive.startPos, directive.endPos)
    let range = selectionRange

    if (directive.name === '@props') {
        const open = text.indexOf('(', directive.index + directive.name.length)
        const close = matchingParen(text, open)

        if (close !== undefined) {
            range = new vscode.Range(directive.startPos, document.positionAt(close + 1))
        }
    }

    return {range, selectionRange}
}

function matchesOpener(stackTopName: string, expectedOpener: string, closerName: string): boolean {
    return stackTopName === expectedOpener
      || (closerName === '@endif' && endifAliases.has(stackTopName))
}

function createDirectiveSymbol(name: string, range: vscode.Range, selectionRange: vscode.Range): vscode.DocumentSymbol {
    return new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Event, range, selectionRange)
}

export async function parseBladeDocument(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    const text = document.getText()

    const commentRanges = collectCommentRanges(text)
    const openClose = getOpenCloseMap()
    const closerToOpener = buildCloserToOpener(openClose)
    const allDirectives = collectDirectives(text, commentRanges, document)

    const symbols = getBladePropsExpressions(text).flatMap(({start, end}) =>
        offsetPhpSymbols(parsePhpExpression(text.slice(start, end)), document.positionAt(start)),
    )
    // Stack tracks opening directives awaiting a closing match
    const stack: {symbol: vscode.DocumentSymbol, name: string}[] = []

    for (const d of allDirectives) {
        const {range, selectionRange} = getDirectiveRange(text, d, document)
        const symbol = createDirectiveSymbol(d.name, range, selectionRange)

        if (closerToOpener.has(d.name)) {
            // Closing directive — try to pair with the most recent unmatched opener
            const expectedOpener = closerToOpener.get(d.name)!
            symbols.push(symbol)

            // @endif can match multiple openers — check the stack top against any valid match
            const opener = stack[stack.length - 1]
            const isMatch = opener !== undefined && matchesOpener(opener.name, expectedOpener, d.name)

            if (isMatch) {
                stack.pop()
                opener.symbol.range = new vscode.Range(opener.symbol.range.start, d.endPos)
            }
        } else if (openClose.has(d.name)) {
            // Opening directive with a known closing pair — push onto stack
            symbols.push(symbol)
            stack.push({symbol, name: d.name})
        } else {
            // Standalone directive (no closing pair)
            symbols.push(symbol)
        }
    }

    return symbols
}

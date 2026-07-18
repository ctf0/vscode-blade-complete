import * as vscode from 'vscode'
import {parsePhpExpression} from './php'

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

interface BladePropsExpression {
    start : number
    end   : number
}

function matchingParen(value: string, open: number): number | undefined {
    let depth = 0
    let quote: string | undefined

    for (let i = open; i < value.length; i++) {
        const character = value[i]

        if (quote) {
            if (character === '\\') {
                i++
            } else if (character === quote) {
                quote = undefined
            }

            continue
        }

        if (character === '\'' || character === '"') {
            quote = character
        } else if (character === '(') {
            depth++
        } else if (character === ')' && --depth === 0) {
            return i
        }
    }
}

function getBladePropsExpressions(source: string): BladePropsExpression[] {
    const expressions: BladePropsExpression[] = []
    const directives = /@props\s*\(/g
    let directive: RegExpExecArray | null

    while ((directive = directives.exec(source)) !== null) {
        const open = source.indexOf('(', directive.index)
        const close = matchingParen(source, open)
        const arrayStart = source.indexOf('[', open + 1)

        if (close === undefined || arrayStart < 0 || arrayStart > close) {
            continue
        }

        expressions.push({start: arrayStart, end: close})
    }

    return expressions
}

function extractPropFromArray(
    source: string,
    quoteIndex: number,
    close: number,
    document: vscode.TextDocument,
): {end: number, prop: BladeProp | undefined} | undefined {
    const end = source.indexOf(source[quoteIndex], quoteIndex + 1)

    if (end < 0) {
        return undefined
    }

    const next = source.slice(end + 1, close).trimStart()
    const prop = next.startsWith('=>') || next.startsWith(',') || next.startsWith(']')
        ? {
            name  : source.slice(quoteIndex + 1, end),
            range : new vscode.Range(document.positionAt(quoteIndex), document.positionAt(end + 1)),
        }
        : undefined

    return {end, prop}
}

export function getBladeProps(document: vscode.TextDocument): BladeProp[] {
    const source = document.getText()
    const props: BladeProp[] = []

    for (const {start: arrayStart, end: close} of getBladePropsExpressions(source)) {
        let depth = 0
        let quote: string | undefined

        for (let i = arrayStart; i < close; i++) {
            const character = source[i]

            if (quote) {
                if (character === '\\') {
                    i++
                } else if (character === quote) {
                    quote = undefined
                }

                continue
            }

            if (character === '\'' || character === '"') {
                const previous = source.slice(arrayStart, i).trimEnd().at(-1)
                quote = character

                if (depth !== 1 || (previous !== '[' && previous !== ',')) {
                    continue
                }

                const extracted = extractPropFromArray(source, i, close, document)

                if (extracted === undefined) {
                    break
                }

                if (extracted.prop) {
                    props.push(extracted.prop)
                }

                i = extracted.end
                quote = undefined
            } else if (character === '[' || character === '(' || character === '{') {
                depth++
            } else if (character === ']' || character === ')' || character === '}') {
                depth--
            }
        }
    }

    return props
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

    const custom = vscode.workspace.getConfiguration('bladeParser').get<Record<string, string>>('customDirectives')

    if (custom) {
        for (const [opener, closer] of Object.entries(custom)) {
            map.set(`@${opener}`, `@${closer}`)
        }
    }

    return map
}

export async function parseBladeDocument(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    const text = document.getText()

    const commentRanges: Array<{start: number, end: number}> = []
    const commentPattern = /\{\-\-[\s\S]*?\-\-\}\}/g
    let commentMatch: RegExpExecArray | null

    while ((commentMatch = commentPattern.exec(text)) !== null) {
        commentRanges.push({start: commentMatch.index, end: commentMatch.index + commentMatch[0].length})
    }

    function isInsideComment(index: number): boolean {
        for (const range of commentRanges) {
            if (index >= range.start && index < range.end) {
                return true
            }
        }

        return false
    }

    const openClose = getOpenCloseMap()

    // Reverse: closer → opener (for @endX matching)
    const closerToOpener = new Map<string, string>()

    for (const [opener, closer] of openClose) {
        closerToOpener.set(closer, opener)
    }

    // Alternate closers for @section
    for (const closer of sectionClosers) {
        closerToOpener.set(closer, '@section')
    }

    // Collect all directives with their positions
    const allDirectives: {name: string, index: number, startPos: vscode.Position, endPos: vscode.Position}[] = []

    let match: RegExpExecArray | null

    while ((match = directivePattern.exec(text)) !== null) {
        if (isInsideComment(match.index)) {
            continue
        }

        allDirectives.push({
            name     : match[0],
            index    : match.index,
            startPos : document.positionAt(match.index),
            endPos   : document.positionAt(match.index + match[0].length),
        })
    }

    const symbols = getBladePropsExpressions(text).flatMap(({start, end}) =>
        offsetPhpSymbols(parsePhpExpression(text.slice(start, end)), document.positionAt(start)),
    )
    // Stack tracks opening directives awaiting a closing match
    const stack: {symbol: vscode.DocumentSymbol, name: string}[] = []

    for (const d of allDirectives) {
        const selectionRange = new vscode.Range(d.startPos, d.endPos)
        let range = selectionRange

        if (d.name === '@props') {
            const open = text.indexOf('(', d.index + d.name.length)
            const close = matchingParen(text, open)

            if (close !== undefined) {
                range = new vscode.Range(d.startPos, document.positionAt(close + 1))
            }
        }

        if (closerToOpener.has(d.name)) {
            // Closing directive — try to pair with the most recent unmatched opener
            const expectedOpener = closerToOpener.get(d.name)!
            const symbol = new vscode.DocumentSymbol(d.name, '', vscode.SymbolKind.Event, range, selectionRange)
            symbols.push(symbol)

            // @endif can match multiple openers — check the stack top against any valid match
            const isMatch = stack.length > 0 && (
                stack[stack.length - 1].name === expectedOpener
                || (d.name === '@endif' && endifAliases.has(stack[stack.length - 1].name))
            )

            if (isMatch) {
                const opener = stack.pop()!
                opener.symbol.range = new vscode.Range(opener.symbol.range.start, d.endPos)
            }
        } else if (openClose.has(d.name)) {
            // Opening directive with a known closing pair — push onto stack
            const symbol = new vscode.DocumentSymbol(d.name, '', vscode.SymbolKind.Event, range, selectionRange)
            symbols.push(symbol)
            stack.push({symbol, name: d.name})
        } else {
            // Standalone directive (no closing pair)
            symbols.push(new vscode.DocumentSymbol(d.name, '', vscode.SymbolKind.Event, range, selectionRange))
        }
    }

    return symbols
}

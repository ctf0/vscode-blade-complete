// Pure string-level Blade parsing — no vscode imports, so it runs under
// node:test. The vscode.Range wrapping happens in parsers/blade.ts.

export interface BladePropString {
    name            : string
    valueExpression : string
    keyStart        : number // opening quote offset
    keyEnd          : number // closing quote offset (range end = keyEnd + 1)
    end             : number // loop advance offset
}

export function matchingParen(value: string, open: number): number | undefined {
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

export function getBladePropsExpressions(source: string): {start: number, end: number}[] {
    const expressions: {start: number, end: number}[] = []
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

// Returns the position of the first top-level comma or closing bracket that ends the
// value expression, or `valueStart` when the value runs all the way to `close`
export function findValueEnd(source: string, valueStart: number, close: number): number {
    let depth = 0
    let inString: string | undefined
    const valueEnd = valueStart

    for (let i = valueStart; i < close; i++) {
        const char = source[i]

        if (inString) {
            if (char === '\\') {
                i++
            } else if (char === inString) {
                inString = undefined
            }

            continue
        }

        if (char === '\'' || char === '"') {
            inString = char
        } else if (char === '[' || char === '(' || char === '{') {
            depth++
        } else if (char === ']' || char === ')' || char === '}') {
            if (depth === 0) {
                return i
            }

            depth--
        } else if (char === ',' && depth === 0) {
            return i
        }
    }

    return valueEnd
}

// Escape-aware scan for the quote closing a string at `open` — indexOf would
// stop at an escaped quote (e.g. 'it\'s') and truncate the key.
function findClosingQuote(source: string, open: number, quote: string): number {
    for (let i = open + 1; i < source.length; i++) {
        if (source[i] === '\\') {
            i++
        } else if (source[i] === quote) {
            return i
        }
    }

    return -1
}

function extractPropFromArray(
    source: string,
    quoteIndex: number,
    close: number,
): BladePropString | undefined {
    const end = findClosingQuote(source, quoteIndex, source[quoteIndex])

    if (end < 0) {
        return undefined
    }

    const name = source.slice(quoteIndex + 1, end)
    const next = source.slice(end + 1, close).trimStart()

    if (next.startsWith('=>')) {
        const arrowOffset = source.indexOf('=>', end + 1)
        const valueStart = arrowOffset + 2
        const valueEnd = findValueEnd(source, valueStart, close)

        return {
            name,
            keyStart        : quoteIndex,
            keyEnd          : end,
            end             : Math.max(end, valueEnd - 1),
            valueExpression : source.slice(valueStart, valueEnd).trim(),
        }
    }

    if (next.startsWith(',') || next.startsWith(']')) {
        return {name, keyStart: quoteIndex, keyEnd: end, end, valueExpression: ''}
    }

    return undefined
}

// Last non-whitespace char before `from` — backward scan replaces the
// quadratic `source.slice(arrayStart, i).trimEnd().at(-1)` per quote char.
function previousSignificantChar(source: string, from: number): string | undefined {
    for (let j = from - 1; j >= 0; j--) {
        if (!/\s/.test(source[j])) {
            return source[j]
        }
    }

    return undefined
}

export function extractPropsFromExpression(
    source: string,
    arrayStart: number,
    close: number,
): BladePropString[] {
    const props: BladePropString[] = []
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

        if (character !== '\'' && character !== '"') {
            if (character === '[' || character === '(' || character === '{') {
                depth++
            } else if (character === ']' || character === ')' || character === '}') {
                depth--
            }

            continue
        }

        const previous = previousSignificantChar(source, i)
        const isPropKey = depth === 1 && (previous === '[' || previous === ',')
        quote = character

        if (!isPropKey) {
            continue
        }

        const extracted = extractPropFromArray(source, i, close)

        if (extracted === undefined) {
            break
        }

        props.push(extracted)
        i = extracted.end
        quote = undefined
    }

    return props
}

import {readFile} from 'fs/promises'
import {Engine} from 'php-parser'
import * as vscode from 'vscode'
import {compileBlade} from '../libs/compiler/compiled'
import {BladeMarkerMap, isGeneratedNoise} from '../libs/compiler/mapping'
import {debugLog} from '../libs/core/debug'

const parser = new Engine({
    parser : {
        extractDoc     : true,
        php7           : true,
        suppressErrors : true,
    },
    ast : {
        withPositions : true,
    },
})

function getChildren(node: Record<string, unknown>): Record<string, unknown>[] {
    if (Array.isArray(node.children)) {
        return node.children
    }

    if (Array.isArray(node.body)) {
        return node.body
    }

    if (node.body && typeof node.body === 'object' && Array.isArray((node.body as Record<string, unknown>).children)) {
        return (node.body as Record<string, unknown>).children as Record<string, unknown>[]
    }

    return []
}

function createRange(loc: Record<string, {line: number, column: number}> | undefined): vscode.Range {
    if (!loc) {
        return new vscode.Range(0, 0, 0, 0)
    }

    const start = new vscode.Position((loc.start.line || 1) - 1, loc.start.column || 0)
    const end = new vscode.Position((loc.end.line || 1) - 1, loc.end.column || 0)

    return new vscode.Range(start, end)
}

function walkCallTarget(what: Record<string, unknown>, visited: Set<string>): vscode.DocumentSymbol[] {
    if (what.kind === 'name') {
        const callName = what.name as string

        if (!callName) {
            return []
        }

        const nameRange = createRange(what.loc as Record<string, {line: number, column: number}> | undefined)

        return [new vscode.DocumentSymbol(callName, '', vscode.SymbolKind.Function, nameRange, nameRange)]
    }

    if (what.kind === 'staticlookup') {
        return walkStaticLookup(what)
    }

    if (what.kind === 'methodcall') {
        return walkMethodCall(what)
    }

    return walkExpressionSymbols(what, visited)
}

function walkStaticLookup(what: Record<string, unknown>): vscode.DocumentSymbol[] {
    const className = ((what.what as Record<string, unknown>)?.name as string) || ''
    const methodName = ((what.offset as Record<string, unknown>)?.name as string) || ''
    const classSelRange = createRange((what.what as Record<string, {loc: any}> | undefined)?.loc as any || undefined)
    const methodSelRange = createRange((what.offset as Record<string, {loc: any}> | undefined)?.loc as any || undefined)
    const classSym = new vscode.DocumentSymbol(className, '', vscode.SymbolKind.Class, classSelRange, classSelRange)

    if (methodName) {
        classSym.children.push(new vscode.DocumentSymbol(methodName, '', vscode.SymbolKind.Method, methodSelRange, methodSelRange))
    }

    return [classSym]
}

function walkMethodCall(what: Record<string, unknown>): vscode.DocumentSymbol[] {
    const methodName = ((what.offset as Record<string, unknown>)?.name as string) || ''

    if (!methodName) {
        return []
    }

    const methodSelRange = createRange((what.offset as Record<string, {loc: any}> | undefined)?.loc as any || undefined)

    return [new vscode.DocumentSymbol(methodName, '', vscode.SymbolKind.Method, methodSelRange, methodSelRange)]
}

function walkCall(node: Record<string, unknown>, visited: Set<string>): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = []
    const what = node.what as Record<string, unknown> | undefined

    if (what) {
        symbols.push(...walkCallTarget(what, visited))
    }

    const args = node.arguments as Record<string, unknown>[] | undefined

    if (args) {
        for (const arg of args) {
            symbols.push(...walkExpressionSymbols(arg, visited))
        }
    }

    return symbols
}

function walkPropertyLookup(node: Record<string, unknown>, visited: Set<string>): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = []
    const offset = node.offset as Record<string, unknown> | undefined

    if (offset?.name) {
        const range = createRange(offset.loc as Record<string, {line: number, column: number}> | undefined)
        symbols.push(new vscode.DocumentSymbol(String(offset.name), '', vscode.SymbolKind.Property, range, range))
    }

    const what = node.what as Record<string, unknown> | undefined

    if (what) {
        symbols.push(...walkExpressionSymbols(what, visited))
    }

    return symbols
}

function walkString(node: Record<string, unknown>): vscode.DocumentSymbol[] {
    const rawValue = node.value as string | undefined
    const name = rawValue || '(empty string)'
    const range = createRange(node.loc as Record<string, {line: number, column: number}> | undefined)

    return [new vscode.DocumentSymbol(name, '', vscode.SymbolKind.String, range, range)]
}

function walkNumber(node: Record<string, unknown>): vscode.DocumentSymbol[] {
    const name = String(node.value ?? node.raw ?? '0')
    const range = createRange(node.loc as Record<string, {line: number, column: number}> | undefined)

    return [new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Number, range, range)]
}

function walkBoolean(node: Record<string, unknown>): vscode.DocumentSymbol[] {
    const name = String(node.raw ?? node.value ?? 'true')
    const range = createRange(node.loc as Record<string, {line: number, column: number}> | undefined)

    return [new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Boolean, range, range)]
}

function walkNullKeyword(node: Record<string, unknown>): vscode.DocumentSymbol[] {
    const range = createRange(node.loc as Record<string, {line: number, column: number}> | undefined)

    return [new vscode.DocumentSymbol('null', '', vscode.SymbolKind.Null, range, range)]
}

function walkVariable(node: Record<string, unknown>, visited: Set<string>): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = []
    const name = '$' + (node.name as string)
    const range = createRange(node.loc as Record<string, {line: number, column: number}> | undefined)
    symbols.push(new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Variable, range, range))

    const children = getChildren(node)

    for (const child of children) {
        symbols.push(...walkExpressionSymbols(child, visited))
    }

    return symbols
}

function walkEncapsed(node: Record<string, unknown>, visited: Set<string>): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = []
    const parts = node.value as Record<string, unknown>[] | undefined

    if (parts) {
        for (const part of parts) {
            const expr = part.expression as Record<string, unknown> | undefined

            if (expr && expr.kind) {
                symbols.push(...walkExpressionSymbols(expr, visited))
            }
        }
    }

    return symbols
}

// Laravel's e() escape helper — walk its arguments instead of reporting the call itself
function isEscapeHelperCall(expr: Record<string, unknown>): boolean {
    if (expr.kind !== 'call') {
        return false
    }

    const what = expr.what as Record<string, unknown> | undefined

    return what?.kind === 'name' && what.name === 'e'
}

function walkEchoExpressions(node: Record<string, unknown>, visited: Set<string>): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = []
    const expressions = node.expressions as Record<string, unknown>[] | undefined

    if (!expressions) {
        return symbols
    }

    for (const expr of expressions) {
        if (node.kind === 'echo' && isEscapeHelperCall(expr)) {
            const args = expr.arguments as Record<string, unknown>[] | undefined

            if (args) {
                for (const arg of args) {
                    symbols.push(...walkExpressionSymbols(arg, visited))
                }
            }
        } else {
            symbols.push(...walkExpressionSymbols(expr, visited))
        }
    }

    return symbols
}

function walkKnownProperties(node: Record<string, unknown>, visited: Set<string>): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = []

    for (const key of ['expression', 'what', 'offset', 'left', 'right', 'items', 'key', 'value', 'test', 'cond', 'body', 'alternate', 'trueBody', 'falseBody']) {
        const val = node[key]

        if (val && typeof val === 'object' && !Array.isArray(val) && (val as Record<string, unknown>).kind) {
            symbols.push(...walkExpressionSymbols(val as Record<string, unknown>, visited))
        } else if (Array.isArray(val)) {
            for (const item of val) {
                if (item && typeof item === 'object' && (item as Record<string, unknown>).kind) {
                    symbols.push(...walkExpressionSymbols(item as Record<string, unknown>, visited))
                }
            }
        }
    }

    return symbols
}

function walkGeneric(node: Record<string, unknown>, visited: Set<string>): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = []

    const children = getChildren(node)

    for (const child of children) {
        symbols.push(...walkExpressionSymbols(child, visited))
    }

    symbols.push(...walkEchoExpressions(node, visited))
    symbols.push(...walkKnownProperties(node, visited))

    return symbols
}

let syntheticOffsetCounter = 0

function getSyntheticOffset(): number {
    return -(++syntheticOffsetCounter)
}

const expressionWalkers: Record<string, (node: Record<string, unknown>, visited: Set<string>) => vscode.DocumentSymbol[]> = {
    call                   : walkCall,
    propertylookup         : walkPropertyLookup,
    nullsafepropertylookup : walkPropertyLookup,
    string                 : walkString,
    number                 : walkNumber,
    boolean                : walkBoolean,
    nullkeyword            : walkNullKeyword,
    variable               : walkVariable,
    encapsed               : walkEncapsed,
}

function walkExpressionSymbols(node: Record<string, unknown>, visited = new Set<string>()): vscode.DocumentSymbol[] {
    if (!node || typeof node !== 'object' || !node.kind) {
        return []
    }

    // Track objects by position to prevent re-walking the same node
    const location = node.loc as Record<string, {offset: number}> | undefined
    const startOff = location?.start?.offset ?? getSyntheticOffset()
    const endOff = location?.end?.offset ?? getSyntheticOffset()
    const id = `${node.kind}_${startOff}_${endOff}`

    if (visited.has(id)) {
        return []
    }

    visited.add(id)

    const walker = expressionWalkers[node.kind as string] ?? walkGeneric

    return walker(node, visited)
}

export function parsePhpExpression(expression: string): vscode.DocumentSymbol[] {
    if (!expression.trim()) {
        return []
    }

    try {
        const ast = parser.parseEval(expression) as unknown as Record<string, unknown>

        return walkExpressionSymbols(ast)
    } catch (error) {
        debugLog(`parsePhpExpression failed: ${error instanceof Error ? error.message : String(error)}`)

        return []
    }
}

function mapSymbolsToDocument(
    symbols: vscode.DocumentSymbol[],
    markerMap: BladeMarkerMap,
    source: string,
): vscode.DocumentSymbol[] {
    return symbols.flatMap((sym) => {
        const children = mapSymbolsToDocument(sym.children, markerMap, source)

        if (isGeneratedNoise(sym.name, source)) {
            return children
        }

        if (!markerMap.isExactRange(sym.range)) {
            return children
        }

        const range = markerMap.toSourceRange(sym.range)

        if (!range) {
            return []
        }

        sym.range = range
        sym.selectionRange = markerMap.toSourceRange(sym.selectionRange) ?? range
        sym.children = children

        return [sym]
    })
}

export async function parsePhpDocument(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    const compiledPath = await compileBlade(document)

    if (!compiledPath) {
        return []
    }

    try {
        const phpCode = await readFile(compiledPath, 'utf8')
        const ast = parser.parseCode(phpCode, compiledPath) as unknown as Record<string, unknown>
        const markerMap = new BladeMarkerMap(phpCode)
        const symbols = walkExpressionSymbols(ast)

        return mapSymbolsToDocument(symbols, markerMap, document.getText())
    } catch (error) {
        debugLog(`parsePhpDocument failed in ${document.uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`)

        return []
    }
}

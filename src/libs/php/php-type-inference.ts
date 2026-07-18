import * as vscode from 'vscode'
import {Engine} from 'php-parser'
import {getBladePropsWithValues} from '../../parsers/blade'
import {debugLog} from '../core/debug'

const typeInferenceParser = new Engine({
    parser : {
        extractDoc     : true,
        php7           : true,
        suppressErrors : true,
    },
    ast : {
        withPositions : false,
    },
})

type AstNode = Record<string, unknown>

function inferPhpTypeFromNode(node: AstNode | undefined): string {
    if (!node || typeof node !== 'object' || !node.kind) {
        return ''
    }

    switch (node.kind) {
        case 'boolean':
            return 'bool'

        case 'number': {
            const raw = String(node.value ?? '')

            return raw.includes('.') ? 'float' : 'int'
        }

        case 'string':
            return 'string'
        case 'nullkeyword':
            return 'null'
        case 'array':
            return 'array'
        case 'name':
            return String(node.name ?? '')

        case 'staticlookup':
            return inferStaticLookupType(node)

        case 'new':
        case 'unary':
            return inferPhpTypeFromNode(node.what as AstNode | undefined)
        case 'encapsed':
            return 'string'
        default:
            return ''
    }
}

function inferStaticLookupType(node: AstNode): string {
    const offset = node.offset as AstNode | undefined
    const what = node.what as AstNode | undefined

    if (offset?.kind === 'identifier' && offset.name === 'class') {
        return inferPhpTypeFromNode(what)
    }

    if (what?.kind === 'name') {
        return inferPhpTypeFromNode(what)
    }

    return ''
}

function inferPropType(valueExpression: string): string {
    const trimmed = valueExpression.trim()

    if (!trimmed) {
        return ''
    }

    if (trimmed === 'true' || trimmed === 'false' || trimmed === 'TRUE' || trimmed === 'FALSE') {
        return 'bool'
    }

    if (trimmed === 'null' || trimmed === 'NULL') {
        return 'null'
    }

    return inferTypeFromExpression(trimmed)
}

function inferTypeFromExpression(expression: string): string {
    try {
        const ast = typeInferenceParser.parseEval(expression) as unknown as AstNode
        const children = Array.isArray(ast.children) ? ast.children as AstNode[] : []
        const first = children[0]

        if (!first) {
            return ''
        }

        const expressionNode = (first.expression ?? first) as AstNode

        return inferPhpTypeFromNode(expressionNode)
    } catch (error) {
        debugLog(`inferPropType parse failed: ${error instanceof Error ? error.message : String(error)}`)

        return ''
    }
}

export function buildBladePropHover(
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.Hover | undefined {
    const wordRange = document.getWordRangeAtPosition(position, /\$[A-Za-z_]\w*/)

    if (!wordRange) {
        return undefined
    }

    const word = document.getText(wordRange)

    if (!word.startsWith('$')) {
        return undefined
    }

    const propName = word.slice(1)
    const props = getBladePropsWithValues(document)
    const prop = props.find(({name}) => name === propName)

    if (!prop) {
        return undefined
    }

    const type = inferPropType(prop.valueExpression) || 'mixed'

    const markdown = new vscode.MarkdownString()
    markdown.isTrusted = true
    markdown.appendMarkdown(`\`\`\`php\n@var ${type} ${word}\n\`\`\``)

    return new vscode.Hover(markdown, wordRange)
}

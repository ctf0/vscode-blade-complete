import * as vscode from 'vscode'
import {getCompiledContext, saveCompiledProbe} from '../compiler/compiled'
import {classOnlyKinds} from '../blade/completion'
import type {TypedCompletionContext, ClassCompletionContext} from '../blade/completion'

/**
 * CompletionProbe — manages synthetic PHP probe files for typed/class
 * completion queries, isolating probe URI construction from the completion
 * decision logic.
 */

export interface CompletionProbe {
    typedQuery      : {source: string, position: vscode.Position} | undefined
    classQuery      : {source: string, position: vscode.Position} | undefined
    typedUri        : vscode.Uri | undefined
    classUri        : vscode.Uri | undefined
    compiledContext : Awaited<ReturnType<typeof getCompiledContext>>
}

export async function buildCompletionProbeUris(
    document: vscode.TextDocument,
    typedContext: TypedCompletionContext | undefined,
    classContext: ClassCompletionContext | undefined,
): Promise<CompletionProbe> {
    const typedQuery = typedContext ? getTypedCompletionQuery(typedContext) : undefined
    const classQuery = classContext ? getClassCompletionQuery(classContext) : undefined
    const typedUri = typedQuery
        ? vscode.Uri.file(await saveCompiledProbe(document, typedQuery.source))
        : undefined
    const classUri = classQuery
        ? vscode.Uri.file(await saveCompiledProbe(document, classQuery.source))
        : undefined
    const compiledContext = (typedQuery || classQuery) ? undefined : await getCompiledContext(document)

    return {typedQuery, classQuery, typedUri, classUri, compiledContext}
}

function getTypedCompletionQuery(context: TypedCompletionContext): {
    source   : string
    position : vscode.Position
} {
    const operatorIndex = context.expression.includes('->')
        ? context.expression.indexOf('->')
        : context.expression.indexOf('::')
    const target = context.expression.slice(0, operatorIndex)

    if (target.startsWith('$')) {
        return {
            source   : `<?php\n/** @var ${context.type} ${target} */\n${context.expression};\n`,
            position : new vscode.Position(2, context.expression.length),
        }
    }

    const suffix = context.expression.slice(target.length)

    return {
        source   : `<?php\n${context.type}${suffix};\n`,
        position : new vscode.Position(1, context.type.length + suffix.length),
    }
}

function getClassCompletionQuery(context: ClassCompletionContext): {
    source   : string
    position : vscode.Position
} {
    const prefix = context.prefix.startsWith('\\') ? context.prefix : `\\${context.prefix}`

    return {
        source   : `<?php\n/** @var ${prefix} $x */\n`,
        position : new vscode.Position(1, 9 + prefix.length),
    }
}

export function mapTypedCompletionItems(
    items: vscode.CompletionItem[],
    range: vscode.Range,
    typedPrefix?: string,
): vscode.CompletionItem[] {
    const fqcnPrefix = typedPrefix && typedPrefix.includes('\\')
        ? typedPrefix.slice(0, typedPrefix.lastIndexOf('\\') + 1)
        : undefined

    return items.map((item) => {
        const {textEdit, additionalTextEdits, ...completion} = item as vscode.CompletionItem & {textEdit?: {newText: string}}
        const labelStr = typeof item.label === 'string' ? item.label : (item.label as any)?.label
        const insertText = fqcnPrefix && labelStr ? fqcnPrefix + labelStr : textEdit?.newText

        return {
            ...completion,
            range,
            ...(insertText ? {insertText} : {}),
            ...(insertText ? {filterText: insertText} : {}),
        }
    })
}

// Intelephense sets `detail` to `use <FQCN>` for importable classes/traits/modules.
// Strip the `use ` prefix, then validate it's a real FQCN (at least one backslash).
function extractFqcn(item: vscode.CompletionItem): string | undefined {
    const labelStr = typeof item.label === 'string'
        ? item.label
        : (item.label as any)?.label
    const detail = typeof item.detail === 'string' ? item.detail.trim() : ''

    const detailFqcn = detail.replace(/^use\s+/, '')

    if (/^[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)+$/.test(detailFqcn)) {
        return detailFqcn
    }

    if (typeof labelStr === 'string' && /^[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*$/.test(labelStr)) {
        return labelStr
    }

    return undefined
}

export function inlineFqcnCompletions(
    items: vscode.CompletionItem[],
): vscode.CompletionItem[] {
    return items.map((item) => {
        const {additionalTextEdits, ...completion} = item as vscode.CompletionItem

        if (!item.kind || !classOnlyKinds.has(item.kind)) {
            return completion
        }

        const fqcn = extractFqcn(item)

        if (!fqcn) {
            return completion
        }

        const {textEdit, ...classCompletion} = completion
        const labelStr = typeof item.label === 'string'
            ? item.label
            : (item.label as any)?.label
        const insertText = `\\${fqcn}`

        return {
            ...classCompletion,
            insertText,
            filterText : labelStr ?? insertText,
        }
    })
}

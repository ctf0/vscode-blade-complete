// Self-contained Blade syntax highlighter for VS Code's markdown preview.
//
// The markdown preview uses highlight.js to render fenced code blocks, but
// highlight.js has no built-in "blade" language. We cannot ship highlight.js
// as a dependency (npm install is blocked in this environment), and we want
// the solution to be fully self-contained within this extension.
//
// Instead, we use the `markdown.markdownItPlugins` contribution point to hook
// into the markdown-it instance used by the preview. We override the `highlight`
// option for `blade` / `blade.php` fenced blocks and produce HTML wrapped in
// the same `hljs-*` CSS classes that the preview's built-in highlight.css
// already styles. This gives us colored output in the preview without any
// external dependencies.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MarkdownIt {
    options: {
        highlight? : ((code: string, lang: string) => string) | null
    }
    utils: {
        escapeHtml : (str: string) => string
    }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
    type  : string
    value : string
}

// Blade directives (compiled to PHP). We cover the common built-ins; custom
// directives are handled by the generic @-directive rule.
const DIRECTIVES = new Set([
    'if', 'elseif', 'else', 'endif', 'unless', 'endunless', 'isset', 'endisset',
    'empty', 'endempty', 'auth', 'endauth', 'guest', 'endguest', 'can', 'cannot',
    'endcan', 'endcannot', 'for', 'foreach', 'endforeach', 'forelse', 'endforelse',
    'while', 'endwhile', 'switch', 'case', 'endswitch', 'break', 'continue',
    'php', 'endphp', 'push', 'endpush', 'section', 'endsection', 'show', 'stop',
    'overwrite', 'append', 'yield', 'extends', 'include', 'includeIf', 'includeWhen',
    'includeFirst', 'each', 'once', 'endonce', 'csrf', 'method', 'json', 'dump',
    'dd', 'props', 'js', 'use', 'env', 'enderror', 'error', 'hasSection', 'sectionMissing',
    'first', 'endfirst', 'prepends', 'endprepend', 'stack', 'vite', 'livewire',
])

// PHP keywords for highlighting inside PHP blocks.
const PHP_KEYWORDS = new Set([
    'abstract', 'as', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'declare', 'default', 'do', 'echo', 'else', 'elseif', 'empty', 'enddeclare',
    'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'enum', 'extends',
    'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto',
    'if', 'implements', 'include', 'include_once', 'instanceof', 'interface',
    'isset', 'list', 'match', 'namespace', 'new', 'print', 'private', 'protected',
    'public', 'readonly', 'require', 'require_once', 'return', 'static', 'switch',
    'throw', 'trait', 'try', 'unset', 'use', 'var', 'while', 'yield', 'true',
    'false', 'null', 'and', 'or', 'xor',
])

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

/**
 * Tokenize a Blade source string into typed tokens that map to highlight.js
 * CSS classes (hljs-keyword, hljs-string, hljs-comment, etc.).
 *
 * This is a pragmatic tokenizer — it covers the common Blade constructs
 * (directives, echos, comments, PHP blocks, HTML, strings, variables) and
 * falls back to plain text for anything it doesn't recognize. It does NOT
 * aim for 100% fidelity with the full TextMate grammar.
 */
function tokenizeBlade(source: string): Token[] {
    const tokens: Token[] = []
    let i = 0
    const len = source.length

    // State: are we inside a @php ... @endphp raw PHP block?
    const state = {inPhpBlock: false}

    while (i < len) {
        // -- Blade comment: {{-- ... --}} ---------------------------------
        if (source.startsWith('{{--', i)) {
            i = scanDelimitedComment(source, tokens, i, '{{--', '--}}')
            continue
        }

        // -- Blade directive: @word ---------------------------------------
        if (source[i] === '@' && /[a-zA-Z]/.test(source[i + 1] ?? '')) {
            i = scanDirective(source, tokens, i, len, state)
            continue
        }

        // -- Inside @php block: tokenize as PHP --------------------------
        if (state.inPhpBlock) {
            i = scanPhpBlock(source, tokens, i, len)
            continue
        }

        // -- Blade echo: {{ ... }} or {!! ... !!} ------------------------
        if (source.startsWith('{{', i)) {
            i = scanEcho(source, tokens, i, len)
            continue
        }

        // -- HTML comment: <!-- ... --> -----------------------------------
        if (source.startsWith('<!--', i)) {
            i = scanDelimitedComment(source, tokens, i, '<!--', '-->')
            continue
        }

        // -- HTML tag: <tag ...> or </tag> --------------------------------
        if (source[i] === '<' && /[\/a-zA-Z]/.test(source[i + 1] ?? '')) {
            const next = scanHtmlTag(source, tokens, i)

            if (next !== null) {
                i = next
                continue
            }
        }

        // -- Quoted string ------------------------------------------------
        if (source[i] === '"' || source[i] === '\'') {
            i = scanString(source, tokens, i)
            continue
        }

        // -- Default: accumulate plain text until next interesting char ---
        i = scanPlainText(source, tokens, i, len)
    }

    return mergeTextTokens(tokens)
}

function scanDirective(source: string, tokens: Token[], i: number, len: number, state: {inPhpBlock: boolean}): number {
    let j = i + 1

    while (j < len && /[a-zA-Z]/.test(source[j])) {
        j++
    }

    const name = source.slice(i + 1, j)

    if (name === 'php' && !state.inPhpBlock) {
        state.inPhpBlock = true
        tokens.push({type: 'keyword', value: '@php'})

        return j
    }

    if (name === 'endphp' && state.inPhpBlock) {
        state.inPhpBlock = false
        tokens.push({type: 'keyword', value: '@endphp'})

        return j
    }

    const cls = DIRECTIVES.has(name) ? 'keyword' : 'meta'
    tokens.push({type: cls, value: '@' + name})

    return j
}

function scanPhpBlock(source: string, tokens: Token[], i: number, len: number): number {
    const next = findNextDirective(source, i)
    const chunk = source.slice(i, next === -1 ? len : next)
    tokens.push(...tokenizePhp(chunk))

    return next === -1 ? len : next
}

function scanEcho(source: string, tokens: Token[], i: number, len: number): number {
    const raw = source.startsWith('{!!', i)
    const tag = raw ? '{!!' : '{{'
    const close = raw ? '!!}' : '}}'
    const end = source.indexOf(close, i + tag.length)
    const stop = end === -1 ? len : end + close.length
    tokens.push({type: 'punctuation', value: tag})
    const inner = source.slice(i + tag.length, end === -1 ? len : end)
    tokens.push(...tokenizePhpExpression(inner))

    if (end !== -1) {
        tokens.push({type: 'punctuation', value: close})
    }

    return stop
}

function scanHtmlTag(source: string, tokens: Token[], i: number): number | null {
    const tagMatch = matchHtmlTag(source, i)

    if (!tagMatch) {
        return null
    }

    tokens.push({type: 'tag', value: tagMatch.text})

    return i + tagMatch.text.length
}

function scanPlainText(source: string, tokens: Token[], i: number, len: number): number {
    let j = i

    while (j < len) {
        const c = source[j]

        if (c === '@' || c === '<' || c === '"' || c === '\'' || c === '{') {
            break
        }

        j++
    }

    if (j === i) {
        tokens.push({type: 'text', value: source[i]})

        return i + 1
    }

    tokens.push({type: 'text', value: source.slice(i, j)})

    return j
}

function findNextDirective(source: string, from: number): number {
    const match = /@endphp\b/.exec(source.slice(from))

    return match ? from + match.index : -1
}

function matchHtmlTag(source: string, start: number): {text: string} | null {
    // Match </?tagname(\s[^>]*)?> or self-closing
    const re = /^<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^>]*?)?\/?>/y
    re.lastIndex = start
    const m = re.exec(source)

    return m ? {text: m[0]} : null
}

function findStringEnd(source: string, start: number, quote: string): number {
    let i = start + 1

    while (i < source.length) {
        if (source[i] === '\\') {
            i += 2
            continue
        }

        if (source[i] === quote) {
            return i + 1
        }

        i++
    }

    return source.length
}

function scanDelimitedComment(
    source: string,
    tokens: Token[],
    start: number,
    open: string,
    close: string,
): number {
    const end = source.indexOf(close, start + open.length)
    const stop = end === -1 ? source.length : end + close.length
    tokens.push({type: 'comment', value: source.slice(start, stop)})

    return stop
}

function scanVariable(source: string, tokens: Token[], start: number, len: number): number {
    let j = start + 1

    while (j < len && /[a-zA-Z0-9_]/.test(source[j])) {
        j++
    }

    tokens.push({type: 'variable', value: source.slice(start, j)})

    return j
}

function scanString(source: string, tokens: Token[], start: number): number {
    const end = findStringEnd(source, start, source[start])

    tokens.push({type: 'string', value: source.slice(start, end)})

    return end
}

function scanArrowAccess(source: string, tokens: Token[], start: number, len: number): number {
    tokens.push({type: 'symbol', value: source.slice(start, start + 2)})
    let j = start + 2

    while (j < len && /[a-zA-Z0-9_]/.test(source[j])) {
        j++
    }

    if (j > start + 2) {
        tokens.push({type: 'attr', value: source.slice(start + 2, j)})
    }

    return j
}

function scanIdentifier(source: string, tokens: Token[], start: number, len: number): number {
    let j = start

    while (j < len && /[a-zA-Z0-9_\\]/.test(source[j])) {
        j++
    }

    const word = source.slice(start, j)

    if (PHP_KEYWORDS.has(word.toLowerCase())) {
        tokens.push({type: 'keyword', value: word})
    } else if (source[j] === '(') {
        tokens.push({type: 'title', value: word})
    } else {
        tokens.push({type: 'class', value: word})
    }

    return j
}

function scanNumber(source: string, tokens: Token[], start: number, len: number): number {
    let j = start
    let hasDot = false

    while (j < len && /[0-9.eE_]/.test(source[j])) {
        if (source[j] === '.') {
            if (hasDot) {
                break
            }

            hasDot = true
        } else if (source[j] === 'e' || source[j] === 'E') {
            if (j + 1 < len && (source[j + 1] === '+' || source[j + 1] === '-')) {
                j++
            }
        }

        j++
    }

    tokens.push({type: 'number', value: source.slice(start, j)})

    return j
}

function scanPhpConstruct(source: string, tokens: Token[], start: number, len: number): number | undefined {
    const c = source[start]

    if (c === '"' || c === '\'') {
        return scanString(source, tokens, start)
    }

    if (c === '$') {
        return scanVariable(source, tokens, start, len)
    }

    if (source.startsWith('->', start) || source.startsWith('::', start)) {
        return scanArrowAccess(source, tokens, start, len)
    }

    if (/[a-zA-Z_\\]/.test(c)) {
        return scanIdentifier(source, tokens, start, len)
    }

    if (/[0-9]/.test(c)) {
        return scanNumber(source, tokens, start, len)
    }

    return undefined
}

/**
 * Tokenize a PHP expression (inside {{ }} or {!! !!}) for highlighting.
 */
function tokenizePhpExpression(source: string): Token[] {
    const tokens: Token[] = []
    let i = 0
    const len = source.length

    while (i < len) {
        const c = source[i]

        // Whitespace / commas
        if (/\s/.test(c) || c === ',' || c === ';' || c === '(' || c === ')' || c === '[' || c === ']' || c === '=>') {
            let j = i

            while (j < len && /[\s,;()\[\]]/.test(source[j])) {
                j++
            }

            tokens.push({type: 'text', value: source.slice(i, j)})
            i = j
            continue
        }

        const next = scanPhpConstruct(source, tokens, i, len)

        if (next !== undefined) {
            i = next
            continue
        }

        // Operators and everything else
        tokens.push({type: 'text', value: c})
        i++
    }

    return mergeTextTokens(tokens)
}

/**
 * Tokenize raw PHP (inside @php ... @endphp blocks).
 */
function tokenizePhp(source: string): Token[] {
    const tokens: Token[] = []
    let i = 0
    const len = source.length

    while (i < len) {
        const c = source[i]

        // Line comment // or #
        if ((c === '/' && source[i + 1] === '/') || c === '#') {
            let j = i

            while (j < len && source[j] !== '\n') {
                j++
            }

            tokens.push({type: 'comment', value: source.slice(i, j)})
            i = j
            continue
        }

        // Block comment /* ... */
        if (c === '/' && source[i + 1] === '*') {
            i = scanDelimitedComment(source, tokens, i, '/*', '*/')
            continue
        }

        const next = scanPhpConstruct(source, tokens, i, len)

        if (next !== undefined) {
            i = next
            continue
        }

        // Default: whitespace / operators
        tokens.push({type: 'text', value: c})
        i++
    }

    return mergeTextTokens(tokens)
}

function mergeTextTokens(tokens: Token[]): Token[] {
    const result: Token[] = []

    for (const t of tokens) {
        const last = result[result.length - 1]

        if (last && last.type === 'text' && t.type === 'text') {
            last.value += t.value
        } else {
            result.push({...t})
        }
    }

    return result
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

const TOKEN_CLASS_MAP: Record<string, string> = {
    keyword     : 'hljs-keyword',
    string      : 'hljs-string',
    comment     : 'hljs-comment',
    variable    : 'hljs-variable',
    number      : 'hljs-number',
    tag         : 'hljs-tag',
    attr        : 'hljs-attr',
    title       : 'hljs-title',
    class       : 'hljs-class',
    symbol      : 'hljs-symbol',
    meta        : 'hljs-meta',
    punctuation : 'hljs-subst',
    text        : '',
}

function renderTokens(tokens: Token[]): string {
    return tokens
        .map((t) => {
            const escaped = escapeHtml(t.value)
            const cls = TOKEN_CLASS_MAP[t.type]

            return cls ? `<span class="${cls}">${escaped}</span>` : escaped
        })
        .join('')
}

/**
 * Highlight a Blade code block, returning HTML with `hljs-*` spans.
 * The markdown-it renderer wraps this in `<pre><code>` automatically.
 */
function highlightBlade(code: string): string {
    const tokens = tokenizeBlade(code)

    return renderTokens(tokens)
}

// ---------------------------------------------------------------------------
// markdown-it plugin
// ---------------------------------------------------------------------------

/**
 * Exported via the `markdown.markdownItPlugins` contribution point.
 * VS Code's markdown preview calls this function with the markdown-it
 * instance so we can hook into the fenced-code-block rendering.
 */
export function extendMarkdownIt(md: MarkdownIt): MarkdownIt {
    const originalHighlight = md.options.highlight

    md.options.highlight = (code: string, lang: string): string => {
        const normalized = (lang ?? '').toLowerCase().trim()

        if (normalized === 'blade' || normalized === 'blade.php') {
            return highlightBlade(code)
        }

        return originalHighlight ? originalHighlight(code, lang) : md.utils.escapeHtml(code)
    }

    return md
}

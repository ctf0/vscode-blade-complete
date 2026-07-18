// Blade syntax highlighting for VS Code's markdown preview.
//
// VS Code's markdown preview uses highlight.js internally to render fenced
// code blocks, but highlight.js has no built-in "blade" language. We import
// only the highlight.js core + the languages Blade depends on (php,
// php-template, xml) to keep the bundle small (~100KB vs ~2MB for the full
// highlight.js bundle).
//
// The Blade language definition is inlined from spatie/highlightjs-blade
// (MIT, maintained, last updated Jan 2025) to avoid CJS/ESM interop issues
// with esbuild bundling.

import hljs from 'highlight.js/lib/core'
import php from 'highlight.js/lib/languages/php'

hljs.registerLanguage('php', php)

hljs.registerLanguage('blade', function(hljs) {
    const HTML_TAG = {
        className : 'tag',
        begin     : /<\/?[a-zA-Z][\w:-]*(?:\s[^>]*)?\/?>/,
    }
    const HTML_COMMENT = hljs.COMMENT(/<!--/, /-->/)
    const BLADE_COMMENT = hljs.COMMENT(/\{\{--/, /--\}\}/)
    const BLADE_ECHO = {
        className : 'subst',
        begin     : /\{\{/,
        end       : /\}\}/,
        contains  : [{begin: /./, end: /(?=\}\})/, subLanguage: 'php'}],
    }
    const BLADE_UNESCAPED = {
        className : 'subst',
        begin     : /\{!!/,
        end       : /!!\}/,
        contains  : [{begin: /./, end: /(?=!!\})/, subLanguage: 'php'}],
    }
    const BLADE_PHP_BLOCK = {
        className : 'keyword',
        begin     : /@php\b/,
        end       : /@endphp\b/,
        contains  : [{begin: /./, end: /(?=@endphp)/, subLanguage: 'php'}],
        relevance : 10,
    }
    const BLADE_DIRECTIVE = {
        className : 'keyword',
        begin     : /@\w+/,
    }
    const BLADE_VARIABLE = {
        className : 'variable',
        begin     : /\$[a-zA-Z_]\w*/,
    }
    const PHP_TAG = {
        begin       : /<\?(php|=)?/,
        end         : /\?>/,
        subLanguage : 'php',
    }
    const HTML_STRING_DOUBLE = {
        className : 'string',
        begin     : /"/,
        end       : /"/,
    }
    const HTML_STRING_SINGLE = {
        className : 'string',
        begin     : /'/,
        end       : /'/,
    }

    return {
        name     : 'Blade',
        contains : [
            BLADE_COMMENT,
            HTML_COMMENT,
            BLADE_ECHO,
            BLADE_UNESCAPED,
            BLADE_PHP_BLOCK,
            BLADE_DIRECTIVE,
            BLADE_VARIABLE,
            PHP_TAG,
            HTML_TAG,
            HTML_STRING_DOUBLE,
            HTML_STRING_SINGLE,
        ],
    }
})

interface MarkdownIt {
    options: {
        highlight? : ((code: string, lang: string) => string) | null
    }
    utils: {
        escapeHtml : (str: string) => string
    }
}

function highlightBlade(code: string): string {
    const result = hljs.highlight(code, {language: 'blade'})

    // The Blade definition above only emits classes VS Code's markdown
    // preview stylesheet already handles, so no remapping is needed.
    return result.value
}

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

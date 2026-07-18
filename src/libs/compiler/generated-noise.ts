/**
 * Generated noise — names and patterns for compiler-generated variables/helpers
 * that are noise for the blade author. Shared between diagnostics filtering
 * and result-mapping.
 */

// All generated variable/helper names (normalized, without leading $)
const GENERATED_NAMES = new Set([
    // Blade compiler internals
    '__env',
    '__newAttributes',
    '__propNames',
    '__defined_vars',
    '__key',
    '__value',
    '__currentLoopData',
    'loop',
    'component',
    'attributes',
    'slot',
    // Component rendering helpers
    'renderComponent',
    'startComponent',
    'endComponent',
    'withAttributes',
    'shouldRender',
    'resolveView',
    'getCurrentComponentData',
    'sanitizeComponentAttribute',
])

// Prefixes for generated names
const GENERATED_PREFIXES = [
    '__componentOriginal',
    '__attributesOriginal',
]

// Regex for filtering diagnostics messages — matches substrings in diagnostic
// message text.  Broader than GENERATED_NAMES/GENERATED_PREFIXES because it also
// catches `$__php_*` internal vars that appear in messages but are not covered
// by the name-based helpers (used for symbol-level filtering, not messages).
export const generatedNoisePattern = /(__env|__currentLoopData|__componentOriginal|__attributesOriginal|__propNames|__key|__value|\$slot|\$__php_)/

const CURRENT_LOOP_DATA_PATTERN = /\$__currentLoopData\b/
const LOOP_PATTERN = /\$loop\b/

// Reserved blade variables that stay visible when the source references them
const SOURCE_GATED_PATTERNS = new Map<string, RegExp>([
    ['__currentLoopData', CURRENT_LOOP_DATA_PATTERN],
    ['loop', LOOP_PATTERN],
    ['attributes', /\$attributes\b/],
    ['slot', /\$slot\b/],
    ['component', /\$component\b/],
])

/**
 * Check if a name is compiler-generated noise.
 * For names starting with $, also checks if the variable is actually used
 * in the source (e.g. `$__currentLoopData` is noise, but `$loop` is real).
 */
export function isGeneratedNoise(name: unknown, source = ''): boolean {
    if (typeof name !== 'string') {
        return false
    }

    const normalized = name.replace(/^\$/, '')

    if (name.startsWith('$') && SOURCE_GATED_PATTERNS.has(normalized)) {
        return !SOURCE_GATED_PATTERNS.get(normalized)!.test(source)
    }

    if (GENERATED_NAMES.has(normalized)) {
        return true
    }

    return GENERATED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * Completion items carry a `label` (not a symbol `name`), and blade/laravel
 * reserve the `__` prefix for internals injected by compilation, so match the
 * prefix in addition to the known generated names.
 */
export function isGeneratedCompletionNoise(label: string, source = ''): boolean {
    const normalized = label.replace(/^\$/, '')

    return normalized.startsWith('__') || isGeneratedNoise(label, source)
}

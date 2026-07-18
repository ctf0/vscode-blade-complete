export function phpString(value: string): string {
    return '\'' + value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'') + '\''
}

// Inside a double-quoted segment a backslash escapes only the characters
// the shell treats specially. Any other backslash is kept literally.
function isDoubleQuoteEscape(char: string, next: string | undefined): boolean {
    return char === '\\'
      && next !== undefined
      && (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n')
}

export function splitCommand(command: string): string[] {
    const parts: string[] = []
    let current = ''
    let quote: string | undefined
    let pushEmpty = false

    for (let i = 0; i < command.length; i++) {
        const char = command[i]

        if (quote === '"') {
            const nextChar = i + 1 < command.length ? command[i + 1] : undefined

            if (isDoubleQuoteEscape(char, nextChar)) {
                current += command[++i]
            } else if (char === '"') {
                quote = undefined

                if (current === '') {
                    pushEmpty = true
                }
            } else {
                current += char
            }

            continue
        }

        if (quote === '\'') {
            if (char === '\'') {
                quote = undefined

                if (current === '') {
                    pushEmpty = true
                }
            } else {
                current += char
            }

            continue
        }

        if (char === '\'' || char === '"') {
            quote = char
        } else if (/\s/.test(char)) {
            if (current || pushEmpty) {
                parts.push(current)
                current = ''
                pushEmpty = false
            }
        } else {
            current += char
        }
    }

    if (quote !== undefined && (current !== '' || pushEmpty)) {
        // Unterminated quote: keep accumulated content so PHP gets the partial arg
        // instead of silently dropping it.
        parts.push(current)
    } else if (current || pushEmpty) {
        parts.push(current)
    }

    return parts
}

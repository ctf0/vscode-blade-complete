export function phpString(value: string): string {
    return '\'' + value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'') + '\''
}

export function splitCommand(command: string): string[] {
    const parts: string[] = []
    let current = ''
    let quote: string | undefined

    for (let i = 0; i < command.length; i++) {
        const char = command[i]

        if (quote) {
            if (char === quote) {
                quote = undefined
            } else {
                current += char
            }

            continue
        }

        if (char === '\'' || char === '"') {
            quote = char
        } else if (/\s/.test(char)) {
            if (current) {
                parts.push(current)
                current = ''
            }
        } else {
            current += char
        }
    }

    if (current) {
        parts.push(current)
    }

    return parts
}

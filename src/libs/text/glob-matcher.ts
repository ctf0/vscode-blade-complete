import picomatch from 'picomatch'

const cache = new Map<string, (path: string) => boolean>()

export function matchesGlob(filePath: string, glob: string): boolean {
    let fn = cache.get(glob)

    if (!fn) {
        fn = picomatch(glob, {dot: true})
        cache.set(glob, fn)
    }

    return fn(filePath)
}

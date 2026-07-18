declare module 'picomatch' {
    interface PicomatchOptions {
        dot?    : boolean
        nocase? : boolean
        bash?   : boolean
    }

    function picomatch(glob: string, options?: PicomatchOptions): (path: string) => boolean

    export default picomatch
}

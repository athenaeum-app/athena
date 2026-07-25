// Third-party highlight.js grammars ship without types.
declare module 'highlightjs-luau' {
    import type { LanguageFn } from 'highlight.js'
    const luau: LanguageFn
    export default luau
}

declare module '@exercism/highlightjs-gdscript' {
    import type { LanguageFn } from 'highlight.js'
    const gdscript: LanguageFn
    export default gdscript
}

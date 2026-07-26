import { describe, it, expect } from 'vitest'
import { quoteFor } from './ChatPanel'

describe('quoteFor', () => {
    it('prefixes a single line and leaves room to type under it', () => {
        expect(quoteFor('Hello!')).toBe('> Hello!\n\n')
    })

    it('keeps a multi-line message as one blockquote', () => {
        expect(quoteFor('first\nsecond')).toBe('> first\n> second\n\n')
    })

    it('leaves no trailing space on a blank line inside the quote', () => {
        // '> ' on its own would be trailing whitespace in the composer, and
        // some markdown tooling treats it as a hard break.
        expect(quoteFor('first\n\nsecond')).toBe('> first\n>\n> second\n\n')
    })

    it('quotes a quote rather than flattening it', () => {
        expect(quoteFor('> already quoted')).toBe('> > already quoted\n\n')
    })

    it('drops embed tokens, which cannot survive being quoted', () => {
        const id = '11111111-2222-3333-4444-555555555555'
        expect(quoteFor(`see this ::todo:${id}::`)).toBe('> see this\n\n')
        expect(quoteFor(`see this [[${id}]]`)).toBe('> see this\n\n')
    })

    it('gives nothing back for a message that is only an embed', () => {
        expect(quoteFor('::canvas:11111111-2222-3333-4444-555555555555::')).toBe('')
        expect(quoteFor('')).toBe('')
        expect(quoteFor('   ')).toBe('')
    })

    it('preserves markdown in the quoted text', () => {
        expect(quoteFor('**bold** and `code`')).toBe('> **bold** and `code`\n\n')
    })
})

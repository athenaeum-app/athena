import { describe, it, expect } from 'vitest'
import { findBareUrls } from './linkPreviews'

const urls = (content: string) => findBareUrls(content).map((u) => u.url)

describe('findBareUrls', () => {
    it('finds a bare url and reports the text to replace', () => {
        const content = 'see https://example.com/a today'
        expect(findBareUrls(content)).toEqual([
            { url: 'https://example.com/a', start: 4, end: 25 },
        ])
        expect(content.slice(4, 25)).toBe('https://example.com/a')
    })

    it('keeps repeats, because each one is its own piece of text', () => {
        expect(urls('https://a.com then https://a.com')).toEqual(['https://a.com', 'https://a.com'])
    })

    it('drops sentence punctuation that trails the url', () => {
        expect(urls('read https://example.com/page.')).toEqual(['https://example.com/page'])
    })

    it('reports offsets in the original string, not the masked one', () => {
        const content = '`code` https://example.com'
        const [match] = findBareUrls(content)
        expect(content.slice(match.start, match.end)).toBe('https://example.com')
    })
})

// Everything below would be destructive rather than merely wrong: an inline
// preview deletes the text it matched.
describe('findBareUrls, text it must not touch', () => {
    it('leaves a markdown link alone, label and destination both', () => {
        expect(urls('[the docs](https://example.com/docs)')).toEqual([])
    })

    it('leaves an image alone', () => {
        expect(urls('![alt](https://cdn.example.com/a.png)')).toEqual([])
    })

    it('leaves a link whose label is the url it points at', () => {
        expect(urls('[https://example.com](https://example.com)')).toEqual([])
    })

    it('leaves an autolink alone', () => {
        expect(urls('<https://example.com>')).toEqual([])
    })

    it('leaves an inline code span alone', () => {
        expect(urls('run `curl https://example.com` first')).toEqual([])
    })

    it('leaves a fenced code block alone', () => {
        expect(urls('```\ncurl https://example.com\n```')).toEqual([])
    })

    it('leaves an unterminated fence alone to the end, like the renderer does', () => {
        expect(urls('```\ncurl https://example.com')).toEqual([])
    })

    it('still finds a url after a fence has closed', () => {
        expect(urls('```\nhttps://inside.example\n```\nhttps://outside.example')).toEqual([
            'https://outside.example',
        ])
    })
})

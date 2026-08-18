import { describe, it, expect } from 'vitest'
import { parse } from './MomentBody'

const shape = (content: string, inline = true) =>
    parse(content, inline).map((p) =>
        p.type === 'md' ? `md:${p.text.trim()}` : p.type === 'links' ? `links:${p.urls.join(',')}` : `${p.kind}`,
    )

describe('parse, inline link previews off', () => {
    it('leaves urls in the markdown', () => {
        expect(shape('see https://example.com now', false)).toEqual(['md:see https://example.com now'])
    })

    it('still splits on embed tokens', () => {
        expect(shape('a [[abc123]] b', false)).toEqual(['md:a', 'moment', 'md:b'])
    })

    it('splits on a project token', () => {
        expect(shape('before ::project:abc123:: after', false)).toEqual(['md:before', 'project', 'md:after'])
    })
})

describe('parse, inline link previews on', () => {
    it('replaces the url and resumes the text below it', () => {
        expect(shape('check this out https://example.com and tell me')).toEqual([
            'md:check this out',
            'links:https://example.com',
            'md:and tell me',
        ])
    })

    it('groups links written back to back into one row', () => {
        expect(shape('https://a.com https://b.com https://c.com')).toEqual([
            'links:https://a.com,https://b.com,https://c.com',
        ])
    })

    it('groups a bullet list of links, without leaving the bullets behind', () => {
        expect(shape('- https://a.com\n- https://b.com')).toEqual(['links:https://a.com,https://b.com'])
    })

    it('does not swallow the text introducing a list of links', () => {
        expect(shape('Worth reading:\n- https://a.com\n- https://b.com')).toEqual([
            'md:Worth reading:',
            'links:https://a.com,https://b.com',
        ])
    })

    it('keeps links apart when real words separate them', () => {
        expect(shape('https://a.com but also https://b.com')).toEqual([
            'links:https://a.com',
            'md:but also',
            'links:https://b.com',
        ])
    })

    it('treats a thematic break as a real separator', () => {
        expect(shape('https://a.com\n\n---\n\nhttps://b.com')).toEqual([
            'links:https://a.com',
            'md:---',
            'links:https://b.com',
        ])
    })

    it('interleaves with embeds in document order', () => {
        expect(shape('start https://a.com mid [[abc123]] end')).toEqual([
            'md:start',
            'links:https://a.com',
            'md:mid',
            'moment',
            'md:end',
        ])
    })

    it('leaves a markdown link in the prose for the stack below to pick up', () => {
        expect(shape('read [the docs](https://example.com) first')).toEqual([
            'md:read [the docs](https://example.com) first',
        ])
    })
})

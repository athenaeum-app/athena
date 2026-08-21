import { describe, it, expect } from 'vitest'
import { excerpt, parse, stripEmbedTokens } from './MomentBody'

const shape = (content: string, inline = true) =>
    parse(content, inline).map((p) =>
        p.type === 'md' ? `md:${p.text.trim()}` : p.type === 'links' ? `links:${p.urls.join(',')}` : `${p.kind}`,
    )

// The agenda is the one embed whose second segment is a scope rather than an
// id, so its tests read what the scope came out as.
const scopes = (content: string) =>
    parse(content, false).flatMap((p) => (p.type === 'embed' && p.kind === 'agenda' ? [p.id] : []))

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

    it('splits on a document token', () => {
        expect(shape('see ::doc:abc123:: for why', false)).toEqual(['md:see', 'doc', 'md:for why'])
    })

    it('interleaves a document token with the other kinds in document order', () => {
        expect(shape('::doc:abc123:: then ::project:def456::', false)).toEqual(['doc', 'md:then', 'project'])
    })

    it('embeds a legacy moment, whose v1 id is not a uuid', () => {
        // The importer carried v1 ids over as they were, so what the picker
        // offers is not all hex, and a token holding one of those ids used to
        // render as raw text the author never typed.
        expect(shape('see [[moment_awjohd219uyqw9dq2]] here', false)).toEqual(['md:see', 'moment', 'md:here'])
    })

    it('leaves a bracketed word too short to be an id as written', () => {
        expect(shape('a [[note]] b', false)).toEqual(['md:a [[note]] b'])
    })

    it('splits on an agenda token, which carries a scope and not an id', () => {
        expect(shape('today: ::agenda:: onwards', false)).toEqual(['md:today:', 'agenda', 'md:onwards'])
        expect(scopes('::agenda::')).toEqual(['all'])
        expect(scopes('::agenda:all:: ::agenda:tasks:: ::agenda:projects::')).toEqual(['all', 'tasks', 'projects'])
    })

    it('leaves an agenda scope nobody has as written, rather than drawing an empty one', () => {
        expect(shape('::agenda:everything::', false)).toEqual(['md:::agenda:everything::'])
    })

    it('interleaves an agenda with the entity kinds in document order', () => {
        expect(shape('::doc:abc123:: then ::agenda:tasks::', false)).toEqual(['doc', 'md:then', 'agenda'])
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

// A token inside a code sample is the author showing what a token looks like.
// Rendering a live card for it both fetches something nobody asked for and
// deletes the token from the sample it was meant to be.
describe('parse, tokens inside code', () => {
    it('splits on a token in prose', () => {
        expect(shape('before ::todo:abc123:: after', false)).toEqual(['md:before', 'todo', 'md:after'])
    })

    it('leaves a token inside a fenced code block as text', () => {
        expect(shape('```\n::todo:abc123::\n```', false)).toEqual(['md:```\n::todo:abc123::\n```'])
    })

    it('leaves a moment reference inside a fenced code block as text', () => {
        expect(shape('```\n[[abc123]]\n```', false)).toEqual(['md:```\n[[abc123]]\n```'])
    })

    it('leaves a token inside a tilde fence as text', () => {
        expect(shape('~~~\n::canvas:abc123::\n~~~', false)).toEqual(['md:~~~\n::canvas:abc123::\n~~~'])
    })

    it('leaves a document token inside a fenced code block as text', () => {
        expect(shape('```\n::doc:abc123::\n```', false)).toEqual(['md:```\n::doc:abc123::\n```'])
    })

    it('leaves a token inside an inline code span as text', () => {
        expect(shape('write `::project:abc123::` to embed', false)).toEqual([
            'md:write `::project:abc123::` to embed',
        ])
    })

    it('leaves a token inside a double-backtick span as text', () => {
        expect(shape('``a ::todo:abc123:: b``', false)).toEqual(['md:``a ::todo:abc123:: b``'])
    })

    it('still splits on a token after a closed code block', () => {
        expect(shape('```\n::todo:abc123::\n```\n\n::todo:def456::', false)).toEqual([
            'md:```\n::todo:abc123::\n```',
            'todo',
        ])
    })

    it('leaves a token after an unclosed fence as text, the way markdown reads it', () => {
        expect(shape('```\n::todo:abc123::', false)).toEqual(['md:```\n::todo:abc123::'])
    })

    it('keeps a lone backtick from swallowing the rest of the content', () => {
        expect(shape('a ` b ::todo:abc123::', false)).toEqual(['md:a ` b', 'todo'])
    })

    it('leaves a url inside a code block out of the link previews', () => {
        expect(shape('```\nhttps://example.com\n```')).toEqual(['md:```\nhttps://example.com\n```'])
    })
})

describe('stripEmbedTokens', () => {
    it('drops every kind of token, including one this build does not render', () => {
        expect(stripEmbedTokens('a ::todo:abc123:: ::canvas:abc123:: ::project:abc123:: ::doc:abc123:: [[abc123]] b')).toBe(
            'a      b',
        )
    })

    it('drops an agenda token, with or without a scope on it', () => {
        expect(stripEmbedTokens('a ::agenda:: b ::agenda:tasks:: c')).toBe('a  b  c')
    })

    it('drops a legacy moment token too', () => {
        expect(stripEmbedTokens('a [[moment_awjohd219uyqw9dq2]] b')).toBe('a  b')
    })
})

describe('excerpt', () => {
    it('flattens tokens and inline formatting to plain text', () => {
        expect(excerpt('::todo:abc123:: ==hot== ++take++ [in red]{color=red}')).toBe('hot take in red')
    })
})

import { describe, expect, it } from 'vitest'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import { emDashes, hardBreaks } from './MarkdownText'

// Everything in this app is typed into a textarea, where Shift+Enter ends a
// line. Markdown reads a single newline as a soft break and renders it as a
// space, so those lines came back joined onto the next one.

function render(markdown: string): HTMLElement {
    const container = document.createElement('div')
    container.innerHTML = micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
    hardBreaks(container)
    return container
}

const dashed = (markdown: string): HTMLElement => {
    const container = render(markdown)
    emDashes(container)
    return container
}

const DASH = '\u2014'

describe('hardBreaks', () => {
    it('breaks a line the author ended inside a paragraph', () => {
        const html = render('one\ntwo').innerHTML
        expect(html).toContain('<br>')
        expect(html).toBe('<p>one<br>two</p>')
    })

    it('leaves a paragraph break as a paragraph break', () => {
        // Two blocks, not one block with a blank line wedged into it.
        const container = render('one\n\ntwo')
        expect(container.querySelectorAll('p')).toHaveLength(2)
        expect(container.querySelectorAll('br')).toHaveLength(0)
    })

    it('breaks between two inline elements', () => {
        // The newline is the whole text node here, which is exactly the case a
        // blanket "skip whitespace-only nodes" rule would miss.
        expect(render('*one*\n*two*').innerHTML).toBe('<p><em>one</em><br><em>two</em></p>')
    })

    it('leaves the newlines inside a fenced code block alone', () => {
        const container = render('```\nfirst\nsecond\n```')
        expect(container.querySelectorAll('br')).toHaveLength(0)
        expect(container.querySelector('code')?.textContent).toBe('first\nsecond\n')
    })

    it('leaves inline code alone', () => {
        expect(render('`a b`').innerHTML).not.toContain('<br>')
    })

    it('does not break a list item away from its nested list', () => {
        // The newline between a tight item's text and its nested <ul> is the
        // renderer's own, and breaking on it adds a blank line indenting nothing.
        const container = render('- one\n    - nested')
        expect(container.querySelectorAll('br')).toHaveLength(0)
    })

    it('breaks inside a list item that wraps', () => {
        const container = render('- one\n  still one')
        expect(container.querySelectorAll('br')).toHaveLength(1)
    })

    it('breaks inside a blockquote', () => {
        // A heading cannot hold one: an ATX heading ends at the newline, so
        // `# one\ntwo` is a heading and a paragraph, and rightly stays that.
        expect(render('> one\n> two').innerHTML).toContain('<br>')
        expect(render('# one\ntwo').innerHTML).not.toContain('<br>')
    })

    it('is idempotent, because render() reruns on every content change', () => {
        const container = render('one\ntwo')
        const once = container.innerHTML
        hardBreaks(container)
        expect(container.innerHTML).toBe(once)
    })
})

// A keyboard has no key for a dash, so authors type two hyphens and expect one.
describe('emDashes', () => {
    it('turns a spaced double hyphen into a dash', () => {
        expect(dashed('one -- two').innerHTML).toBe(`<p>one ${DASH} two</p>`)
    })

    it('turns a joined double hyphen into a dash', () => {
        expect(dashed('one--two').innerHTML).toBe(`<p>one${DASH}two</p>`)
    })

    it('leaves a run of three or more hyphens alone', () => {
        // Three is a thematic break, a table rule, or a drawn line, and four is
        // whatever the author meant by four.
        expect(dashed('one --- two').innerHTML).toBe('<p>one --- two</p>')
        expect(dashed('one----two').innerHTML).toBe('<p>one----two</p>')
    })

    it('leaves a hyphen that is not doubled alone', () => {
        expect(dashed('well-known').innerHTML).toBe('<p>well-known</p>')
    })

    it('leaves inline code alone', () => {
        expect(dashed('`ls --all` and -- prose').innerHTML).toBe(`<p><code>ls --all</code> and ${DASH} prose</p>`)
    })

    it('leaves a fenced code block alone', () => {
        const container = dashed('```\nrm -- file\n```')
        expect(container.querySelector('code')?.textContent).toBe('rm -- file\n')
    })

    it('reaches a dash typed inside emphasis', () => {
        expect(dashed('*one -- two*').innerHTML).toBe(`<p><em>one ${DASH} two</em></p>`)
    })

    it('is idempotent, because render() reruns on every content change', () => {
        const container = dashed('one -- two, three--four')
        const once = container.innerHTML
        emDashes(container)
        expect(container.innerHTML).toBe(once)
    })
})

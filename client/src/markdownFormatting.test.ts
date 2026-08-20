import { describe, expect, it } from 'vitest'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import { inlineFormatting, inlineFormattingHtml, stripInlineFormatting } from './markdownFormatting'

// The three inline formats are a stored data format, so these tests pin the
// syntax as much as the output: content already written depends on the exact
// markers still meaning what they meant.

const render = (markdown: string): string =>
    micromark(markdown, {
        extensions: [gfm(), inlineFormatting()],
        htmlExtensions: [gfmHtml(), inlineFormattingHtml()],
    })

describe('highlight', () => {
    it('renders ==text== as a mark', () => {
        expect(render('a ==note== b')).toBe('<p>a <mark class="md-mark">note</mark> b</p>')
    })

    it('composes with the markdown inside it', () => {
        expect(render('==a **b**==')).toBe('<p><mark class="md-mark">a <strong>b</strong></mark></p>')
    })

    it('leaves a single marker alone', () => {
        expect(render('a = b')).toBe('<p>a = b</p>')
    })

    it('leaves three markers alone', () => {
        expect(render('===a===')).toBe('<p>===a===</p>')
    })

    it('leaves a code span alone', () => {
        expect(render('`==a==`')).toBe('<p><code>==a==</code></p>')
    })

    it('leaves a fenced code block alone', () => {
        expect(render('```\n==a==\n```')).toBe('<pre><code>==a==\n</code></pre>')
    })
})

describe('underline', () => {
    it('renders ++text++ as an underline', () => {
        expect(render('a ++note++ b')).toBe('<p>a <span class="md-underline">note</span> b</p>')
    })

    it('leaves a list marker alone', () => {
        expect(render('+ one\n+ two')).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>')
    })

    it('leaves a code span alone', () => {
        expect(render('`++a++`')).toBe('<p><code>++a++</code></p>')
    })
})

describe('color', () => {
    it('renders [text]{color=NAME} in a preset colour', () => {
        expect(render('[warn]{color=red}')).toBe('<p><span class="md-color md-color-red">warn</span></p>')
    })

    it('accepts every preset', () => {
        for (const color of ['red', 'orange', 'yellow', 'green', 'blue', 'purple']) {
            expect(render(`[a]{color=${color}}`)).toBe(`<p><span class="md-color md-color-${color}">a</span></p>`)
        }
    })

    it('leaves a colour outside the palette as text', () => {
        // The name lands in a class, so anything unrecognized has to fall all
        // the way back rather than be rendered with a name we did not choose.
        expect(render('[a]{color=fuchsia}')).toBe('<p>[a]{color=fuchsia}</p>')
        expect(render('[a]{color=RED}')).toBe('<p>[a]{color=RED}</p>')
    })

    it('composes with the markdown inside it, including a link', () => {
        expect(render('[**a** [b](https://x.test)]{color=blue}')).toBe(
            '<p><span class="md-color md-color-blue"><strong>a</strong> <a href="https://x.test">b</a></span></p>',
        )
    })

    it('leaves an ordinary link alone', () => {
        expect(render('[a](https://x.test)')).toBe('<p><a href="https://x.test">a</a></p>')
    })

    it('escapes html in the label, like the rest of the pipeline', () => {
        expect(render('[<img src=x onerror=alert(1)>]{color=red}')).toBe(
            '<p><span class="md-color md-color-red">&lt;img src=x onerror=alert(1)&gt;</span></p>',
        )
    })

    it('leaves a code span alone', () => {
        expect(render('`[a]{color=red}`')).toBe('<p><code>[a]{color=red}</code></p>')
    })
})

describe('stripInlineFormatting', () => {
    it('drops the markers and keeps the text', () => {
        expect(stripInlineFormatting('a ==b== ++c++ [d]{color=green}')).toBe('a b c d')
    })
})

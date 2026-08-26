import { createEffect, onMount, onCleanup, type Component } from 'solid-js'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import rehypeHighlight from 'rehype-highlight'
import { rehype } from 'rehype'
import { common } from 'lowlight'
import luau from 'highlightjs-luau'
import gdscript from '@exercism/highlightjs-gdscript'
import 'highlight.js/styles/atom-one-dark.css'
import { openLightbox, downloadHref } from '../lightbox'
import { inlineFormatting, inlineFormattingHtml } from '../markdownFormatting'
import { copyText } from '../clipboard'

// An image-only block is a <p> whose meaningful content is just image(s), the
// unit galleries are built from. Text or an <hr> (a `---` separator) breaks a
// run, so consecutive images group but a divider or prose splits them.
function isImageBlock(el: Element): boolean {
    if (el.tagName !== 'P' || !el.querySelector('img')) return false
    for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
            if ((node.textContent || '').trim() !== '') return false
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = (node as Element).tagName
            if (tag !== 'IMG' && tag !== 'BR') return false
        }
    }
    return true
}

// Group runs of consecutive image-only blocks (2+ images) into a horizontal
// scroll-snap gallery. Single images are left inline. Runs never cross an <hr>
// or any prose block.
function groupGalleries(container: HTMLElement): void {
    let run: Element[] = []
    const flush = () => {
        if (run.length > 0) {
            const imgs = run.flatMap((el) => Array.from(el.querySelectorAll('img')))
            if (imgs.length >= 2) {
                const gallery = document.createElement('div')
                gallery.className = 'md-gallery'
                imgs.forEach((im) => {
                    const item = document.createElement('div')
                    item.className = 'md-gallery-item'
                    im.remove()
                    item.appendChild(im)
                    gallery.appendChild(item)
                })
                container.insertBefore(gallery, run[0])
                run.forEach((el) => el.remove())
            }
        }
        run = []
    }
    for (const el of Array.from(container.children)) {
        if (isImageBlock(el)) run.push(el)
        else flush()
    }
    flush()
}

// Elements whose text content is inline all the way down, so every newline
// inside one came from the author rather than from the renderer's own layout of
// the HTML.
const TEXT_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, dd, dt, td, th, figcaption'

// Block-level tags, as the markdown renderer emits them. A newline sitting
// beside one of these separates two blocks and is the renderer's, not the
// author's.
const BLOCK_TAGS = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

const isBlock = (node: Node | null): boolean =>
    node instanceof Element && BLOCK_TAGS.has(node.tagName)

// A single newline is a *soft* break in markdown: it renders as a space, so a
// line the author ended with Shift+Enter comes back joined onto the next one.
// That is the right reading of the spec and the wrong reading of a textarea,
// which is what every piece of content in this app is typed into. Newlines
// inside a block become real breaks here.
//
// Done on the rendered tree rather than by rewriting the source with markdown's
// own two-trailing-spaces hard break, because that rewrite cannot tell prose
// from a fenced code block and corrupts the block.
export function hardBreaks(container: HTMLElement): void {
    for (const block of Array.from(container.querySelectorAll(TEXT_BLOCKS))) {
        // Code keeps its own newlines: <pre> renders them already, and a <br>
        // inside one is copied out as markup instead of as a line.
        if (block.closest('pre, code')) continue
        for (const text of Array.from(block.childNodes)) {
            if (text.nodeType !== Node.TEXT_NODE) continue
            const value = text.textContent ?? ''
            if (!value.includes('\n')) continue
            // The newline that separates a tight list item's text from its
            // nested list belongs to the renderer, not the author: breaking on
            // it indents nothing and leaves a blank line above the sublist. Any
            // newline touching a block sibling is one of those.
            let inner = value
            if (isBlock(text.previousSibling)) inner = inner.replace(/^\n/, '')
            if (isBlock(text.nextSibling)) inner = inner.replace(/\n$/, '')
            if (!inner.includes('\n')) {
                if (inner !== value) text.textContent = inner
                continue
            }

            const parts = inner.split('\n')
            const fragment = document.createDocumentFragment()
            parts.forEach((part, i) => {
                if (i > 0) fragment.appendChild(document.createElement('br'))
                if (part) fragment.appendChild(document.createTextNode(part))
            })
            ;(text as ChildNode).replaceWith(fragment)
        }
    }
}

// Every uploaded image gets a download button in its corner. Images render
// inline through the markdown pipeline and have no chip, and the Lightbox's
// download is one icon in a toolbar; this puts the original file next to the
// picture itself. The anchor carries the download attribute for the same
// reason the attachment chip does: it is what the router's anchor interceptor
// checks before deciding a click is a route change rather than a file to save.
// Idempotent, since render() rebuilds the tree and runs this after it.
function attachImageDownloads(container: HTMLElement): void {
    for (const img of Array.from(container.querySelectorAll('img'))) {
        if (img.parentElement?.classList.contains('md-img-download-wrap')) continue
        // External images are not uploads; leave them alone.
        if (!img.src.includes('/api/v1/assets/')) continue
        const wrap = document.createElement('span')
        wrap.className = 'md-img-download-wrap'
        img.replaceWith(wrap)
        wrap.appendChild(img)
        const link = document.createElement('a')
        link.className = 'md-img-download'
        link.href = downloadHref(img.src)
        link.download = ''
        link.title = 'Download'
        link.setAttribute('aria-label', 'Download image')
        link.innerHTML = '<span class="material-symbols-outlined">download</span>'
        wrap.appendChild(link)
    }
}

// A keyboard has no em dash key, so the double hyphen is how one gets typed,
// and markdown has no opinion about it: `a -- b` renders as the two hyphens the
// author could not avoid typing. Both the spaced form and the joined
// `word--word` form become the dash; three or more hyphens are left alone,
// since that is a thematic break, a table rule, or someone drawing a line.
//
// Done on the rendered tree rather than on the source for the same reason
// hardBreaks is: a source rewrite cannot tell prose from a code block. Here the
// skip is free, because code has its own elements to be recognized by.
// Idempotent, since the pass leaves no `--` behind for a second run to find,
// which matters because render() runs on every content change.
const SPACED_DOUBLE_HYPHEN = /(\s)--(?=\s)/g
const JOINED_DOUBLE_HYPHEN = /(\w)--(?=\w)/g
// Escaped, not literal: CI rejects the character itself anywhere in the tree.
const EM_DASH = '\u2014'

export function emDashes(container: HTMLElement): void {
    for (const block of Array.from(container.querySelectorAll(TEXT_BLOCKS))) {
        if (block.closest('pre, code')) continue
        // Every text node under the block, not just its direct children: a
        // dash typed inside emphasis or a link is still a dash.
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            // Code spans keep what the author typed, wherever they sit.
            if (text.parentElement?.closest('pre, code')) continue
            const value = text.textContent ?? ''
            if (!value.includes('--')) continue
            const dashed = value
                .replace(SPACED_DOUBLE_HYPHEN, `$1${EM_DASH}`)
                .replace(JOINED_DOUBLE_HYPHEN, `$1${EM_DASH}`)
            if (dashed !== value) text.textContent = dashed
        }
    }
}

// Give every table its own horizontal scroll box. A table is sized by its
// content and has no way to shrink, so a wide one escapes the moment card and
// scrolls the entire Moments column sideways; scrolling it in place keeps the
// overflow where it belongs. Idempotent, so re-running over already-wrapped
// markup is a no-op, which matters because render() runs on every content
// change.
function wrapTables(container: HTMLElement): void {
    for (const table of Array.from(container.querySelectorAll('table'))) {
        if (table.parentElement?.classList.contains('md-table-wrap')) continue
        const wrap = document.createElement('div')
        wrap.className = 'md-table-wrap'
        table.replaceWith(wrap)
        wrap.appendChild(table)
    }
}

// lowlight's `common` subset (~35 languages) covers the mainstream languages
// but ships neither Luau (Roblox) nor GDScript (Godot); both are registered
// here from their dedicated highlight.js grammar packages since core
// highlight.js doesn't include them. `gdscript` also self-aliases to `godot`.
const languages = { ...common, luau, gdscript }

// MarkdownText renders markdown content to HTML using micromark + GFM, then
// runs rehype-highlight for syntax highlighting in fenced code blocks. The
// rendered HTML is injected via innerHTML; the source is server-controlled
// moment content, but it is sanitized on the way through micromark's HTML
// output (micromark escapes raw HTML by default).
//
// Reference: v1's FancyTextRenderer.tsx for the rendering pipeline. v2 drops
// the v1 attachment/reference extraction (no inline moment references in v2
// yet) and the IntersectionObserver lazy-render (moments are already paginated
// and small in number).
export interface MarkdownTextProps {
    content: string
    class?: string
}

export const MarkdownText: Component<MarkdownTextProps> = (props) => {
    let containerRef: HTMLDivElement | undefined

    const render = () => {
        if (!containerRef) return
        const raw = micromark(props.content || '', {
            extensions: [gfm(), inlineFormatting()],
            htmlExtensions: [gfmHtml(), inlineFormattingHtml()],
        })
        // rehype-highlight operates on HAST; we feed it the parsed HTML and
        // take back a serialized string. This keeps the v1 pipeline shape
        // (micromark -> highlight) without pulling in a full rehype string
        // parser: rehype.parse + rehype.stringify are bundled with the
        // rehype package.
        const file = rehype()
            .use(rehypeHighlight, { languages })
            .processSync({ value: raw })
        containerRef.innerHTML = String(file)
        // Before the gallery pass, which already expects to meet a <br> in an
        // image-only block (see isImageBlock).
        hardBreaks(containerRef)
        emDashes(containerRef)
        groupGalleries(containerRef)
        wrapTables(containerRef)
        attachImageDownloads(containerRef)
    }

    // Delegated click: any content image opens the Lightbox with the full set
    // of images in this block so the viewer can navigate across them.
    const onImageClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement
        if (!(target instanceof HTMLImageElement) || !containerRef?.contains(target)) return
        const imgs = Array.from(containerRef.querySelectorAll('img'))
        const at = imgs.indexOf(target)
        openLightbox(
            imgs.map((im) => ({ src: im.currentSrc || im.src, alt: im.alt })),
            at < 0 ? 0 : at,
        )
    }

    // Re-render on content change.
    createEffect(() => {
        const _ = props.content
        render()
    })

    // Wire up copy buttons on code blocks after each render, matching v1's
    // FancyTextRenderer affordance.
    const attachCopyButtons = () => {
        if (!containerRef) return
        const preBlocks = containerRef.querySelectorAll('pre')
        preBlocks.forEach((pre) => {
            if (pre.querySelector('.copy-btn')) return
            const codeBlock = pre.querySelector('code')
            if (!codeBlock) return

            const btn = document.createElement('button')
            // Visibility is CSS (.copy-btn in index.css), which keeps the button
            // on screen where there is no hover to reveal it.
            btn.className =
                'copy-btn absolute top-2 right-2 bg-element/80 hover:bg-highlight text-sub hover:text-plain px-2 py-1 rounded text-xs font-bold transition-all duration-200'
            btn.innerText = 'COPY'
            btn.title = 'Copy to clipboard'

            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                void copyText(codeBlock.textContent || '').then((done) => {
                    // Only a copy that happened gets to say so. On a server
                    // reached over plain http the browser may withhold the
                    // clipboard entirely, and a button that claims otherwise
                    // is worse than one that admits it.
                    btn.innerText = done ? 'COPIED!' : 'NO'
                    btn.title = done ? 'Copy to clipboard' : 'This browser would not give up the clipboard'
                    btn.classList.replace('bg-element/80', done ? 'bg-highlight-strong' : 'bg-danger')
                    setTimeout(() => {
                        btn.innerText = 'COPY'
                        btn.title = 'Copy to clipboard'
                        btn.classList.replace(done ? 'bg-highlight-strong' : 'bg-danger', 'bg-element/80')
                    }, 2000)
                })
            })

            pre.classList.add('relative', 'max-h-[75vh]', 'overflow-x-auto')
            pre.appendChild(btn)
        })
    }

    // Mutation observer is overkill here; we just re-run after each render
    // via the effect above. Use a microtask to ensure DOM is updated.
    let mo: MutationObserver | undefined
    onMount(() => {
        render()
        attachCopyButtons()
        if (containerRef) {
            mo = new MutationObserver(() => attachCopyButtons())
            mo.observe(containerRef, { childList: true, subtree: true })
            containerRef.addEventListener('click', onImageClick)
        }
    })
    onCleanup(() => {
        mo?.disconnect()
        containerRef?.removeEventListener('click', onImageClick)
    })

    // prose-p:my-3: paragraph spacing has to read as a paragraph break. At
    // my-1 the gap was 4px against a 20px line-height, so a blank line typed in
    // the composer came out narrower than a quarter of a line and consecutive
    // paragraphs ran together as one block. 12px separates them clearly while
    // staying tighter than the typography plugin's airy 1.25em default, which
    // matters because chat messages render through this same component.
    //
    // [&>*:first-child]:!mt-0 / [&>*:last-child]:!mb-0: that my-3 is trapped
    // inside a flex item in ChatPanel (items-start), so it can't collapse out
    // against the sibling message's own grouping margin. Left alone, every
    // chat message carries a bonus 12px above and below itself no matter how
    // tight ChatPanel's own same-author/same-minute grouping margin is. Zeroing
    // just the outer edges leaves in-message paragraph breaks untouched while
    // letting ChatPanel's grouping margin be the only gap between messages.
    //
    // break-words: an unbreakable run of characters (a pasted URL is the
    // common one, and GFM autolinks it into a single <a>) has no wrap
    // opportunity, so it renders at its full width and overflows whatever
    // column it lands in. That goes unnoticed in the wide feed but gives the
    // narrow docked chat widget (and with it the whole Menu column) a
    // horizontal scrollbar. overflow-wrap: break-word only kicks in for words
    // that would otherwise overflow, so ordinary prose still wraps at spaces.
    return (
        <div
            ref={containerRef}
            class={`prose max-w-none break-words prose-p:my-3 prose-headings:my-2 prose-pre:my-2 [&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0 prose-pre:bg-element-matte prose-pre:p-3 prose-pre:border prose-pre:border-element-accent prose-pre:rounded-lg prose-img:rounded-lg prose-img:border prose-img:border-element-accent prose-a:text-highlight-strongest prose-a:underline prose-strong:text-md-strong prose-code:text-sub prose-code:bg-element-accent prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none ${props.class || ''}`}
        />
    )
}

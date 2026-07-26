import { createEffect, onMount, onCleanup, type Component } from 'solid-js'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import rehypeHighlight from 'rehype-highlight'
import { rehype } from 'rehype'
import { common } from 'lowlight'
import luau from 'highlightjs-luau'
import gdscript from '@exercism/highlightjs-gdscript'
import 'highlight.js/styles/atom-one-dark.css'
import { openLightbox } from '../lightbox'

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
            extensions: [gfm()],
            htmlExtensions: [gfmHtml()],
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
        groupGalleries(containerRef)
        wrapTables(containerRef)
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
                navigator.clipboard.writeText(codeBlock.textContent || '')
                btn.innerText = 'COPIED!'
                btn.classList.replace('bg-element/80', 'bg-highlight-strong')
                setTimeout(() => {
                    btn.innerText = 'COPY'
                    btn.classList.replace('bg-highlight-strong', 'bg-element/80')
                }, 2000)
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
            class={`prose max-w-none break-words prose-p:my-3 prose-headings:my-2 prose-pre:my-2 [&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0 prose-pre:bg-element-matte prose-pre:p-3 prose-pre:border prose-pre:border-element-accent prose-pre:rounded-lg prose-img:rounded-lg prose-img:border prose-img:border-element-accent prose-a:text-highlight-strongest prose-a:underline prose-strong:text-md-strong prose-h1:text-md-heading prose-h2:text-md-heading prose-h3:text-md-heading prose-code:text-sub prose-code:bg-element-accent prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none ${props.class || ''}`}
        />
    )
}

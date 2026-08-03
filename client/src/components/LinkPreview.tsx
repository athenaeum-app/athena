import { createSignal, For, onMount, Show, type Component } from 'solid-js'
import { api } from '../api'
import { prefs } from '../prefs'
import { findBareUrls } from '../linkPreviews'
import { viewportWidth } from '../viewport'

interface LinkPreviewData {
    url: string
    title: string
    description: string
    image_url: string
    scraped_at: string
}

// How much room a card is being given, which decides where its image goes.
//
//   compact  the original narrow card, used by the stack below the body
//   wide     a row of one: full width, image beside the text
//   tile     a row of several: image on top, so the text is not squeezed into
//            a column narrower than one word
export type PreviewLayout = 'compact' | 'wide' | 'tile'

const SHELL: Record<PreviewLayout, string> = {
    compact: 'max-w-md flex-col gap-2 p-3',
    wide: 'w-full flex-col gap-2 p-3',
    tile: 'h-full w-full flex-col gap-2 p-2',
}

// LinkPreviewCard fetches and renders a rich preview card for a single URL.
// Previews are cached server-side (link_previews table) with a TTL; the
// client just calls GET /api/v1/previews?url=... and renders the result.
// Reference: v1's AttachmentPreview.tsx and InlineReference.tsx.
export const LinkPreviewCard: Component<{ url: string; layout?: PreviewLayout }> = (props) => {
    const [preview, setPreview] = createSignal<LinkPreviewData | null>(null)
    const [loading, setLoading] = createSignal(false)
    const [failed, setFailed] = createSignal(false)

    const layout = () => props.layout ?? 'compact'

    onMount(() => {
        setLoading(true)
        api.getPreview(props.url)
            .then((p) => setPreview(p))
            .catch(() => setFailed(true))
            .finally(() => setLoading(false))
    })

    const hostname = () => {
        try {
            return new URL(props.url).hostname.replace(/^www\./, '')
        } catch {
            return props.url
        }
    }

    return (
        <a
            href={props.url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="link-preview"
            data-layout={layout()}
            class={`bg-element-matte border-element-accent hover:border-highlight flex rounded-xl border transition-all hover:scale-[1.01] no-underline ${SHELL[layout()]}`}
        >
            <Show when={loading()}>
                <div class="text-sub text-xs italic">Loading preview...</div>
            </Show>
            <Show when={failed()}>
                <div class="text-sub text-xs break-words">
                    <span class="font-bold">{hostname()}</span>
                    <span class="ml-1 opacity-60">(preview unavailable)</span>
                </div>
            </Show>
            <Show when={preview()}>
                <Show
                    when={layout() === 'tile'}
                    fallback={
                        <div class="flex gap-3">
                            <Show when={preview()!.image_url}>
                                <img
                                    src={preview()!.image_url}
                                    alt=""
                                    class={`shrink-0 rounded-lg object-cover ${layout() === 'wide' ? 'h-20 w-20' : 'h-16 w-16'}`}
                                    referrerpolicy="no-referrer"
                                />
                            </Show>
                            <div class="flex min-w-0 flex-col gap-1">
                                <Show when={preview()!.title}>
                                    <span
                                        class={`text-main font-bold line-clamp-2 ${layout() === 'wide' ? 'text-base' : 'text-sm'}`}
                                    >
                                        {preview()!.title}
                                    </span>
                                </Show>
                                <Show when={preview()!.description}>
                                    <span
                                        class={`text-sub line-clamp-2 ${layout() === 'wide' ? 'text-sm' : 'text-xs'}`}
                                    >
                                        {preview()!.description}
                                    </span>
                                </Show>
                                <span class="text-highlight text-xs font-semibold">{hostname()}</span>
                            </div>
                        </div>
                    }
                >
                    <Show when={preview()!.image_url}>
                        <img
                            src={preview()!.image_url}
                            alt=""
                            class="aspect-video max-h-40 w-full rounded-lg object-cover"
                            referrerpolicy="no-referrer"
                        />
                    </Show>
                    <div class="flex min-w-0 flex-col gap-0.5 px-1 pb-1">
                        <Show when={preview()!.title}>
                            <span class="text-main text-sm font-bold line-clamp-2">{preview()!.title}</span>
                        </Show>
                        <Show when={preview()!.description}>
                            <span class="text-sub text-xs line-clamp-2">{preview()!.description}</span>
                        </Show>
                        <span class="text-highlight text-xs font-semibold truncate">{hostname()}</span>
                    </div>
                </Show>
            </Show>
        </a>
    )
}

// A run of links that appeared back to back in the content, rendered as one row.
//
// Cards grow rather than sitting at a fixed width, so a run that does not divide
// evenly by the row limit spreads its remainder across the last row instead of
// leaving a ragged gap: four links at three per row give a row of three and one
// full-width card, not three and a stub.
export const LinkPreviewRow: Component<{ urls: string[] }> = (props) => {
    // The pref is a ceiling, not a promise. Three cards across a phone are three
    // columns of ellipsis, so the row also has to fit the screen it is on. The
    // divisor is the narrowest a card can get and still show a title; the feed
    // column is only a fraction of the viewport, which is why it is this large.
    const affordable = () => Math.max(1, Math.floor(viewportWidth() / 480))
    const perRow = () =>
        Math.min(props.urls.length, prefs().inlineLinkPreviewsPerRow, affordable())

    // Matches gap-2 below. Kept in the basis so N cards plus their gaps come to
    // exactly one row rather than wrapping one card early.
    const basis = () => `calc((100% - ${perRow() - 1} * 0.5rem) / ${perRow()})`

    // A card left over on the last row is stretched to the full width, and a
    // banner image at that size swallows the moment it belongs to. Give it the
    // side-thumbnail treatment instead, which is what that width is shaped for.
    const layoutFor = (index: number): PreviewLayout => {
        const per = perRow()
        if (per === 1) return 'wide'
        const lastRowCount = props.urls.length % per || per
        const inLastRow = index >= props.urls.length - lastRowCount
        return inLastRow && lastRowCount === 1 ? 'wide' : 'tile'
    }

    return (
        <div class="flex w-full flex-wrap items-stretch gap-2" data-testid="link-preview-row">
            <For each={props.urls}>
                {(url, i) => (
                    <div class="min-w-0 flex" style={{ flex: `1 1 ${basis()}` }}>
                        <LinkPreviewCard url={url} layout={layoutFor(i())} />
                    </div>
                )}
            </For>
        </div>
    )
}

// LinkPreviewList scans rendered markdown content for external URLs and
// renders a preview card for each unique one. Used as a sibling below the
// MarkdownText component in the Feed.
//
// With inline previews on, MomentBody has already placed every bare URL, so this
// drops to the leftovers: URLs that only ever appeared somewhere they could not
// be replaced. Without that, turning the setting on would silently lose the
// preview for a link written as `[label](url)`.
export const LinkPreviewList: Component<{ content: string }> = (props) => {
    const urls = () => {
        const all = extractUrls(props.content || '')
        if (!prefs().inlineLinkPreviews) return all
        const placed = new Set(findBareUrls(props.content || '').map((u) => u.url))
        return all.filter((url) => !placed.has(url))
    }

    return (
        <Show when={urls().length > 0}>
            <div class="flex flex-col gap-2 mt-2">
                <For each={urls()}>{(url) => <LinkPreviewCard url={url} />}</For>
            </div>
        </Show>
    )
}

// extractUrls returns the unique http(s) URLs appearing in the given markdown
// content. It avoids matching URLs that are already wrapped in markdown image
// syntax `![...](url)` or asset URLs (which are local `/api/v1/assets/...`).
export function extractUrls(content: string): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    // Match http(s) URLs that are not preceded by `![` or `](` (image/link
    // destinations are skipped because they're already rendered inline),
    // checked by hand rather than with a lookbehind: WebKit only supports
    // lookbehind from 16.4, and one here blanked the chat list on older iOS.
    const re = /https?:\/\/[^\s<>"')]+/gi
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
        const before = content[match.index - 1]
        if (before === ']' || before === '!' || before === ')') continue
        let url = match[0]
        // Strip trailing punctuation that's unlikely to be part of the URL.
        url = url.replace(/[.,;:!?)]+$/, '')
        if (url.startsWith('/api/v1/assets/')) continue
        if (seen.has(url)) continue
        seen.add(url)
        out.push(url)
    }
    return out
}

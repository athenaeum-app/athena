import { createSignal, For, onMount, Show, type Component } from 'solid-js'
import { api } from '../api'

interface LinkPreviewData {
    url: string
    title: string
    description: string
    image_url: string
    scraped_at: string
}

// LinkPreviewCard fetches and renders a rich preview card for a single URL.
// Previews are cached server-side (link_previews table) with a TTL; the
// client just calls GET /api/v1/previews?url=... and renders the result.
// Reference: v1's AttachmentPreview.tsx and InlineReference.tsx.
export const LinkPreviewCard: Component<{ url: string }> = (props) => {
    const [preview, setPreview] = createSignal<LinkPreviewData | null>(null)
    const [loading, setLoading] = createSignal(false)
    const [failed, setFailed] = createSignal(false)

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
            class="bg-element-matte border-element-accent hover:border-highlight flex max-w-md flex-col gap-2 rounded-xl border p-3 transition-all hover:scale-[1.01] no-underline"
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
                <div class="flex gap-3">
                    <Show when={preview()!.image_url}>
                        <img
                            src={preview()!.image_url}
                            alt=""
                            class="h-16 w-16 shrink-0 rounded-lg object-cover"
                            referrerpolicy="no-referrer"
                        />
                    </Show>
                    <div class="flex min-w-0 flex-col gap-1">
                        <Show when={preview()!.title}>
                            <span class="text-main text-sm font-bold line-clamp-2">
                                {preview()!.title}
                            </span>
                        </Show>
                        <Show when={preview()!.description}>
                            <span class="text-sub text-xs line-clamp-2">
                                {preview()!.description}
                            </span>
                        </Show>
                        <span class="text-highlight text-xs font-semibold">{hostname()}</span>
                    </div>
                </div>
            </Show>
        </a>
    )
}

// LinkPreviewList scans rendered markdown content for external URLs and
// renders a preview card for each unique one. Used as a sibling below the
// MarkdownText component in the Feed.
export const LinkPreviewList: Component<{ content: string }> = (props) => {
    const urls = () => extractUrls(props.content || '')

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
function extractUrls(content: string): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    // Match http(s) URLs that are not preceded by `![` or `](` (image/link
    // destinations are skipped because they're already rendered inline).
    // The negative lookbehind avoids double-counting URLs that appear both
    // as link text and as a bare URL.

    const re = /(?<![\]!)])https?:\/\/[^\s<>"')]+/gi
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
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

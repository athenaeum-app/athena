import { For, Show, createMemo, createSignal, onMount, type Component } from 'solid-js'
import { api, type AssetMeta } from '../api'
import { openLightbox, type LightboxItem } from '../lightbox'

// AttachmentList: scans moment/chat content for non-image asset
// references and renders them as file chips (type icon + name + size +
// download) with an inline preview for known types (PDF / audio / video).
// Images are left to render inline via the markdown pipeline, so they're
// skipped here to avoid showing twice.
//
// Video is the exception to the chip treatment. A video is something you watch,
// not a file you fetch (the same as an image), so it leads with the player and
// keeps the name/size/download as a caption underneath, and clicking it opens
// the Lightbox with every video in the same block, mirroring how an image opens
// with every image in its block. It can't ride the markdown path images use:
// `![](…)` renders an <img>, which cannot play a video, and nothing in the
// content says which assets are videos. Only the asset metadata does, and that
// is fetched here.

const ASSET_RE = /(!)?\[[^\]]*\]\((\/api\/v1\/assets\/[0-9a-fA-F-]{6,})\)/g

// Returns the unique non-image asset URLs referenced in the content.
function extractAttachments(content: string): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    let m: RegExpExecArray | null
    ASSET_RE.lastIndex = 0
    while ((m = ASSET_RE.exec(content)) !== null) {
        const isImageSyntax = m[1] === '!'
        const url = m[2]
        if (isImageSyntax) continue // rendered inline by markdown already
        if (seen.has(url)) continue
        seen.add(url)
        out.push(url)
    }
    return out
}

const humanSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    const units = ['KB', 'MB', 'GB']
    let n = bytes / 1024
    let i = 0
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024
        i++
    }
    return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

// Video extensions the server may have recorded as application/octet-stream.
// It resolved MIME types from the host's database until now, and the runtime
// image has none, so every .mov (what phones record), .mkv, .avi and .m4v
// already in a library is stored as "some file". The server no longer does
// that, but rows written before the fix keep their old value. Falling back to
// the file's own name is what makes those play without a database repair.
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|avi|webm|ogv|3gp|mpe?g)$/i

export const looksLikeVideo = (mimeType: string, fileName: string): boolean => {
    if (mimeType.startsWith('video/')) return true
    if (mimeType && mimeType !== 'application/octet-stream') return false
    return VIDEO_EXTENSIONS.test(fileName)
}

const iconFor = (mime: string): string => {
    if (mime.startsWith('audio/')) return 'audio_file'
    if (mime.startsWith('video/')) return 'video_file'
    if (mime === 'application/pdf') return 'picture_as_pdf'
    if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml')) return 'description'
    if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) return 'folder_zip'
    return 'draft'
}

export const AttachmentList: Component<{ content: string }> = (props) => {
    const urls = createMemo(() => extractAttachments(props.content || ''))

    // Which of this block's attachments turned out to be videos, so opening one
    // can hand the Lightbox all of them. Attachments resolve their metadata
    // independently and asynchronously, so they report back here as they land;
    // keyed by url and read in `urls()` order, which keeps the carousel in the
    // order they appear rather than the order the requests happened to finish.
    const [videos, setVideos] = createSignal<Record<string, LightboxItem>>({})
    const registerVideo = (url: string, item: LightboxItem) =>
        setVideos((prev) => ({ ...prev, [url]: item }))

    const openVideo = (url: string) => {
        const known = videos()
        const ordered = urls()
            .map((u) => known[u])
            .filter((item): item is LightboxItem => !!item)
        const at = ordered.findIndex((item) => item.src === url)
        openLightbox(ordered, at < 0 ? 0 : at)
    }

    return (
        <Show when={urls().length > 0}>
            <div class="mt-2 flex flex-col gap-2">
                <For each={urls()}>
                    {(url) => <Attachment url={url} onVideoResolved={registerVideo} onOpenVideo={openVideo} />}
                </For>
            </div>
        </Show>
    )
}

const Attachment: Component<{
    url: string
    onVideoResolved: (url: string, item: LightboxItem) => void
    onOpenVideo: (url: string) => void
}> = (props) => {
    const [meta, setMeta] = createSignal<AssetMeta | null>(null)
    const [failed, setFailed] = createSignal(false)
    const id = () => props.url.split('/').pop() || ''

    onMount(async () => {
        try {
            const meta = await api.getAssetMeta(id())
            setMeta(meta)
            if (looksLikeVideo(meta.mime_type || '', meta.file_name || '')) {
                props.onVideoResolved(props.url, { src: props.url, alt: meta.file_name, kind: 'video' })
            }
        } catch {
            setFailed(true)
        }
    })

    const mime = () => meta()?.mime_type || ''
    const isPdf = () => mime() === 'application/pdf'
    const isAudio = () => mime().startsWith('audio/')
    const isVideo = () => looksLikeVideo(mime(), meta()?.file_name || '')
    const name = () => meta()?.file_name || 'Attachment'
    const downloadUrl = () => `${props.url}?download=1`

    const Caption = () => (
        <div class="flex items-center gap-2 p-2">
            <span class="material-symbols-outlined text-highlight text-xl">
                {isVideo() ? 'video_file' : iconFor(mime())}
            </span>
            <div class="min-w-0 flex-1">
                <div class="text-main truncate text-sm font-bold">{name()}</div>
                <Show when={meta()}>
                    <div class="text-sub text-xs break-words">
                        {humanSize(meta()!.size_bytes)}
                        {mime() ? ` · ${mime()}` : ''}
                    </div>
                </Show>
                <Show when={failed()}>
                    <div class="text-sub text-xs italic">Attachment unavailable</div>
                </Show>
            </div>
            <Show when={isVideo()}>
                <button
                    type="button"
                    onClick={() => props.onOpenVideo(props.url)}
                    class="bg-element-accent text-sub hover:text-main flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-bold hover:cursor-pointer"
                    title="View full screen"
                >
                    <span class="material-symbols-outlined text-sm">fullscreen</span>
                    Expand
                </button>
            </Show>
            <a
                href={downloadUrl()}
                class="bg-element-accent text-sub hover:text-main flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-bold"
                title="Download"
            >
                <span class="material-symbols-outlined text-sm">download</span>
                Download
            </a>
        </div>
    )

    return (
        <div class="bg-element-matte border-element-accent overflow-hidden rounded-lg border">
            {/* Video leads with the player and captions it, the way an image
                block reads. Everything else keeps the chip-then-preview order. */}
            <Show when={isVideo()}>
                <video
                    controls
                    preload="metadata"
                    playsinline
                    src={props.url}
                    class="max-h-96 w-full bg-black"
                />
            </Show>

            <Caption />

            <Show when={isPdf()}>
                <iframe src={props.url} class="h-96 w-full border-0" title={name()} />
            </Show>
            <Show when={isAudio()}>
                <audio controls src={props.url} class="w-full px-2 pb-2" />
            </Show>
        </div>
    )
}

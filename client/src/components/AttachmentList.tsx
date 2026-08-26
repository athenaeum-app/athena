import { For, Show, createMemo, createSignal, onMount, type Component } from 'solid-js'
import { api, type AssetMeta } from '../api'
import { openLightbox, type LightboxItem } from '../lightbox'
import { prefs } from '../prefs'
import { viewportWidth } from '../viewport'

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

// A player's share of the row it is on. `perRow` of 1 is the full-width player
// this list has always rendered; anything higher is a tile in a row of that
// many.
export interface VideoSlot {
    perRow: number
    tile: boolean
}

const FULL: VideoSlot = { perRow: 1, tile: false }

// Which players share a row, given what turned out to be a video and the user's
// row limit. Only videos that were attached back to back are grouped, so a PDF
// between two clips still breaks the row and nothing is reordered to fill one.
//
// A run that does not divide evenly leaves its last row short, and a single
// leftover is widened instead of sitting as a stub beside empty space. That is
// the same shape a run of link previews takes, deliberately: they are the same
// decision about the same column.
export function planVideoSlots(isVideo: boolean[], limit: number): VideoSlot[] {
    const slots: VideoSlot[] = isVideo.map(() => FULL)
    let at = 0
    while (at < isVideo.length) {
        if (!isVideo[at]) {
            at++
            continue
        }
        let end = at
        while (end < isVideo.length && isVideo[end]) end++
        const runLength = end - at
        const perRow = Math.max(1, Math.min(runLength, limit))
        if (perRow > 1) {
            const lastRowCount = runLength % perRow || perRow
            for (let i = 0; i < runLength; i++) {
                const inLastRow = i >= runLength - lastRowCount
                slots[at + i] = inLastRow && lastRowCount === 1 ? FULL : { perRow, tile: true }
            }
        }
        at = end
    }
    return slots
}

// The narrowest a tile may get. The pref is a ceiling, not a promise: four
// players across a phone are four thumbnails, so the row has to fit the screen
// it is on as well.
const TILE_FLOOR_PX = 320

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

    const affordable = () => Math.max(1, Math.floor(viewportWidth() / TILE_FLOOR_PX))
    const slots = createMemo(() =>
        planVideoSlots(
            urls().map((url) => !!videos()[url]),
            Math.min(prefs().videosPerRow, affordable()),
        ),
    )

    return (
        <Show when={urls().length > 0}>
            {/* Wrapping, not a column: a full-width slot takes a line of its
                own, so the rows fall out of the slot widths without anything
                having to group the items into row elements. */}
            <div class="mt-2 flex flex-wrap items-stretch gap-2" data-testid="attachment-list">
                <For each={urls()}>
                    {(url, i) => {
                        const slot = () => slots()[i()] ?? FULL
                        // Matches gap-2, so N tiles plus their gaps come to
                        // exactly one row rather than wrapping one tile early.
                        const basis = () =>
                            slot().perRow === 1
                                ? '100%'
                                : `calc((100% - ${slot().perRow - 1} * 0.5rem) / ${slot().perRow})`
                        return (
                            <div class="flex min-w-0" style={{ flex: `1 1 ${basis()}` }}>
                                <Attachment
                                    url={url}
                                    tile={slot().tile}
                                    onVideoResolved={registerVideo}
                                    onOpenVideo={openVideo}
                                />
                            </div>
                        )
                    }}
                </For>
            </div>
        </Show>
    )
}

const Attachment: Component<{
    url: string
    // Sharing its row with other players, so it gets a shorter player and a
    // caption that may wrap.
    tile?: boolean
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
        // Wrapping, with a floor under the name. The buttons cannot shrink, so
        // on any caption too narrow to hold all three the name was squeezed to
        // a column of single letters instead: a tile at four across, and the
        // phone reader long before this pref existed.
        <div class="flex flex-wrap items-center gap-2 p-2">
            <span class="material-symbols-outlined text-highlight text-xl">
                {isVideo() ? 'video_file' : iconFor(mime())}
            </span>
            <div class="min-w-[7rem] flex-1">
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
            {/* Kept together, so a tile that cannot fit them beside the name
                drops both onto the next line rather than splitting them. */}
            <div class="flex shrink-0 items-center gap-2">
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
                    // download is what stops the router's anchor interceptor
                    // from treating the click as a route change: an anchor
                    // without it is preventDefault-ed and client-side-navigated
                    // to the asset URL, which renders this same app. With it,
                    // the browser saves the file the server names in
                    // Content-Disposition.
                    download=""
                    class="bg-element-accent text-sub hover:text-main flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-bold"
                    title="Download"
                >
                    <span class="material-symbols-outlined text-sm">download</span>
                    Download
                </a>
            </div>
        </div>
    )

    return (
        <div
            class="bg-element-matte border-element-accent flex h-full w-full min-w-0 flex-col overflow-hidden rounded-lg border"
            data-testid="attachment"
            data-tile={props.tile ? 'true' : 'false'}
        >
            {/* Video leads with the player and captions it, the way an image
                block reads. Everything else keeps the chip-then-preview order. */}
            <Show when={isVideo()}>
                <video
                    controls
                    preload="metadata"
                    playsinline
                    src={props.url}
                    class={`w-full bg-black ${props.tile ? 'max-h-56' : 'max-h-96'}`}
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

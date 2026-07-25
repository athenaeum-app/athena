import { createSignal } from 'solid-js'

// A tiny global store for the media Lightbox (ADR: image viewing). Any content
// image click opens it with the full set of images in that block so the viewer
// can navigate across them (the "view carousel" experience); a video attachment
// opens it the same way, with the videos in its block. One <Lightbox/> is
// mounted at the app root and reads this store.

export interface LightboxItem {
    src: string
    alt?: string
    // Images are the overwhelming majority and predate this field, so an
    // absent kind means image.
    kind?: 'image' | 'video'
}

// Kept as an alias: the old name is what most callers pass, and an image is
// still what most items are.
export type LightboxImage = LightboxItem

const [items, setItems] = createSignal<LightboxItem[]>([])
const [index, setIndex] = createSignal(0)
const [open, setOpen] = createSignal(false)

export const lightboxOpen = open
export const lightboxImages = items
export const lightboxIndex = index

export function openLightbox(next: LightboxItem[], at = 0): void {
    if (next.length === 0) return
    setItems(next)
    setIndex(Math.max(0, Math.min(at, next.length - 1)))
    setOpen(true)
}

export function closeLightbox(): void {
    setOpen(false)
}

export function lightboxNext(): void {
    const count = items().length
    if (count > 0) setIndex((i) => (i + 1) % count)
}

export function lightboxPrev(): void {
    const count = items().length
    if (count > 0) setIndex((i) => (i - 1 + count) % count)
}

export function lightboxGo(i: number): void {
    const count = items().length
    if (i >= 0 && i < count) setIndex(i)
}

// Asset URLs support ?download=1 to force a download with the original name.
export function downloadHref(src: string): string {
    if (src.includes('/api/v1/assets/')) {
        return src + (src.includes('?') ? '&' : '?') + 'download=1'
    }
    return src
}

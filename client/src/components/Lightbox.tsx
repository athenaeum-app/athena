import { Show, createEffect, createSignal, onCleanup, onMount, type Component } from 'solid-js'
import {
    lightboxOpen,
    lightboxImages,
    lightboxIndex,
    closeLightbox,
    lightboxNext,
    lightboxPrev,
    lightboxGo,
    downloadHref,
} from '../lightbox'

// Full media viewer: fit-to-screen with click/scroll zoom + drag pan, filename
// caption, download, and arrow/swipe navigation across every item in the block
// it was opened from. Mounted once at the app root.
//
// Video plays here rather than being zoomed. The gestures an image viewer is
// built from all collide with a player's own: a click is play/pause, a drag is
// the scrubber, and a wheel is volume in some browsers, so for video the zoom,
// pan and swipe handlers stand down and the native controls take over. Keyboard
// and button navigation still work, which is what actually moves between items.
export const Lightbox: Component = () => {
    const [scale, setScale] = createSignal(1)
    const [tx, setTx] = createSignal(0)
    const [ty, setTy] = createSignal(0)

    const current = () => lightboxImages()[lightboxIndex()]
    const count = () => lightboxImages().length
    const isVideo = () => current()?.kind === 'video'
    const zoomed = () => scale() > 1.01

    const resetView = () => {
        setScale(1)
        setTx(0)
        setTy(0)
    }

    // Reset zoom/pan whenever the shown image changes or the viewer opens.
    createEffect(() => {
        lightboxIndex()
        lightboxOpen()
        resetView()
    })

    const clampScale = (s: number) => Math.max(1, Math.min(5, s))

    const onWheel = (e: WheelEvent) => {
        e.preventDefault()
        const next = clampScale(scale() * (e.deltaY < 0 ? 1.15 : 0.87))
        setScale(next)
        if (next <= 1.01) {
            setTx(0)
            setTy(0)
        }
    }

    // Pointer drag: pan when zoomed, else horizontal swipe navigates.
    let down: { x: number; y: number; tx: number; ty: number } | null = null
    const onPointerDown = (e: PointerEvent) => {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        down = { x: e.clientX, y: e.clientY, tx: tx(), ty: ty() }
    }
    const onPointerMove = (e: PointerEvent) => {
        if (!down || !zoomed()) return
        setTx(down.tx + (e.clientX - down.x))
        setTy(down.ty + (e.clientY - down.y))
    }
    const onPointerUp = (e: PointerEvent) => {
        if (!down) return
        const dx = e.clientX - down.x
        const dy = e.clientY - down.y
        if (!zoomed() && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
            dx < 0 ? lightboxNext() : lightboxPrev()
        }
        down = null
    }

    const toggleZoom = (e: MouseEvent) => {
        // Ignore the click that ended a drag-pan.
        if (zoomed()) resetView()
        else {
            setScale(2.5)
            void e
        }
    }

    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!lightboxOpen()) return
            if (e.key === 'Escape') {
                e.preventDefault()
                closeLightbox()
            } else if (e.key === 'ArrowRight') {
                e.preventDefault()
                lightboxNext()
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault()
                lightboxPrev()
            }
        }
        window.addEventListener('keydown', onKey, true)
        onCleanup(() => window.removeEventListener('keydown', onKey, true))
    })

    return (
        <Show when={lightboxOpen()}>
            <div
                data-testid="lightbox"
                class="fixed inset-0 z-[80] flex flex-col bg-black/90 animate-fade-in"
                onClick={(e) => {
                    if (e.target === e.currentTarget) closeLightbox()
                }}
            >
                {/* Top bar: caption + counter + download + close */}
                <div class="flex items-center gap-3 p-3 text-white/90" onClick={(e) => e.stopPropagation()}>
                    <span class="min-w-0 flex-1 truncate text-sm font-bold">
                        {current()?.alt || (isVideo() ? 'Video' : 'Image')}
                    </span>
                    <Show when={count() > 1}>
                        <span class="text-xs opacity-70">
                            {lightboxIndex() + 1} / {count()}
                        </span>
                    </Show>
                    <a
                        href={downloadHref(current()?.src || '')}
                        download=""
                        class="hover:text-white transition-colors"
                        title="Download"
                        aria-label={isVideo() ? 'Download video' : 'Download image'}
                    >
                        <span class="material-symbols-outlined">download</span>
                    </a>
                    <button
                        type="button"
                        onClick={closeLightbox}
                        class="hover:text-white transition-colors"
                        aria-label="Close"
                    >
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>

                {/* Stage. Its own click-outside check, not just the outer
                    wrapper's: the padding around the image/video is this div,
                    not the wrapper, so a click there has this as e.target and
                    would otherwise fall through the wrapper's check silently. */}
                <div
                    data-testid="lightbox-stage"
                    class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) closeLightbox()
                    }}
                >
                    <Show when={count() > 1}>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation()
                                lightboxPrev()
                            }}
                            class="absolute left-2 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
                            aria-label="Previous"
                        >
                            <span class="material-symbols-outlined">chevron_left</span>
                        </button>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation()
                                lightboxNext()
                            }}
                            class="absolute right-2 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
                            aria-label="Next"
                        >
                            <span class="material-symbols-outlined">chevron_right</span>
                        </button>
                    </Show>

                    {/* keyed: a new item builds a new <video>. Reusing one
                        element and swapping its src leaves the previous clip's
                        playback state behind and does not re-trigger autoplay. */}
                    <Show
                        when={isVideo() ? current() : null}
                        keyed
                        fallback={
                            <img
                                src={current()?.src}
                                alt={current()?.alt || ''}
                                draggable={false}
                                onWheel={onWheel}
                                onPointerDown={onPointerDown}
                                onPointerMove={onPointerMove}
                                onPointerUp={onPointerUp}
                                onClick={toggleZoom}
                                class="max-h-full max-w-full touch-none select-none object-contain"
                                classList={{ 'cursor-zoom-in': !zoomed(), 'cursor-grab': zoomed() }}
                                style={{
                                    transform: `translate(${tx()}px, ${ty()}px) scale(${scale()})`,
                                    transition: down ? 'none' : 'transform 0.12s ease-out',
                                }}
                            />
                        }
                    >
                        {(item) => (
                            <video
                                src={item.src}
                                controls
                                autoplay
                                playsinline
                                class="max-h-full max-w-full object-contain"
                            />
                        )}
                    </Show>
                </div>

                {/* Dot strip */}
                <Show when={count() > 1}>
                    <div class="flex items-center justify-center gap-1.5 p-3" onClick={(e) => e.stopPropagation()}>
                        {lightboxImages().map((_, i) => (
                            <button
                                type="button"
                                onClick={() => lightboxGo(i)}
                                class="h-2 w-2 rounded-full transition-all"
                                classList={{ 'bg-white': i === lightboxIndex(), 'bg-white/30': i !== lightboxIndex() }}
                                aria-label={`Go to item ${i + 1}`}
                            />
                        ))}
                    </div>
                </Show>
            </div>
        </Show>
    )
}

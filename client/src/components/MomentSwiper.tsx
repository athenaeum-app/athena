import { For, createEffect, createSignal, onCleanup, onMount, type Component, type JSX } from 'solid-js'
import type { Moment } from '../api'

interface MomentSwiperProps {
    moments: Moment[]
    hasMore: boolean
    onLoadMore: () => void
    onOpenMoment?: (id: string) => void
    // Press-and-hold the active card (no drag) → secondary actions.
    onLongPress?: (moment: Moment) => void
    // Renders one moment's card content; MomentSwiper only owns the
    // carousel mechanics, not card styling (that stays Feed's MomentCard,
    // shared with the desktop list so the two never drift apart).
    card: (moment: Moment) => JSX.Element
}

// Mobile replacement for the moments list (§ mobile card swipe): one moment
// fills most of the screen, neighbouring cards peek in at the edges, and a
// horizontal drag/swipe moves between them. Vertical drags are left
// completely alone. Direction is locked on the first move, so a vertical
// drag never gets claimed here and always falls through to the page's
// single mobile scroll surface (see App.tsx).
export const MomentSwiper: Component<MomentSwiperProps> = (props) => {
    const [index, setIndex] = createSignal(0)
    let stageRef: HTMLDivElement | undefined
    let trackRef: HTMLDivElement | undefined
    let slotRefs: HTMLDivElement[] = []
    let requestedMoreAt = -1

    const clampIndex = (i: number) => Math.max(0, Math.min(props.moments.length - 1, i))

    const layout = (dragPx = 0, animate = true) => {
        const stage = stageRef,
            track = trackRef
        if (!stage || !track) return
        const stageW = stage.clientWidth
        const slotW = Math.round(stageW * 0.86)
        slotRefs.forEach((s) => {
            if (!s) return
            s.style.width = `${slotW}px`
            s.style.flex = `0 0 ${slotW}px`
        })
        const centerGap = (stageW - slotW) / 2
        track.style.transition = animate ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : 'none'
        track.style.transform = `translateX(${centerGap - index() * slotW + dragPx}px)`
    }

    onMount(() => {
        layout(0, false)
        const onResize = () => layout(0, false)
        window.addEventListener('resize', onResize)
        onCleanup(() => window.removeEventListener('resize', onResize))
    })

    // New moments appended (infinite scroll) or the active index changed.
    // Both need a re-measure/re-position pass.
    createEffect(() => {
        index()
        props.moments.length
        layout(0, index() === clampIndex(index()) ? true : false)
    })

    let startX = 0
    let startY = 0
    let dx = 0
    let dragging = false
    let locked: 'x' | 'y' | null = null
    let interactiveStart = false
    // Long-press: fires only for a stationary hold (no direction lock, no move).
    let lpTimer: number | undefined
    let lpFired = false
    const clearLongPress = () => {
        if (lpTimer !== undefined) {
            clearTimeout(lpTimer)
            lpTimer = undefined
        }
    }

    const isInteractive = (el: HTMLElement | null) =>
        !!el?.closest('button, a, input, textarea, select, i.material-symbols-outlined, i.fa-solid')

    const onPointerDown = (e: PointerEvent) => {
        interactiveStart = isInteractive(e.target as HTMLElement)
        if (interactiveStart) return // let pin/edit/delete/links behave natively
        // A mouse drag over the card's own text is the browser's default text
        // selection gesture, which fires independently of anything below and
        // does not care that this became a swipe. select-none on the stage
        // stops the visual selection; this stops the browser from starting
        // that gesture at all, which is what a mouse-drag desktop user hits
        // when the layout drops to the mobile swiper at a narrow viewport.
        e.preventDefault()
        startX = e.clientX
        startY = e.clientY
        dx = 0
        dragging = true
        locked = null
        lpFired = false
        stageRef?.setPointerCapture(e.pointerId)
        clearLongPress()
        lpTimer = window.setTimeout(() => {
            lpTimer = undefined
            // Still an undecided, in-progress press → treat as a long press.
            if (locked === null && dragging) {
                lpFired = true
                dragging = false
                layout(0, true)
                const moment = props.moments[index()]
                if (moment) props.onLongPress?.(moment)
            }
        }, 450)
    }
    const onPointerMove = (e: PointerEvent) => {
        if (!dragging) return
        const ddx = e.clientX - startX
        const ddy = e.clientY - startY
        if (locked === null && (Math.abs(ddx) > 6 || Math.abs(ddy) > 6)) {
            locked = Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y'
            clearLongPress() // any real movement cancels the pending long press
        }
        if (locked === 'x') {
            dx = ddx
            layout(dx, false)
        }
        // locked === 'y' (or still undecided): don't touch the track. A
        // A vertical drag here just scrolls the page, same as anywhere else.
    }
    const maybeLoadMore = () => {
        if (props.hasMore && index() >= props.moments.length - 2 && requestedMoreAt !== props.moments.length) {
            requestedMoreAt = props.moments.length
            props.onLoadMore()
        }
    }
    const endDrag = (e: PointerEvent) => {
        clearLongPress()
        if (interactiveStart) {
            interactiveStart = false
            return
        }
        // A long press already fired for this gesture. Swallow the release so it
        // doesn't also open the reader.
        if (lpFired) {
            lpFired = false
            return
        }
        if (!dragging) return
        dragging = false
        if (locked === 'x') {
            const threshold = 60
            if (dx < -threshold) setIndex((i) => clampIndex(i + 1))
            else if (dx > threshold) setIndex((i) => clampIndex(i - 1))
            else layout(0, true)
        } else if (locked === null && e.type === 'pointerup') {
            // A tap, not a drag, and not on an interactive control. Open
            // the active moment's full-text reader.
            const moment = props.moments[index()]
            if (moment) props.onOpenMoment?.(moment.id)
        } else {
            layout(0, true)
        }
        maybeLoadMore()
    }

    return (
        <div class="flex h-full min-h-0 w-full flex-1 flex-col gap-2">
            <div class="text-sub self-end rounded-full bg-black/40 px-2.5 py-1 text-xs font-bold">
                {index() + 1} / {props.moments.length}
            </div>
            <div
                ref={stageRef}
                class="relative min-h-0 flex-1 touch-pan-y select-none overflow-hidden"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <div ref={trackRef} class="absolute left-0 top-0 flex h-full will-change-transform">
                    <For each={props.moments}>
                        {(moment, i) => (
                            <div
                                ref={(el) => (slotRefs[i()] = el)}
                                class="flex h-full items-stretch px-1.5 transition-[opacity,transform] duration-150"
                                classList={{ 'opacity-100': i() === index(), 'scale-[.94] opacity-50': i() !== index() }}
                            >
                                <div class="relative max-h-full w-full overflow-hidden rounded-xl">
                                    {props.card(moment)}
                                    {/* Fade hints there's more below, cut off by the fixed card height. */}
                                    <div class="from-element pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t to-transparent" />
                                </div>
                            </div>
                        )}
                    </For>
                </div>
            </div>
            <div class="text-sub text-center text-xs opacity-60">← swipe · tap a card to read →</div>
        </div>
    )
}

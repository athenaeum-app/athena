// Long-press → secondary action, the universal touch affordance across the
// mobile shell (moment cards, chat messages, archive/tag rows, canvas nodes).
// Hover is unavailable on touch, so a press-and-hold stands in for the desktop
// hover-reveal actions.
//
// Usage:
//   const lp = createLongPress(() => ui.actionSheet({ ... }))
//   <div {...lp.handlers} onClick={() => { if (lp.consumed()) return; primaryTap() }} />
//
// `consumed()` is true only for the tap immediately following a fired long
// press, so a card's onClick can bail out and not also run the primary action.

interface LongPressOptions {
    // Hold duration before the handler fires (default 450ms).
    ms?: number
    // Movement (px) that cancels the press as a scroll/drag (default 8).
    moveTolerance?: number
}

export function createLongPress(handler: (e: PointerEvent) => void, opts: LongPressOptions = {}) {
    const delayMs = opts.ms ?? 450
    const tol = opts.moveTolerance ?? 8
    let timer: number | undefined
    let fired = false
    let startX = 0
    let startY = 0

    const clear = () => {
        if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
        }
    }

    const handlers = {
        onPointerDown(e: PointerEvent) {
            // Only primary/touch presses; ignore secondary mouse buttons.
            if (e.button !== 0) return
            fired = false
            startX = e.clientX
            startY = e.clientY
            clear()
            timer = window.setTimeout(() => {
                timer = undefined
                fired = true
                handler(e)
            }, delayMs)
        },
        onPointerMove(e: PointerEvent) {
            if (timer !== undefined && (Math.abs(e.clientX - startX) > tol || Math.abs(e.clientY - startY) > tol)) {
                clear()
            }
        },
        onPointerUp() {
            clear()
        },
        onPointerCancel() {
            clear()
        },
    }

    return {
        handlers,
        // True for the click that fires right after a long press, so the
        // element's onClick can skip its primary action.
        consumed: () => fired,
    }
}

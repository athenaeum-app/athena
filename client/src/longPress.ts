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
    let unwatch: (() => void) | undefined

    const clear = () => {
        if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
        }
        unwatch?.()
        unwatch = undefined
    }

    const onMove = (e: PointerEvent) => {
        if (Math.abs(e.clientX - startX) > tol || Math.abs(e.clientY - startY) > tol) clear()
    }

    // Everything that ends a press is watched on the window, not on the pressed
    // element. An element only receives moves while the pointer is still over
    // it, so a press that turns into a drag off the element leaves an
    // element-local listener with nothing to hear and the timer runs to
    // completion: aim for a chat panel's scrollbar, miss by a few pixels onto
    // the message beside it, drag, and an action sheet opens over the page.
    //
    // Scroll counts as an end too. Content moving under a held pointer is a
    // scroll, whatever started it, and never a press-and-hold.
    const watch = () => {
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', clear, true)
        window.addEventListener('pointercancel', clear, true)
        window.addEventListener('scroll', clear, true)
        unwatch = () => {
            window.removeEventListener('pointermove', onMove, true)
            window.removeEventListener('pointerup', clear, true)
            window.removeEventListener('pointercancel', clear, true)
            window.removeEventListener('scroll', clear, true)
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
            watch()
            timer = window.setTimeout(() => {
                fired = true
                clear()
                handler(e)
            }, delayMs)
        },
    }

    return {
        handlers,
        // True for the click that fires right after a long press, so the
        // element's onClick can skip its primary action.
        consumed: () => fired,
    }
}

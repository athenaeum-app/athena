// Backdrop dismissal guarded against drag-release. A modal that closes on
// backdrop click must not close because a pointer gesture merely *ended* over
// the backdrop: selecting text in a textarea, dragging a card, or sweeping a
// slider all routinely start inside the panel and finish outside it. The
// browser fires `click` on the nearest common ancestor of press and release,
// which for those gestures is the backdrop itself, so the naive
// `e.target === e.currentTarget` check reads them as a click on the backdrop.
//
// Closing therefore requires all three of press, release and click to land on
// the backdrop element itself, which also rules out the reverse gesture:
// pressing on the backdrop and releasing inside the panel.
//
// Usage: spread onto the backdrop element. <Modal> already does this, so reach
// for it directly only for a second dismiss zone nested inside one (the
// lightbox stage).
export function backdropDismiss(onClose: () => void) {
    let onBackdrop = false
    const own = (e: { currentTarget: Element; target: EventTarget | null }) => e.target === e.currentTarget
    return {
        onPointerDown(e: PointerEvent & { currentTarget: Element; target: EventTarget | null }) {
            onBackdrop = own(e)
        },
        onPointerUp(e: PointerEvent & { currentTarget: Element; target: EventTarget | null }) {
            onBackdrop = onBackdrop && own(e)
        },
        onClick(e: MouseEvent & { currentTarget: Element; target: EventTarget | null }) {
            const fromBackdrop = onBackdrop
            onBackdrop = false
            if (fromBackdrop && own(e)) onClose()
        },
    }
}

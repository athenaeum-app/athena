// Backdrop dismissal guarded against drag-release. A modal that closes
// on backdrop click must NOT close when the pointer gesture *started* inside
// the panel (e.g. selecting text in a textarea) and only happened to be
// released over the backdrop. We record where the press began and only close
// when both the press and the release land on the backdrop element itself.
//
// Usage: spread onto the backdrop element, replacing the old
//   onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
//   <div class="backdrop" {...backdropDismiss(props.onClose)}>
export function backdropDismiss(onClose: () => void) {
    let pressedBackdrop = false
    return {
        onPointerDown(e: PointerEvent & { currentTarget: Element; target: EventTarget | null }) {
            pressedBackdrop = e.target === e.currentTarget
        },
        onClick(e: MouseEvent & { currentTarget: Element; target: EventTarget | null }) {
            if (pressedBackdrop && e.target === e.currentTarget) onClose()
            pressedBackdrop = false
        },
    }
}

import { type Component, type JSX, onCleanup, onMount } from 'solid-js'
import { backdropDismiss } from '../dismiss'
import { isTopModal, popModal, pushModal } from '../modalStack'

// The one backdrop in the app. Appearance stays the caller's business, since a
// reader, a board and a bottom sheet are meant to look different; how a modal
// *closes* does not, and every copy of that logic was a copy of the same two
// bugs (see dismiss.ts and modalStack.ts).

// Stacking tiers, written out rather than built from the prop: Tailwind reads
// class names out of the source text, so a computed `z-[${n}]` compiles to no
// CSS at all.
const LAYERS = {
    surface: 'z-30',
    panel: 'z-50',
    dialog: 'z-[60]',
    editor: 'z-[65]',
    reader: 'z-[70]',
    top: 'z-[80]',
} as const

const SCRIMS = {
    none: '',
    soft: 'bg-black/40',
    default: 'bg-black/50',
    strong: 'bg-black/60',
    heavy: 'bg-black/70',
    opaque: 'bg-black/90',
} as const

const ALIGNMENTS = {
    center: 'flex items-center justify-center',
    bottom: 'flex flex-col justify-end',
    stretch: 'flex flex-col',
    // The panel places itself, as a drawer pinned to one edge does.
    free: '',
} as const

export type ModalLayer = keyof typeof LAYERS
export type ModalScrim = keyof typeof SCRIMS
export type ModalAlign = keyof typeof ALIGNMENTS

interface ModalProps {
    onClose: () => void
    layer?: ModalLayer
    scrim?: ModalScrim
    align?: ModalAlign
    // Canvas draws its dialogs inside the board rather than over the page.
    position?: 'fixed' | 'absolute'
    class?: string
    classList?: Record<string, boolean | undefined>
    // A shell that is only sometimes a dialog: Projects fills the screen when
    // it is not windowed, and a full-screen module has no outside to click.
    dismissable?: boolean
    closeOnEscape?: boolean
    onKeyDown?: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>
    'data-testid'?: string
    children: JSX.Element
}

export const Modal: Component<ModalProps> = (props) => {
    const token = pushModal()
    onCleanup(() => popModal(token))

    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || props.closeOnEscape === false) return
            // Bubble phase and defaultPrevented, not capture: a layer *inside*
            // this modal answers first (the editor closing its slash menu, the
            // chat composer blurring itself), and marks the key when it does.
            if (e.defaultPrevented || !isTopModal(token)) return
            e.preventDefault()
            props.onClose()
        }
        window.addEventListener('keydown', onKey)
        onCleanup(() => window.removeEventListener('keydown', onKey))
    })

    const dismiss = backdropDismiss(() => {
        if (props.dismissable !== false) props.onClose()
    })

    const classes = () =>
        [
            props.position === 'absolute' ? 'absolute' : 'fixed',
            'inset-0',
            LAYERS[props.layer ?? 'panel'],
            SCRIMS[props.scrim ?? 'default'],
            ALIGNMENTS[props.align ?? 'center'],
            props.class ?? '',
        ]
            .filter(Boolean)
            .join(' ')

    return (
        <div
            class={classes()}
            classList={props.classList}
            data-testid={props['data-testid']}
            onKeyDown={props.onKeyDown}
            {...dismiss}
        >
            {props.children}
        </div>
    )
}

interface PickerDialogProps {
    title: string
    onClose: () => void
    size?: 'md' | 'lg'
    layer?: ModalLayer
    scrim?: ModalScrim
    position?: 'fixed' | 'absolute'
    children: JSX.Element
}

// The small centred dialog: pick a moment, pick an embed, read the controls.
// Four copies of this markup had drifted a padding step apart from each other.
export const PickerDialog: Component<PickerDialogProps> = (props) => {
    const large = () => props.size === 'lg'
    return (
        <Modal
            onClose={props.onClose}
            layer={props.layer ?? 'dialog'}
            scrim={props.scrim ?? 'soft'}
            position={props.position}
        >
            <div
                class="bg-element-matte border-element-accent w-full rounded-lg border shadow-2xl"
                classList={{ 'max-w-md p-4': !large(), 'max-w-lg p-5': large() }}
            >
                <div class="mb-3 flex items-center justify-between">
                    <h3 class="text-main font-serif" classList={{ 'text-base': !large(), 'text-lg': large() }}>
                        {props.title}
                    </h3>
                    <button
                        type="button"
                        onClick={props.onClose}
                        aria-label="Close"
                        class="text-sub hover:text-main hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined" classList={{ 'text-base': !large() }}>
                            close
                        </span>
                    </button>
                </div>
                {props.children}
            </div>
        </Modal>
    )
}

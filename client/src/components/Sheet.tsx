import { Show, type Component, type JSX } from 'solid-js'
import { Modal } from './Modal'

// A bottom sheet: slides up from the bottom nav over a scrim, rounded top, with
// a grab handle, a titled header, and a scrollable body. The mobile shell's
// Archives / Filter / More panels all live in one of these.
export const Sheet: Component<{
    open: boolean
    title: string
    onClose: () => void
    children: JSX.Element
}> = (props) => {
    return (
        <Show when={props.open}>
            <Modal onClose={props.onClose} align="bottom" class="animate-fade-in">
                <div class="bg-element-matte border-element-accent animate-slide-up flex max-h-[82vh] flex-col rounded-t-2xl border-t shadow-2xl">
                    <div class="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-white/20" />
                    <div class="flex shrink-0 items-center justify-between px-4 pb-1 pt-2">
                        <h3 class="text-main font-serif text-lg font-semibold">{props.title}</h3>
                        <button onClick={props.onClose} class="text-sub hover:text-main transition-colors hover:cursor-pointer" aria-label="Close">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <div class="overflow-y-auto px-4 pb-6">{props.children}</div>
                </div>
            </Modal>
        </Show>
    )
}

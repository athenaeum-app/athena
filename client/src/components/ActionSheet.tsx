import { For, Show, type Component } from 'solid-js'
import { backdropDismiss } from '../dismiss'

// A single action in a long-press action sheet.
export interface ActionSheetAction {
    label: string
    // Material Symbols icon name (optional).
    icon?: string
    danger?: boolean
    onSelect: () => void
}

export interface ActionSheetOptions {
    title?: string
    actions: ActionSheetAction[]
}

// The touch secondary-action surface: a bottom sheet of choices that slides up
// over a scrim, plus a separate Cancel. Driven imperatively via `ui.actionSheet`
// so any surface can raise one without owning modal state.
export const ActionSheet: Component<ActionSheetOptions & { onClose: () => void }> = (props) => {
    const pick = (a: ActionSheetAction) => {
        props.onClose()
        a.onSelect()
    }
    return (
        <div
            class="animate-fade-in fixed inset-0 z-[80] flex flex-col justify-end p-2.5"
            style={{ background: 'rgb(0 0 0 / 0.5)' }}
            {...backdropDismiss(props.onClose)}
        >
            <div class="animate-slide-up mx-auto w-full max-w-md">
                <div class="bg-element-matte border-element-accent overflow-hidden rounded-2xl border shadow-2xl backdrop-blur-md">
                    <Show when={props.title}>
                        <div class="border-element-accent text-sub truncate border-b px-4 py-3 text-center text-xs font-bold">
                            {props.title}
                        </div>
                    </Show>
                    <For each={props.actions}>
                        {(a) => (
                            <button
                                onClick={() => pick(a)}
                                class="border-element-accent hover:bg-element-accent flex w-full items-center gap-3 border-b px-4 py-3.5 text-left text-[15px] transition-colors last:border-b-0 hover:cursor-pointer"
                                classList={{ 'text-danger': a.danger, 'text-main': !a.danger }}
                            >
                                <Show when={a.icon}>
                                    <span class="material-symbols-outlined text-xl" classList={{ 'text-danger': a.danger, 'text-sub': !a.danger }}>
                                        {a.icon}
                                    </span>
                                </Show>
                                {a.label}
                            </button>
                        )}
                    </For>
                </div>
                <button
                    onClick={props.onClose}
                    class="bg-element-matte border-element-accent text-main mt-2 w-full rounded-2xl border py-3.5 text-center font-bold shadow-2xl backdrop-blur-md hover:cursor-pointer"
                >
                    Cancel
                </button>
            </div>
        </div>
    )
}

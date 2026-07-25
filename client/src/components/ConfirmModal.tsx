import { Show, createSignal, type Component } from 'solid-js'
import { backdropDismiss } from '../dismiss'

export interface ConfirmOptions {
    title: string
    // Body text. Kept optional so simple yes/no prompts can pass just a title.
    message?: string
    confirmLabel?: string
    cancelLabel?: string
    // Renders the confirm button in the danger colour and uses a warning icon.
    danger?: boolean
    // Strong-confirm variant: the user must type this exact string before the
    // confirm button enables. Used for irreversible actions (deletes, restores).
    confirmText?: string
}

interface ConfirmModalProps extends ConfirmOptions {
    onConfirm: () => void
    onCancel: () => void
}

// A single reusable confirmation dialog. Presentational only: the imperative
// useConfirm() hook (see ui.tsx) owns the open/close lifecycle and resolves a
// promise, so callers can `await confirm({...})` in place of window.confirm.
export const ConfirmModal: Component<ConfirmModalProps> = (props) => {
    const [typed, setTyped] = createSignal('')

    const needsType = () => !!props.confirmText
    const canConfirm = () => !needsType() || typed() === props.confirmText

    return (
        <div
            class="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] animate-fade-in"
            {...backdropDismiss(props.onCancel)}
            onKeyDown={(e) => {
                if (e.key === 'Escape') props.onCancel()
                if (e.key === 'Enter' && canConfirm()) props.onConfirm()
            }}
        >
            <div class="bg-element-matte border-element-accent flex w-full max-w-md flex-col gap-4 rounded-2xl border-2 p-6 shadow-2xl">
                <div class="flex items-center gap-3">
                    <span
                        class="material-symbols-outlined text-2xl"
                        classList={{
                            'text-danger': props.danger,
                            'text-highlight': !props.danger,
                        }}
                    >
                        {props.danger ? 'warning' : 'help'}
                    </span>
                    <h2 class="text-main text-lg font-bold tracking-wide">{props.title}</h2>
                </div>

                <Show when={props.message}>
                    <p class="text-sub text-sm leading-relaxed whitespace-pre-line">{props.message}</p>
                </Show>

                <Show when={needsType()}>
                    <div class="flex flex-col gap-1">
                        <label class="text-sub text-xs">
                            Type <span class="text-main font-mono font-bold">{props.confirmText}</span> to confirm.
                        </label>
                        <input
                            type="text"
                            value={typed()}
                            onInput={(e) => setTyped(e.currentTarget.value)}
                            // eslint-disable-next-line
                            autofocus
                            class="bg-element text-main border-element-accent focus:border-danger w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none"
                        />
                    </div>
                </Show>

                <div class="flex justify-end gap-2">
                    <button
                        onClick={props.onCancel}
                        class="bg-element-accent text-sub hover:bg-element-accent-highlight rounded-lg px-4 py-2 text-sm font-bold transition-colors hover:cursor-pointer"
                    >
                        {props.cancelLabel || 'Cancel'}
                    </button>
                    <button
                        onClick={props.onConfirm}
                        disabled={!canConfirm()}
                        class="rounded-lg px-4 py-2 text-sm font-bold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 hover:cursor-pointer"
                        classList={{
                            'bg-danger': props.danger,
                            'bg-highlight-strongest': !props.danger,
                        }}
                    >
                        {props.confirmLabel || 'Confirm'}
                    </button>
                </div>
            </div>
        </div>
    )
}

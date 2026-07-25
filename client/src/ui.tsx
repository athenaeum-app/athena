import {
    createContext,
    useContext,
    createSignal,
    For,
    Show,
    type ParentComponent,
} from 'solid-js'
import { ConfirmModal, type ConfirmOptions } from './components/ConfirmModal'
import { ActionSheet, type ActionSheetOptions } from './components/ActionSheet'

// Imperative UI helpers shared across the app: an async confirm() that
// replaces window.confirm (so callers can `await confirm({...})`), and a
// toast() that replaces alert() for transient feedback. Both are rendered
// once here, at the provider, and driven by signals.

type ToastKind = 'info' | 'success' | 'error'

interface Toast {
    id: number
    message: string
    kind: ToastKind
}

interface PendingConfirm extends ConfirmOptions {
    resolve: (ok: boolean) => void
}

interface UIContextValue {
    confirm: (opts: ConfirmOptions) => Promise<boolean>
    toast: (message: string, kind?: ToastKind) => void
    // Long-press secondary-action sheet (mobile). Fire-and-forget: the chosen
    // action's onSelect runs when picked, and the sheet dismisses itself.
    actionSheet: (opts: ActionSheetOptions) => void
}

const UIContext = createContext<UIContextValue>()

export const UIProvider: ParentComponent = (props) => {
    const [pending, setPending] = createSignal<PendingConfirm | null>(null)
    const [toasts, setToasts] = createSignal<Toast[]>([])
    const [sheet, setSheet] = createSignal<ActionSheetOptions | null>(null)
    let nextToastId = 1

    const actionSheet = (opts: ActionSheetOptions) => setSheet(opts)

    const confirm = (opts: ConfirmOptions) =>
        new Promise<boolean>((resolve) => {
            setPending({ ...opts, resolve })
        })

    const settle = (ok: boolean) => {
        const current = pending()
        if (!current) return
        setPending(null)
        current.resolve(ok)
    }

    const toast = (message: string, kind: ToastKind = 'info') => {
        const id = nextToastId++
        setToasts((prev) => [...prev, { id, message, kind }])
        window.setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id))
        }, 4000)
    }

    return (
        <UIContext.Provider value={{ confirm, toast, actionSheet }}>
            {props.children}

            <Show when={sheet()}>
                {(s) => <ActionSheet title={s().title} actions={s().actions} onClose={() => setSheet(null)} />}
            </Show>

            <Show when={pending()}>
                {(p) => (
                    <ConfirmModal
                        title={p().title}
                        message={p().message}
                        confirmLabel={p().confirmLabel}
                        cancelLabel={p().cancelLabel}
                        danger={p().danger}
                        confirmText={p().confirmText}
                        onConfirm={() => settle(true)}
                        onCancel={() => settle(false)}
                    />
                )}
            </Show>

            {/* Toast stack, fixed bottom-centre, above everything. */}
            <div class="fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4">
                <For each={toasts()}>
                    {(t) => (
                        <div
                            class="animate-slide-up pointer-events-auto flex max-w-md items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold shadow-2xl"
                            classList={{
                                'bg-element-matte border-element-accent text-sub': t.kind === 'info',
                                'bg-element-matte border-success text-success': t.kind === 'success',
                                'bg-element-matte border-danger text-danger': t.kind === 'error',
                            }}
                        >
                            <span class="material-symbols-outlined text-base">
                                {t.kind === 'success' ? 'check_circle' : t.kind === 'error' ? 'error' : 'info'}
                            </span>
                            <span>{t.message}</span>
                        </div>
                    )}
                </For>
            </div>
        </UIContext.Provider>
    )
}

export function useUI(): UIContextValue {
    const ctx = useContext(UIContext)
    if (!ctx) throw new Error('useUI must be used within UIProvider')
    return ctx
}

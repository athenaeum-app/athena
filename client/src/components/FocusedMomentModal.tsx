import { createSignal, createEffect, For, Show, type Component } from 'solid-js'
import { api, type Moment, type Archive, type Tag } from '../api'
import { MomentBody } from './MomentBody'
import { AttachmentList } from './AttachmentList'
import { LinkPreviewList } from './LinkPreview'
import { backdropDismiss } from '../dismiss'
import { contrastingTextColor } from '../tagColors'
import { useUI } from '../ui'

// FocusedMomentModal is a read-only "reader" view of a single moment: a blurred
// backdrop with the moment rendered large and centred, plus edit/close actions
// pinned top-right. It's opened when a moment is *referenced* from elsewhere (a
// linked task, a canvas moment-ref) and the reader wants to see it in full
// without leaving that context. It fetches the moment by id, so it works for
// any moment, not only those currently loaded in the feed.

export const FocusedMomentModal: Component<{
    momentId: string
    archives: Archive[]
    tags: Tag[]
    canEdit: boolean
    // Whether to show the Pin toggle (PIN_MOMENT permission).
    canPin?: boolean
    resolveRef?: (id: string) => string | undefined
    onEdit: (m: Moment) => void
    onClose: () => void
    // Pin/delete let the reader be the single home for a moment's actions.
    // The mobile swiper card is a non-interactive preview that opens this.
    onTogglePin?: (m: Moment, pinned: boolean) => void
    onDelete?: (id: string) => void
    // Embed click-through (ADR-0015).
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
}> = (props) => {
    const ui = useUI()
    const [moment, setMoment] = createSignal<Moment | null>(null)
    const [failed, setFailed] = createSignal(false)

    const confirmDelete = async () => {
        const current = moment()
        if (!current || !props.onDelete) return
        const ok = await ui.confirm({
            title: 'Delete moment?',
            message: `"${current.title || 'Untitled'}" will be permanently deleted. This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
        })
        if (ok) props.onDelete(current.id)
    }

    createEffect(() => {
        const id = props.momentId
        setMoment(null)
        setFailed(false)
        api.getMoment(id)
            .then(setMoment)
            .catch(() => setFailed(true))
    })

    const archiveName = () => {
        const current = moment()
        return current ? props.archives.find((a) => a.id === current.archive_id)?.name : undefined
    }
    const formatDate = (ts: string) =>
        new Intl.DateTimeFormat(navigator.language, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
        }).format(new Date(ts))

    return (
        <div
            class="animate-fade-in fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
            {...backdropDismiss(props.onClose)}
        >
            <div class="bg-element-matte border-element-accent relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border shadow-2xl">
                {/* Actions, pinned top-right over the content. */}
                <div class="absolute right-3 top-3 z-10 flex items-center gap-1">
                    <Show when={props.canPin && props.onTogglePin && moment()}>
                        <button
                            onClick={() => props.onTogglePin!(moment()!, !moment()!.pinned)}
                            title={moment()!.pinned ? 'Unpin' : 'Pin'}
                            class="bg-element/70 hover:text-main rounded-full p-2 backdrop-blur transition-colors hover:cursor-pointer"
                            classList={{ 'text-highlight-strongest': moment()!.pinned, 'text-sub': !moment()!.pinned }}
                        >
                            <span class="material-symbols-outlined text-lg">push_pin</span>
                        </button>
                    </Show>
                    <Show when={props.canEdit && moment()}>
                        <button
                            onClick={() => props.onEdit(moment()!)}
                            title="Edit this moment"
                            class="bg-element/70 text-sub hover:text-main rounded-full p-2 backdrop-blur transition-colors hover:cursor-pointer"
                        >
                            <span class="material-symbols-outlined text-lg">edit</span>
                        </button>
                    </Show>
                    <Show when={props.onDelete && moment()}>
                        <button
                            onClick={confirmDelete}
                            title="Delete this moment"
                            class="bg-element/70 text-sub hover:text-danger rounded-full p-2 backdrop-blur transition-colors hover:cursor-pointer"
                        >
                            <span class="material-symbols-outlined text-lg">delete</span>
                        </button>
                    </Show>
                    <button
                        onClick={props.onClose}
                        title="Close"
                        class="bg-element/70 text-sub hover:text-main rounded-full p-2 backdrop-blur transition-colors hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined text-lg">close</span>
                    </button>
                </div>

                <div class="overflow-y-auto p-8">
                    <Show
                        when={!failed()}
                        fallback={
                            <div class="flex flex-col items-center gap-2 py-12 text-center">
                                <span class="material-symbols-outlined text-sub text-3xl">broken_image</span>
                                <p class="text-sub text-sm italic">This moment could not be loaded. It may have been deleted.</p>
                            </div>
                        }
                    >
                        <Show when={moment()} fallback={<p class="text-sub py-12 text-center text-sm">Loading…</p>}>
                            {(m) => (
                                <div class="flex flex-col gap-3 pr-10">
                                    <Show when={archiveName()}>
                                        <span class="text-highlight-strong text-[10px] font-bold uppercase tracking-widest">[ {archiveName()} ]</span>
                                    </Show>
                                    <span class="text-sub text-sm font-semibold tracking-wider">{formatDate(m().timestamp)}</span>
                                    <Show when={m().pinned}>
                                        <span class="text-highlight-strongest flex items-center gap-1 text-xs font-bold uppercase tracking-wide">
                                            <span class="material-symbols-outlined text-sm">push_pin</span>
                                            Pinned
                                        </span>
                                    </Show>
                                    <h1 class="text-main font-serif text-4xl font-black break-words">{m().title || 'Untitled'}</h1>

                                    <Show when={m().content}>
                                        <div class="mt-1">
                                            <MomentBody
                                                content={m().content}
                                                class="text-main/90 text-base leading-relaxed"
                                                resolveRef={props.resolveRef}
                                                onOpenMoment={props.onOpenMoment}
                                                onOpenTodo={props.onOpenTodo}
                                                onOpenCanvas={props.onOpenCanvas}
                                            />
                                        </div>
                                        <AttachmentList content={m().content} />
                                        <LinkPreviewList content={m().content} />
                                    </Show>

                                    <Show when={(m().tag_ids || []).length > 0}>
                                        <div class="border-element-accent mt-2 flex flex-wrap gap-1.5 border-t pt-3">
                                            <For each={m().tag_ids || []}>
                                                {(tagId) => {
                                                    const tag = props.tags.find((t) => t.id === tagId)
                                                    if (!tag) return null
                                                    return (
                                                        <span
                                                            class="rounded-lg px-2 py-1 text-xs font-black uppercase tracking-wide"
                                                            style={{ 'background-color': tag.color, color: contrastingTextColor(tag.color) }}
                                                        >
                                                            #{tag.name}
                                                        </span>
                                                    )
                                                }}
                                            </For>
                                        </div>
                                    </Show>
                                </div>
                            )}
                        </Show>
                    </Show>
                </div>
            </div>
        </div>
    )
}

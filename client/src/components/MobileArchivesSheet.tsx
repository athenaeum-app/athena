import { For, Show, createSignal, type Component } from 'solid-js'
import type { Archive } from '../api'
import { useUI } from '../ui'
import { createLongPress } from '../longPress'

// The Archives sheet's body: create + a tappable list. Tap selects/filters (and
// closes the sheet, via onSelect); long-press raises rename/delete. Rename is an
// inline field, same as the desktop bar.
export const MobileArchivesSheet: Component<{
    archives: Archive[]
    selectedArchive: string | null
    onSelect: (id: string | null) => void
    onCreate: (name: string) => Promise<void>
    onRename: (archive: Archive, name: string) => Promise<void>
    onDelete: (archive: Archive) => void
    canManage: boolean
}> = (props) => {
    const ui = useUI()
    const [editingId, setEditingId] = createSignal<string | null>(null)
    const [draft, setDraft] = createSignal('')

    const startCreate = async (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
        if (e.key !== 'Enter') return
        const name = e.currentTarget.value.trim().toUpperCase()
        if (!name) return
        await props.onCreate(name)
        e.currentTarget.value = ''
    }

    const startRename = (a: Archive) => {
        setEditingId(a.id)
        setDraft(a.name)
    }
    const commitRename = async (a: Archive) => {
        const name = draft().trim().toUpperCase()
        setEditingId(null)
        if (!name || name === a.name) return
        await props.onRename(a, name)
    }

    const archiveActions = (a: Archive) =>
        ui.actionSheet({
            title: a.name,
            actions: [
                { label: 'Rename', icon: 'edit', onSelect: () => startRename(a) },
                { label: 'Delete', icon: 'delete', danger: true, onSelect: () => props.onDelete(a) },
            ],
        })

    return (
        <div class="flex flex-col">
            <Show when={props.canManage}>
                <div class="bg-element-accent border-element-accent mt-2 mb-1 flex items-center gap-2 rounded-xl border px-3 py-2.5">
                    <span class="material-symbols-outlined text-sub text-lg">add</span>
                    <input onKeyDown={startCreate} type="text" placeholder="Create new archive" class="text-main w-full bg-transparent text-sm focus:outline-none" />
                </div>
            </Show>

            <For each={props.archives}>
                {(archive) => {
                    const lp = createLongPress(() => props.canManage && archiveActions(archive))
                    const selected = () => props.selectedArchive === archive.id
                    return (
                        <Show
                            when={editingId() === archive.id}
                            fallback={
                                <button
                                    {...lp.handlers}
                                    onClick={() => {
                                        if (lp.consumed()) return
                                        // Tapping the active archive clears the filter (toggle off).
                                        props.onSelect(selected() ? null : archive.id)
                                    }}
                                    class="border-element-accent flex items-center gap-3 border-b py-3.5 text-left"
                                >
                                    <span class="material-symbols-outlined text-xl" classList={{ 'text-highlight-strongest': selected(), 'text-sub': !selected() }}>folder</span>
                                    <span class="flex-1 truncate text-[15px] font-bold" classList={{ 'text-highlight-strongest': selected(), 'text-main': !selected() }}>
                                        {archive.name}
                                    </span>
                                </button>
                            }
                        >
                            <input
                                type="text"
                                value={draft()}
                                autofocus
                                onInput={(e) => setDraft(e.currentTarget.value)}
                                onBlur={() => commitRename(archive)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') commitRename(archive)
                                    else if (e.key === 'Escape') setEditingId(null)
                                }}
                                class="bg-element-matte text-main border-element-accent focus:border-highlight my-1.5 w-full rounded-md border px-2 py-2 text-sm focus:outline-none"
                            />
                        </Show>
                    )
                }}
            </For>

            <Show when={props.selectedArchive !== null}>
                <button onClick={() => props.onSelect(null)} class="text-sub hover:text-main mt-3 flex items-center gap-1 self-start text-xs font-bold uppercase tracking-widest">
                    <span class="material-symbols-outlined text-sm">filter_alt_off</span>
                    Clear archive filter
                </button>
            </Show>
        </div>
    )
}

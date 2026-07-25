import { createSignal, For, Show, type Component } from 'solid-js'
import type { Archive } from '../api'
import { InputFrame } from './InputFrame'

interface ArchivesBarProps {
    archives: Archive[]
    selectedArchive: string | null
    onSelect: (id: string | null) => void
    onCreate: (name: string) => Promise<void>
    onRename: (archive: Archive, name: string) => Promise<void>
    onDelete: (archive: Archive) => void
    // Whether the current user may create/delete/rename archives. When false,
    // the create input and edit controls are hidden (view-only).
    canManage: boolean
}

export const ArchivesBar: Component<ArchivesBarProps> = (props) => {
    // Which archive (if any) is currently being renamed inline.
    const [editingId, setEditingId] = createSignal<string | null>(null)
    const [draft, setDraft] = createSignal('')

    const handleCreate = async (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
        if (e.key !== 'Enter') return
        const name = e.currentTarget.value.trim().toUpperCase()
        if (!name) return
        await props.onCreate(name)
        e.currentTarget.value = ''
    }

    const startRename = (archive: Archive) => {
        setEditingId(archive.id)
        setDraft(archive.name)
    }

    const commitRename = async (archive: Archive) => {
        const name = draft().trim().toUpperCase()
        setEditingId(null)
        if (!name || name === archive.name) return
        await props.onRename(archive, name)
    }

    return (
        <div class="bg-element flex flex-col gap-3 rounded-lg p-4">
            <span class="text-sub font-serif text-sm tracking-wide">Archives</span>
            <Show when={props.canManage}>
                <InputFrame
                    onKeyDown={handleCreate}
                    type="text"
                    placeholder="Create New Archive"
                    label="Create"
                    id="CreateArchive"
                />
            </Show>
            <For each={props.archives}>
                {(archive) => (
                    <Show
                        when={editingId() === archive.id}
                        fallback={
                            <div class="group flex items-center justify-between gap-2">
                                <button
                                    onClick={() =>
                                        props.onSelect(props.selectedArchive === archive.id ? null : archive.id)
                                    }
                                    class="min-w-0 flex-1 truncate text-left text-sm font-bold tracking-tight transition-colors hover:cursor-pointer"
                                    classList={{
                                        'text-highlight-strongest': props.selectedArchive === archive.id,
                                        'text-sub hover:text-main': props.selectedArchive !== archive.id,
                                    }}
                                >
                                    {archive.name}
                                </button>
                                <Show when={props.canManage}>
                                    <div class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                        <button
                                            onClick={() => startRename(archive)}
                                            title={`Rename archive ${archive.name}`}
                                            class="text-icon hover:text-main hover:cursor-pointer"
                                        >
                                            <span class="material-symbols-outlined text-sm">edit</span>
                                        </button>
                                        <button
                                            onClick={() => props.onDelete(archive)}
                                            title={`Delete archive ${archive.name}`}
                                            class="text-icon hover:text-danger hover:cursor-pointer"
                                        >
                                            <span class="material-symbols-outlined text-sm">delete</span>
                                        </button>
                                    </div>
                                </Show>
                            </div>
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
                            class="bg-element-matte text-main border-element-accent focus:border-highlight w-full rounded-md border px-2 py-1 text-sm focus:outline-none"
                        />
                    </Show>
                )}
            </For>
            {/* Per-filter clear: only shown while an archive filter is active. */}
            <Show when={props.selectedArchive !== null}>
                <button
                    onClick={() => props.onSelect(null)}
                    class="text-sub hover:text-main mt-1 flex items-center gap-1 self-start text-xs transition-colors hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-sm">filter_alt_off</span>
                    Clear archive filter
                </button>
            </Show>
        </div>
    )
}

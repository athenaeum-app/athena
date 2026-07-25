import { For, Show, createSignal, type Component } from 'solid-js'
import type { Tag } from '../api'
import { prefs } from '../prefs'
import { contrastingTextColor, randomTagColor } from '../tagColors'

interface TagBarProps {
    tags: Tag[]
    selectedTagIds: string[]
    onToggleTag: (id: string) => void
    onClear: () => void
    onCreateTag: (name: string, color: string) => Promise<void>
    onDeleteTag: (tag: Tag) => void
    // Whether the current user may create/delete tags. When false, the create
    // button and per-tag delete affordance are hidden (view/filter only).
    canManage: boolean
}

// A small palette of preset tag colors. Picked to be distinguishable across
// the bundled themes; users can also pick an arbitrary color via the native
// color input next to the palette.
const PRESET_COLORS = [
    '#ef4444', // red
    '#f97316', // orange
    '#f59e0b', // amber
    '#eab308', // yellow
    '#22c55e', // green
    '#10b981', // emerald
    '#06b6d4', // cyan
    '#3b82f6', // blue
    '#6366f1', // indigo
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#64748b', // slate
]

export const TagBar: Component<TagBarProps> = (props) => {
    const [creating, setCreating] = createSignal(false)
    const [name, setName] = createSignal('')
    const [color, setColor] = createSignal(PRESET_COLORS[0])
    const [saving, setSaving] = createSignal(false)
    const [error, setError] = createSignal('')

    const startCreate = () => {
        setCreating(true)
        setName('')
        setColor(PRESET_COLORS[0])
        setError('')
    }

    const cancelCreate = () => {
        setCreating(false)
        setName('')
        setError('')
    }

    const submit = async () => {
        const trimmed = name().trim()
        if (!trimmed) {
            setError('Name is required')
            return
        }
        setSaving(true)
        setError('')
        try {
            await props.onCreateTag(trimmed, color())
            setCreating(false)
            setName('')
        } catch (err: any) {
            setError(err.message || 'Failed to create tag')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div class="bg-element z-10 flex w-full flex-wrap items-center justify-center gap-2 p-2 backdrop-blur-md transition-all lg:max-h-[20vh] lg:overflow-y-auto lg:p-6">
            <span class="text-sub text-xs font-black tracking-widest uppercase">
                Tags:
            </span>
            <For each={props.tags}>
                {(tag) => (
                    <div class="group relative">
                        <button
                            onClick={() => props.onToggleTag(tag.id)}
                            class={`rounded-lg p-2 text-xs font-black tracking-wide uppercase transition-[filter,box-shadow] duration-100 hover:cursor-pointer ${
                                props.selectedTagIds.includes(tag.id)
                                    ? 'shadow-highlight-strongest border-plain border-2 shadow-sm'
                                    : 'hover:brightness-110'
                            }`}
                            style={{
                                'background-color': tag.color,
                                color: contrastingTextColor(tag.color),
                            }}
                        >
                            #{tag.name}
                        </button>
                        <Show when={props.canManage}>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    props.onDeleteTag(tag)
                                }}
                                title={`Delete tag ${tag.name}`}
                                class="bg-element-matte border-element-accent text-sub hover:text-danger hover:border-danger absolute -top-2 -right-2 flex h-4 w-4 items-center justify-center rounded-full border opacity-0 shadow-sm transition-all group-hover:opacity-100 hover:cursor-pointer"
                            >
                                <span class="material-symbols-outlined text-[10px] leading-none">close</span>
                            </button>
                        </Show>
                    </div>
                )}
            </For>

            {/* Create-tag toggle button */}
            <Show when={props.canManage && !creating()}>
                <button
                    onClick={startCreate}
                    title="Create a new tag"
                    class="border-element-accent text-sub hover:border-highlight hover:text-highlight-strongest flex items-center gap-1 rounded-xl border-2 border-dashed p-2 text-xs font-black tracking-wide uppercase transition-all duration-100 hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-sm">add</span>
                    New
                </button>
            </Show>

            {/* Inline creator */}
            <Show when={creating()}>
                <div class="bg-element-matte border-element-accent flex flex-col gap-2 rounded-xl border p-3 shadow-lg">
                    <div class="flex items-center gap-2">
                        <input
                            type="text"
                            value={name()}
                            onInput={(e) => setName(e.currentTarget.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') submit()
                                if (e.key === 'Escape') cancelCreate()
                            }}
                            placeholder="Tag name"
                            autofocus
                            class="bg-element text-main border-element-accent w-32 rounded-lg border px-2 py-1 text-xs font-bold uppercase tracking-wide focus:outline-none focus:border-highlight"
                        />
                        <input
                            type="color"
                            value={color()}
                            onChange={(e) => setColor(e.currentTarget.value)}
                            title="Tag color"
                            class="h-8 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
                        />
                        <button
                            onClick={() => setColor(randomTagColor(prefs().tagColorPreset))}
                            title={`Suggest a ${prefs().tagColorPreset} colour`}
                            class="text-sub hover:text-highlight-strongest flex h-8 w-8 items-center justify-center rounded hover:cursor-pointer"
                        >
                            <span class="material-symbols-outlined text-base">casino</span>
                        </button>
                    </div>
                    <div class="flex flex-wrap gap-1">
                        <For each={PRESET_COLORS}>
                            {(c) => (
                                <button
                                    onClick={() => setColor(c)}
                                    title={c}
                                    class={`h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 ${
                                        color() === c ? 'border-plain' : 'border-transparent'
                                    }`}
                                    style={{ 'background-color': c }}
                                />
                            )}
                        </For>
                    </div>
                    <Show when={error()}>
                        <p class="text-danger text-xs">{error()}</p>
                    </Show>
                    <div class="flex gap-2">
                        <button
                            onClick={submit}
                            disabled={saving()}
                            class="bg-highlight-strongest text-white rounded-lg px-3 py-1 text-xs font-bold disabled:opacity-50"
                        >
                            {saving() ? 'Saving...' : 'Create'}
                        </button>
                        <button
                            onClick={cancelCreate}
                            class="bg-element-accent text-sub hover:bg-element-accent-highlight rounded-lg px-3 py-1 text-xs font-bold"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </Show>

            <Show when={props.selectedTagIds.length > 0}>
                <button
                    onClick={props.onClear}
                    class="text-sub text-xs font-bold tracking-widest uppercase hover:text-highlight-strongest transition-colors"
                >
                    Clear
                </button>
            </Show>
        </div>
    )
}

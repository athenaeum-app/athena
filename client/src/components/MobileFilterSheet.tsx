import { For, Show, createSignal, type Component } from 'solid-js'
import type { Tag } from '../api'
import { prefs } from '../prefs'
import { contrastingTextColor, randomTagColor } from '../tagColors'
import { useUI } from '../ui'
import { createLongPress } from '../longPress'
import { EMPTY_FEED_FILTERS, activeFilterCount, type FeedFilters } from './Feed'

// Preset tag palette, mirrored from TagBar so mobile tag creation offers the
// same swatches as desktop.
const PRESET_COLORS = [
    '#ef4444', '#f97316', '#f59e0b', '#eab308', '#22c55e', '#10b981',
    '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#64748b',
]

// The Filter sheet's body: tag filtering + management (tap to filter, long-press
// to manage) unified with the date-range / media / link filters that lived in
// the desktop feed's filter popover.
export const MobileFilterSheet: Component<{
    tags: Tag[]
    selectedTagIds: string[]
    onToggleTag: (id: string) => void
    onClearTags: () => void
    onCreateTag: (name: string, color: string) => Promise<void>
    onDeleteTag: (tag: Tag) => void
    canManageTags: boolean
    filters: FeedFilters
    onChangeFilters: (f: FeedFilters) => void
}> = (props) => {
    const ui = useUI()
    const [creating, setCreating] = createSignal(false)
    const [name, setName] = createSignal('')
    const [color, setColor] = createSignal(PRESET_COLORS[0])
    const [saving, setSaving] = createSignal(false)

    const patch = (p: Partial<FeedFilters>) => props.onChangeFilters({ ...props.filters, ...p })

    const submit = async () => {
        const trimmed = name().trim()
        if (!trimmed) return
        setSaving(true)
        try {
            await props.onCreateTag(trimmed, color())
            setCreating(false)
            setName('')
            setColor(PRESET_COLORS[0])
        } finally {
            setSaving(false)
        }
    }

    const tagActions = (tag: Tag) =>
        ui.actionSheet({
            title: `#${tag.name}`,
            actions: [{ label: 'Delete tag', icon: 'delete', danger: true, onSelect: () => props.onDeleteTag(tag) }],
        })

    return (
        <div class="flex flex-col gap-1">
            {/* Tags */}
            <div class="text-sub mt-2 mb-2 text-[11px] font-black uppercase tracking-widest">
                Tags: tap to filter{props.canManageTags ? ' · long-press to manage' : ''}
            </div>
            <div class="flex flex-wrap gap-2">
                <For each={props.tags}>
                    {(tag) => {
                        const lp = createLongPress(() => props.canManageTags && tagActions(tag))
                        const selected = () => props.selectedTagIds.includes(tag.id)
                        return (
                            <button
                                {...lp.handlers}
                                onClick={() => {
                                    if (lp.consumed()) return
                                    props.onToggleTag(tag.id)
                                }}
                                class="rounded-full px-3.5 py-2 text-xs font-black uppercase tracking-wide transition-all"
                                classList={{ 'ring-plain shadow-sm ring-2 ring-offset-1': selected() }}
                                style={{ 'background-color': tag.color, color: contrastingTextColor(tag.color) }}
                            >
                                #{tag.name}
                            </button>
                        )
                    }}
                </For>

                <Show when={props.canManageTags && !creating()}>
                    <button
                        onClick={() => setCreating(true)}
                        class="border-element-accent text-sub hover:border-highlight flex items-center gap-1 rounded-full border-2 border-dashed px-3.5 py-2 text-xs font-black uppercase tracking-wide"
                    >
                        <span class="material-symbols-outlined text-sm">add</span>
                        New
                    </button>
                </Show>
            </div>

            <Show when={creating()}>
                <div class="bg-element-accent border-element-accent mt-3 flex flex-col gap-2 rounded-xl border p-3">
                    <div class="flex items-center gap-2">
                        <input
                            type="text"
                            value={name()}
                            onInput={(e) => setName(e.currentTarget.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') submit()
                                if (e.key === 'Escape') setCreating(false)
                            }}
                            placeholder="Tag name"
                            autofocus
                            class="bg-element text-main border-element-accent focus:border-highlight w-full rounded-lg border px-2 py-1.5 text-sm font-bold uppercase tracking-wide focus:outline-none"
                        />
                        <input type="color" value={color()} onChange={(e) => setColor(e.currentTarget.value)} class="h-9 w-9 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
                        <button onClick={() => setColor(randomTagColor(prefs().tagColorPreset))} title="Suggest a colour" class="text-sub flex h-9 w-9 shrink-0 items-center justify-center rounded">
                            <span class="material-symbols-outlined">casino</span>
                        </button>
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                        <For each={PRESET_COLORS}>
                            {(c) => (
                                <button
                                    onClick={() => setColor(c)}
                                    class="h-6 w-6 rounded-full border-2 transition-transform"
                                    classList={{ 'border-plain scale-110': color() === c, 'border-transparent': color() !== c }}
                                    style={{ 'background-color': c }}
                                />
                            )}
                        </For>
                    </div>
                    <div class="flex gap-2">
                        <button onClick={submit} disabled={saving()} class="bg-highlight-strongest text-plain rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50">
                            {saving() ? 'Saving…' : 'Create'}
                        </button>
                        <button onClick={() => setCreating(false)} class="bg-element-accent text-sub rounded-lg px-3 py-1.5 text-xs font-bold">
                            Cancel
                        </button>
                    </div>
                </div>
            </Show>

            {/* Date range */}
            <div class="text-sub mt-5 mb-2 text-[11px] font-black uppercase tracking-widest">Date range</div>
            <div class="flex gap-2">
                <label class="flex flex-1 flex-col gap-1">
                    <span class="text-sub text-xs font-bold">From</span>
                    <input type="date" value={props.filters.from} max={props.filters.to || undefined} onInput={(e) => patch({ from: e.currentTarget.value })} class="bg-element text-main border-element-accent focus:border-highlight rounded-md border px-2 py-1.5 text-sm focus:outline-none" />
                </label>
                <label class="flex flex-1 flex-col gap-1">
                    <span class="text-sub text-xs font-bold">To</span>
                    <input type="date" value={props.filters.to} min={props.filters.from || undefined} onInput={(e) => patch({ to: e.currentTarget.value })} class="bg-element text-main border-element-accent focus:border-highlight rounded-md border px-2 py-1.5 text-sm focus:outline-none" />
                </label>
            </div>

            {/* Content toggles */}
            <div class="text-sub mt-5 mb-1 text-[11px] font-black uppercase tracking-widest">Content</div>
            <label class="border-element-accent flex items-center justify-between border-t py-3">
                <span class="text-main text-sm font-bold">Has media</span>
                <input type="checkbox" checked={props.filters.media} onChange={(e) => patch({ media: e.currentTarget.checked })} class="h-5 w-5" />
            </label>
            <label class="border-element-accent flex items-center justify-between border-t py-3">
                <span class="text-main text-sm font-bold">Has link</span>
                <input type="checkbox" checked={props.filters.link} onChange={(e) => patch({ link: e.currentTarget.checked })} class="h-5 w-5" />
            </label>

            <Show when={activeFilterCount(props.filters) > 0 || props.selectedTagIds.length > 0}>
                <button
                    onClick={() => {
                        props.onClearTags()
                        props.onChangeFilters({ ...EMPTY_FEED_FILTERS })
                    }}
                    class="text-sub hover:text-highlight-strongest mt-4 self-center text-xs font-bold uppercase tracking-widest"
                >
                    Clear all filters
                </button>
            </Show>
        </div>
    )
}

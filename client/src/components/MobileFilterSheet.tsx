import { For, Show, type Component } from 'solid-js'
import type { Tag } from '../api'
import { contrastingTextColor } from '../tagColors'
import { useUI } from '../ui'
import { createLongPress } from '../longPress'
import { EMPTY_FEED_FILTERS, activeFilterCount, type FeedFilters } from './Feed'
import { visibleTags } from '../tagFacets'

// The Filter sheet's body: tag filtering and deletion (tap to filter,
// long-press to delete) unified with the date-range / media / link filters that
// lived in the desktop feed's filter popover. Tags are created in the moment
// composer, not here; see TagBar for why.
export const MobileFilterSheet: Component<{
    tags: Tag[]
    selectedTagIds: string[]
    onToggleTag: (id: string) => void
    onClearTags: () => void
    onDeleteTag: (tag: Tag) => void
    canManageTags: boolean
    filters: FeedFilters
    onChangeFilters: (f: FeedFilters) => void
    // Tags that still match at least one moment under the current filter; see
    // tagFacets.ts. null until the first facet response lands.
    availableTagIds?: Set<string> | null
}> = (props) => {
    const ui = useUI()
    const shown = () => visibleTags(props.tags, props.availableTagIds, props.selectedTagIds)

    const patch = (p: Partial<FeedFilters>) => props.onChangeFilters({ ...props.filters, ...p })

    const tagActions = (tag: Tag) =>
        ui.actionSheet({
            title: `#${tag.name}`,
            actions: [{ label: 'Delete tag', icon: 'delete', danger: true, onSelect: () => props.onDeleteTag(tag) }],
        })

    return (
        <div class="flex flex-col gap-1">
            {/* Tags */}
            <div class="text-sub mt-2 mb-2 text-[11px] font-black uppercase tracking-widest">
                Tags: tap to filter{props.canManageTags ? ' · long-press to delete' : ''}
            </div>
            <div class="flex flex-wrap gap-2">
                <For each={shown()}>
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

            </div>

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

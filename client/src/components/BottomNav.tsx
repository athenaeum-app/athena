import { For, Show, type Component } from 'solid-js'

export type NavTarget = 'archives' | 'filter' | 'chat' | 'more'

// Fixed bottom navigation for the mobile shell. Five slots; the centre "New"
// is a raised action button (the most frequent action), the others toggle their
// sheet / overlay. Icons + labels for discoverability on a rarely-changing bar.
//
// Without CREATE_MOMENT the New slot is not rendered at all, rather than
// rendered and rejected on tap: offering an action the server will refuse
// reads as a fault in the app, not as a permission you don't have.
export const BottomNav: Component<{
    active: NavTarget | null
    // Count of active tag/date/media filters, badged on the Filter slot.
    filterCount?: number
    canCreate: boolean
    onArchives: () => void
    onFilter: () => void
    onNew: () => void
    onChat: () => void
    onMore: () => void
}> = (props) => {
    const items: { key: NavTarget; icon: string; label: string; onClick: () => void }[] = [
        { key: 'archives', icon: 'folder', label: 'Archives', onClick: props.onArchives },
        { key: 'filter', icon: 'filter_list', label: 'Filter', onClick: props.onFilter },
        { key: 'chat', icon: 'chat_bubble', label: 'Chat', onClick: props.onChat },
        { key: 'more', icon: 'menu', label: 'More', onClick: props.onMore },
    ]
    // Archives · Filter · [New] · Chat · More. New is injected in the middle.
    const left = () => items.slice(0, 2)
    const right = () => items.slice(2)

    const Slot = (it: { key: NavTarget; icon: string; label: string; onClick: () => void }) => (
        <button
            onClick={it.onClick}
            class="relative flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors hover:cursor-pointer"
            classList={{ 'text-highlight-strongest': props.active === it.key, 'text-sub': props.active !== it.key }}
        >
            <span class="material-symbols-outlined text-2xl" style={{ color: 'currentColor' }}>{it.icon}</span>
            <span class="text-[10px] font-semibold tracking-wide">{it.label}</span>
            <Show when={it.key === 'filter' && (props.filterCount ?? 0) > 0}>
                <span class="bg-highlight-strongest text-plain absolute right-[22%] top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-black">
                    {props.filterCount}
                </span>
            </Show>
        </button>
    )

    return (
        <nav class="bg-element border-element-accent relative flex h-[60px] shrink-0 items-stretch border-t backdrop-blur-md">
            <For each={left()}>{(it) => Slot(it)}</For>

            {/* Centre "New": raised action button. */}
            <Show when={props.canCreate}>
                <button
                    onClick={props.onNew}
                    class="relative flex flex-1 flex-col items-center justify-end pb-1.5 hover:cursor-pointer"
                    aria-label="New moment"
                >
                    {/* Flat fill via inline colour (not the .bg-highlight-strongest
                        utility) so looks that add a glow to that class don't light up
                        the FAB, so a soft shadow is all it gets. */}
                    <span class="text-plain absolute -top-4 flex h-[52px] w-[52px] items-center justify-center rounded-full border-4 shadow-md transition-transform active:scale-95" style={{ 'background-color': 'var(--color-highlight-strongest)', 'border-color': 'var(--color-background)' }}>
                        <span class="material-symbols-outlined text-[26px]" style={{ color: 'currentColor' }}>add</span>
                    </span>
                    <span class="text-sub mt-[26px] text-[10px] font-semibold tracking-wide">New</span>
                </button>
            </Show>

            <For each={right()}>{(it) => Slot(it)}</For>
        </nav>
    )
}

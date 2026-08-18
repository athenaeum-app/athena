import { For, Show, createMemo, createSignal, onMount, onCleanup, type Component, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { Moment, Tag, Archive } from '../api'
import { Line } from './Line'
import { MomentBody } from './MomentBody'
import { MarkdownText } from './MarkdownText'
import { LinkPreviewList } from './LinkPreview'
import { AttachmentList } from './AttachmentList'
import { MomentSwiper } from './MomentSwiper'
import { useUI } from '../ui'
import { prefs, setPref } from '../prefs'
import { contrastingTextColor } from '../tagColors'
import { useIsDesktop } from '../media'

// Server-side feed filters (v2.2). Date bounds are the raw <input type="date">
// values (YYYY-MM-DD, local); App converts them to RFC3339 before querying.
// media/link toggle the content heuristics (has-asset / has-link).
export interface FeedFilters {
    from: string
    to: string
    media: boolean
    link: boolean
}

export const EMPTY_FEED_FILTERS: FeedFilters = { from: '', to: '', media: false, link: false }

export function activeFilterCount(f: FeedFilters): number {
    return (f.from ? 1 : 0) + (f.to ? 1 : 0) + (f.media ? 1 : 0) + (f.link ? 1 : 0)
}

// How much source markdown a mobile preview card renders. The card clips at its
// own height and fades out, so this is not the visible limit; it is a ceiling on
// the work each card does. The swiper mounts a card for every loaded moment at
// once, and highlighting a long code block twenty times over for text that is
// then clipped is pure waste. Set well above what a phone-sized card can show,
// so what ends the text is the clip and not the budget.
const PREVIEW_BUDGET = 1200

// The body of a moment as markdown, for the mobile swiper card. Embed tokens are
// dropped rather than rendered: MomentBody fetches each one at render time, and
// the swiper would fire that burst for every card in the feed at once.
function previewMarkdown(content: string): string {
    let text = (content || '')
        .replace(/::(todo|canvas):[0-9a-fA-F-]{6,}::/g, '')
        .replace(/\[\[[0-9a-fA-F-]{6,}\]\]/g, '')
        .trim()

    if (text.length > PREVIEW_BUDGET) {
        // Cut on a line break so the truncation can't land inside a link or an
        // emphasis run and leave its syntax on screen as literal text.
        const cut = text.lastIndexOf('\n', PREVIEW_BUDGET)
        text = text.slice(0, cut > 0 ? cut : PREVIEW_BUDGET)
    }
    // An odd number of fences means the cut fell inside a code block. Without a
    // closer, micromark treats everything after it as one open <pre> and the
    // rest of the card renders as unstyled source.
    if ((text.match(/^```/gm) || []).length % 2 === 1) text += '\n```'
    return text
}

interface FeedProps {
    moments: Moment[]
    // Library-shared pinned moments, rendered in a section at the top.
    pinnedMoments: Moment[]
    tags: Tag[]
    // Archives, so a card can show which archive it belongs to.
    archives: Archive[]
    // Tags currently selected in the filter bar; used to visually highlight
    // matching tags inside moment cards when that pref is enabled.
    selectedTagIds: string[]
    loading: boolean
    // True while an infinite-scroll page is being appended (distinct from the
    // full-feed initial `loading`).
    loadingMore: boolean
    hasMore: boolean
    searchQuery: string
    // Server-side date/media filters (v2.2) and their change handler.
    filters: FeedFilters
    onChangeFilters: (f: FeedFilters) => void
    canPin: boolean
    // Per-moment gates, not flat booleans: the server splits edit/delete into
    // own/any variants, so whether a given moment is actionable depends on who
    // wrote it. Showing an action the server will refuse is worse than not
    // offering it, so every edit/delete affordance below is behind these.
    canEditMoment: (m: Moment) => boolean
    canDeleteMoment: (m: Moment) => boolean
    onSearch: (q: string) => void
    onCreateMoment: () => void
    onEditMoment: (moment: Moment) => void
    onDeleteMoment: (id: string) => void
    onTogglePin: (moment: Moment, pinned: boolean) => void
    onLoadMore: () => void
    // Embed click-through (ADR-0015): open a referenced moment/todo/canvas.
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
    // Add/remove a tag from the feed filter, for tags drawn on a card. Same
    // handler the tag bar uses; gated by the clickableMomentTags pref.
    onToggleTag?: (id: string) => void
    // Whether this user may create moments at all. Drives the wording of the
    // empty state, so a read-only member isn't told to "create one".
    canCreate: boolean
    // Whether the feed itself shows a create affordance. Distinct from
    // canCreate because the mobile shell moves creating to the bottom nav, so
    // a user who *can* create still gets no composer here.
    showComposer: boolean
    // Optional inline creator (SmartEditor, 4.5). When provided it replaces
    // the "New Moment" button.
    inlineCreator?: unknown
}

export const Feed: Component<FeedProps> = (props) => {
    const ui = useUI()
    const isDesktop = useIsDesktop()

    // Solid props are getters, so the JSX behind inlineCreator is re-evaluated
    // on every read, and it is read twice below, which built two composers
    // and threw one away. Worse, anything that made those reads re-run swapped
    // in a fresh one, taking whatever had been typed into it. Memoize so there
    // is one composer with one lifetime.
    const inlineCreator = createMemo(() => props.inlineCreator)
    const [isSearching, setIsSearching] = createSignal(false)
    const [showFilters, setShowFilters] = createSignal(false)
    let searchBarRef: HTMLInputElement | undefined
    let filterWrapRef: HTMLDivElement | undefined
    let filterMenuRef: HTMLDivElement | undefined

    // The filter row has overflow-x-hidden (for the search bar's width
    // transition, see below), which per the CSS overflow spec silently forces
    // its unset overflow-y to auto too: a lone axis of "hidden" coerces the
    // other away from "visible". That turned the row into its own clipping
    // box, so the popover, absolutely positioned inside it, rendered but was
    // entirely invisible below the row's own single-line height. Portal it out
    // to escape that ancestor instead of fighting the clipping in place.
    const filterMenuStyle = (): JSX.CSSProperties => {
        const el = filterWrapRef
        if (!el) return { display: 'none' }
        const a = el.getBoundingClientRect()
        return {
            position: 'fixed',
            right: `${window.innerWidth - a.right}px`,
            top: `${a.bottom + 8}px`,
            width: '16rem', // matches the old w-64
        }
    }

    // Infinite scroll (desktop list/grid): a viewport-rooted observer with a
    // generous rootMargin fires onLoadMore before the sentinel actually scrolls
    // into view, so the next page is usually appended before you reach the end.
    // root:null still works inside the feed's own overflow-y-auto column because
    // the sentinel is clipped by that scroll container until it nears the bottom.
    const loadMoreObserver =
        typeof IntersectionObserver !== 'undefined'
            ? new IntersectionObserver(
                  (entries) => {
                      if (
                          entries.some((e) => e.isIntersecting) &&
                          props.hasMore &&
                          !props.loadingMore &&
                          !props.loading
                      ) {
                          props.onLoadMore()
                      }
                  },
                  { rootMargin: '800px 0px' },
              )
            : undefined
    onCleanup(() => loadMoreObserver?.disconnect())

    // Patch a single field of the filter object and push it up so App can
    // re-query. App owns the canonical filter state (like searchQuery).
    const patchFilter = (patch: Partial<FeedFilters>) =>
        props.onChangeFilters({ ...props.filters, ...patch })
    const clearFilters = () => props.onChangeFilters({ ...EMPTY_FEED_FILTERS })

    const tagFilterable = () => prefs().clickableMomentTags && !!props.onToggleTag

    // Attributes that turn a tag chip into a filter control. Kept off the class
    // attribute so each card can keep its own sizing; the cursor hint is added
    // at the call site instead.
    const tagFilterAttrs = (tagId: string) => {
        if (!tagFilterable()) return {}
        const toggle = (e: Event) => {
            e.stopPropagation()
            e.preventDefault()
            props.onToggleTag?.(tagId)
        }
        return {
            role: 'button' as const,
            tabindex: 0,
            title: 'Filter by this tag',
            onClick: toggle,
            onKeyDown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') toggle(e)
            },
        }
    }

    // Respond to the global "focus search" shortcut (see keybinds in App).
    onMount(() => {
        const onFocusSearch = () => {
            setIsSearching(true)
            searchBarRef?.focus()
        }
        window.addEventListener('athena:focus-search', onFocusSearch)

        // Dismiss the filter popover on an outside click. The popover itself
        // is portaled (see filterMenuStyle), so it's no longer a DOM
        // descendant of filterWrapRef, both refs have to be checked.
        const onDocPointer = (e: PointerEvent) => {
            if (!showFilters()) return
            const target = e.target as Node
            if (filterWrapRef?.contains(target)) return
            if (filterMenuRef?.contains(target)) return
            setShowFilters(false)
        }
        document.addEventListener('pointerdown', onDocPointer)

        onCleanup(() => {
            window.removeEventListener('athena:focus-search', onFocusSearch)
            document.removeEventListener('pointerdown', onDocPointer)
        })
    })

    const confirmDelete = async (moment: Moment) => {
        const ok = await ui.confirm({
            title: 'Delete moment?',
            message: `"${moment.title || 'Untitled'}" will be permanently deleted. This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
        })
        if (ok) props.onDeleteMoment(moment.id)
    }

    // Resolve a [[uuid]] reference to a moment title from what's loaded.
    const resolveRef = (id: string): string | undefined =>
        [...props.pinnedMoments, ...props.moments].find((m) => m.id === id)?.title || undefined

    // Mobile's card swiper has no separate pinned section. Pinned moments
    // just lead the single sequence (skipped while searching, same as the
    // desktop pinned section, so search results aren't reordered by it).
    const mobileMoments = () => (props.searchQuery ? props.moments : [...props.pinnedMoments, ...props.moments])

    // Resolve a moment's archive name for the card label.
    const archiveName = (m: Moment): string | undefined => props.archives.find((a) => a.id === m.archive_id)?.name

    const formatDate = (ts: string) => {
        return new Intl.DateTimeFormat(navigator.language, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
        }).format(new Date(ts))
    }

    // A single moment card, shared by the pinned section, the main feed, and
    // (compact) the mobile swiper, whose cards are narrower than the full
    // feed width, so the default text-4xl/break-all title wraps mid-word.
    const MomentCard: Component<{ moment: Moment; pinned?: boolean; compact?: boolean }> = (p) => (
        <div
            data-testid="moment-card"
            // Which moment this card is, rather than which moment's text it
            // happens to contain: with reference previews on, a card holds the
            // titles of the moments it references too.
            data-moment-id={p.moment.id}
            class="group hover:bg-element-accent border-element-accent flex w-full flex-col gap-2 rounded border p-4 transition-all duration-300"
            classList={{ 'border-highlight bg-element-accent/40': !!p.pinned }}
        >
            <div class="flex flex-col flex-wrap gap-2">
                <div class="flex justify-between">
                    <div class="flex w-full flex-col gap-2">
                        <Show when={archiveName(p.moment)}>
                            <span class="text-highlight-strong text-[10px] font-bold uppercase tracking-widest">
                                [ {archiveName(p.moment)} ]
                            </span>
                        </Show>
                        <span class="text-sub text-md font-semibold tracking-wider">
                            {formatDate(p.moment.timestamp)}
                        </span>
                        <div class="flex items-center gap-2">
                            <Show when={p.moment.is_legacy}>
                                <span class="text-xs px-2 py-0.5 bg-yellow-900/40 text-yellow-400 rounded inline-block w-fit">
                                    Legacy
                                </span>
                            </Show>
                            <Show when={p.moment.pinned}>
                                <span class="text-highlight-strongest flex items-center gap-1 text-xs font-bold uppercase tracking-wide">
                                    <span class="material-symbols-outlined text-sm">push_pin</span>
                                    Pinned
                                </span>
                            </Show>
                        </div>
                    </div>
                    <div class="flex items-start gap-2">
                        <Show when={props.canPin}>
                            <i
                                class="material-symbols-outlined text-icon hover:text-highlight-strongest text-lg transition-colors hover:cursor-pointer"
                                classList={{ 'text-highlight-strongest': p.moment.pinned }}
                                title={p.moment.pinned ? 'Unpin' : 'Pin'}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    props.onTogglePin(p.moment, !p.moment.pinned)
                                }}
                            >
                                push_pin
                            </i>
                        </Show>
                        <Show when={props.canEditMoment(p.moment)}>
                            <i
                                class="fa-solid fa-pencil text-icon hover:text-icon-hover transition-colors hover:cursor-pointer"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    props.onEditMoment(p.moment)
                                }}
                            />
                        </Show>
                        <Show when={props.canDeleteMoment(p.moment)}>
                            <i
                                class="fa-solid fa-trash text-icon hover:text-danger transition-colors hover:cursor-pointer"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    confirmDelete(p.moment)
                                }}
                            />
                        </Show>
                    </div>
                </div>
                <span
                    class="text-sub font-black"
                    classList={{ 'text-4xl break-all': !p.compact, 'text-2xl break-words': !!p.compact }}
                >
                    {p.moment.title || 'Untitled'}
                </span>
            </div>

            <Show when={p.moment.content}>
                <MomentBody
                    content={p.moment.content}
                    class="text-sub text-sm"
                    resolveRef={resolveRef}
                    onOpenMoment={props.onOpenMoment}
                    onOpenTodo={props.onOpenTodo}
                    onOpenCanvas={props.onOpenCanvas}
                    onOpenProject={props.onOpenProject}
                />
                <AttachmentList content={p.moment.content} />
                <LinkPreviewList content={p.moment.content} />
            </Show>

            <Show when={(p.moment.tag_ids || []).length > 0}>
                <Line class="bg-element-accent h-1 w-full" />
                <div class="flex flex-wrap items-center gap-1 text-wrap">
                    <For each={p.moment.tag_ids || []}>
                        {(tagId) => {
                            const tag = props.tags.find((t) => t.id === tagId)
                            if (!tag) return null
                            const highlighted = () =>
                                prefs().highlightSelectedTags &&
                                props.selectedTagIds.includes(tag.id)
                            return (
                                <span
                                    {...tagFilterAttrs(tag.id)}
                                    class="rounded-xl p-2 text-xs font-black tracking-wide uppercase transition-all"
                                    classList={{
                                        'ring-plain scale-110 shadow-sm ring-2': highlighted(),
                                        'hover:cursor-pointer hover:opacity-80': tagFilterable(),
                                    }}
                                    style={{
                                        'background-color': tag.color,
                                        color: contrastingTextColor(tag.color),
                                    }}
                                >
                                    #{tag.name}
                                </span>
                            )
                        }}
                    </For>
                </div>
            </Show>
        </div>
    )

    // Compact card for the grid view: archive, date, title, tags only.
    const MomentGridCard: Component<{ moment: Moment }> = (p) => (
        <button
            type="button"
            // Editing is the grid card's primary action, but a reader who
            // cannot edit this moment gets the reader instead of a form the
            // server would reject on save.
            onClick={() => (props.canEditMoment(p.moment) ? props.onEditMoment(p.moment) : props.onOpenMoment?.(p.moment.id))}
            class="group hover:bg-element-accent border-element-accent flex h-full flex-col gap-2 rounded border p-3 text-left transition-all"
            classList={{ 'border-highlight bg-element-accent/40': p.moment.pinned }}
        >
            {/* w-full: Chromium 130 (Electron 33) does not stretch a column-flex
                <button>'s children, so truncate/line-clamp have nothing finite to
                clip against unless the width is explicit. */}
            <div class="flex w-full min-w-0 items-center justify-between gap-2">
                <Show when={archiveName(p.moment)} fallback={<span />}>
                    <span class="text-highlight-strong min-w-0 truncate text-[10px] font-bold uppercase tracking-widest">{archiveName(p.moment)}</span>
                </Show>
                <Show when={p.moment.pinned}>
                    <span class="material-symbols-outlined text-highlight-strongest text-sm">push_pin</span>
                </Show>
            </div>
            <span class="text-sub w-full min-w-0 text-[11px] font-semibold tracking-wider">{formatDate(p.moment.timestamp)}</span>
            <span class="text-main w-full min-w-0 text-lg font-black break-words line-clamp-2">{p.moment.title || 'Untitled'}</span>
            <Show when={(p.moment.tag_ids || []).length > 0}>
                <div class="mt-auto flex w-full min-w-0 flex-wrap gap-1">
                    <For each={p.moment.tag_ids || []}>
                        {(tagId) => {
                            const tag = props.tags.find((t) => t.id === tagId)
                            if (!tag) return null
                            return (
                                <span
                                    {...tagFilterAttrs(tag.id)}
                                    class="rounded-lg px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide"
                                    classList={{ 'hover:cursor-pointer hover:opacity-80': tagFilterable() }}
                                    style={{ 'background-color': tag.color, color: contrastingTextColor(tag.color) }}
                                >
                                    #{tag.name}
                                </span>
                            )
                        }}
                    </For>
                </div>
            </Show>
        </button>
    )

    // Non-interactive preview card for the mobile swiper: archive, date, title,
    // the rendered body, and tags, with no inline action icons and no live
    // embeds. This is what makes swipe-anywhere work (nothing on the card claims
    // the gesture); tap opens the reader, long-press raises the action sheet.
    const MomentPreviewCard: Component<{ moment: Moment }> = (p) => {
        const body = () => previewMarkdown(p.moment.content)
        return (
        <div
            class="bg-element-matte border-element-accent flex h-full w-full flex-col gap-2 rounded-xl border p-5"
            classList={{ 'border-highlight': p.moment.pinned }}
        >
            <div class="flex items-center justify-between gap-2">
                <Show when={archiveName(p.moment)} fallback={<span />}>
                    <span class="text-highlight-strong text-[10px] font-bold uppercase tracking-widest">[ {archiveName(p.moment)} ]</span>
                </Show>
                <Show when={p.moment.pinned}>
                    <span class="text-highlight-strongest flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide">
                        <span class="material-symbols-outlined text-xs">push_pin</span>
                        Pinned
                    </span>
                </Show>
            </div>
            <span class="text-sub text-xs font-semibold tracking-wider">{formatDate(p.moment.timestamp)}</span>
            <h2 class="text-main font-serif text-2xl font-semibold break-words">{p.moment.title || 'Untitled'}</h2>
            <Show when={body()}>
                {/* pointer-events-none is load-bearing, not a nicety. The swiper
                    abandons the entire gesture when a press lands on a
                    button/a/input (MomentSwiper.isInteractive), so a rendered
                    link or image would be a dead patch of card where swipe,
                    tap-to-read and long-press all silently stop working. Letting
                    presses fall straight through to the card keeps the whole
                    surface swipeable, and costs nothing: the tap belongs to the
                    swiper here, not to anything in the text. */}
                <div class="moment-preview pointer-events-none min-h-0 flex-1 overflow-hidden">
                    <MarkdownText content={body()} class="text-sub text-sm" />
                </div>
            </Show>
            <Show when={(p.moment.tag_ids || []).length > 0}>
                <div class="mt-1 flex flex-wrap gap-1">
                    <For each={p.moment.tag_ids || []}>
                        {(tagId) => {
                            const tag = props.tags.find((t) => t.id === tagId)
                            if (!tag) return null
                            return (
                                <span class="rounded-lg px-2 py-1 text-[10px] font-black uppercase tracking-wide" style={{ 'background-color': tag.color, color: contrastingTextColor(tag.color) }}>
                                    #{tag.name}
                                </span>
                            )
                        }}
                    </For>
                </div>
            </Show>
        </div>
        )
    }

    // Long-press on a swiper card raises this: the same actions the reader has,
    // for a quick path that doesn't require opening the reader first.
    const momentActions = (m: Moment) => {
        const actions = []
        if (props.canPin) actions.push({ label: m.pinned ? 'Unpin' : 'Pin', icon: 'push_pin', onSelect: () => props.onTogglePin(m, !m.pinned) })
        if (props.canEditMoment(m)) actions.push({ label: 'Edit', icon: 'edit', onSelect: () => props.onEditMoment(m) })
        actions.push({ label: 'Open reader', icon: 'open_in_full', onSelect: () => props.onOpenMoment?.(m.id) })
        if (props.canDeleteMoment(m)) actions.push({ label: 'Delete', icon: 'delete', danger: true, onSelect: () => confirmDelete(m) })
        ui.actionSheet({ title: m.title || 'Untitled', actions })
    }

    return (
        <div
            class="bg-element pt flex w-full items-center justify-center gap-2 rounded-xl p-2 lg:p-4"
            classList={{ 'h-full min-h-0': !isDesktop() }}
        >
            <div
                class="flex h-full flex-col items-center gap-4"
                classList={{ 'w-[90%]': isDesktop(), 'w-full min-h-0': !isDesktop() }}
            >
                {/* Search bar + create button. overflow-x-hidden lives here
                    (not on an ancestor shared with the page's mobile scroll
                    container) so it only clips the search input/label's
                    width-transition and can't get coerced by the UA into an
                    overflow-y: auto on a box that scroll touches pass through. */}
                <div class="flex w-full items-center justify-between gap-2 overflow-x-hidden">
                    <i
                        onClick={() => {
                            setIsSearching(true)
                            if (searchBarRef) searchBarRef.focus()
                        }}
                        hidden={isSearching()}
                        class="fa-solid text-icon fa-magnifying-glass hover:cursor-pointer"
                    />
                    <input
                        ref={searchBarRef}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === 'Escape') {
                                setIsSearching(false)
                            }
                        }}
                        onInput={(e) => props.onSearch(e.currentTarget.value)}
                        value={props.searchQuery}
                        onFocusOut={() => setIsSearching(false)}
                        placeholder="Search Moments"
                        class={`${isSearching() ? 'w-full px-2 py-1' : 'w-0 p-0 opacity-0'} bg-element text-sub/80 border-plain/20 rounded-md border transition-all duration-300 focus:outline-none`}
                    />
                    <span class={`${!isSearching() ? 'w-full opacity-100' : 'w-0 opacity-0'} text-main text-center font-bold transition-opacity duration-300`}>
                        {props.searchQuery ? `Results for: ${props.searchQuery}` : ''}
                    </span>

                    {/* List / grid toggle, persisted in prefs. Desktop
                        only. Mobile always uses the card swiper below. */}
                    <button
                        onClick={() => setPref('feedView', prefs().feedView === 'grid' ? 'list' : 'grid')}
                        title={prefs().feedView === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
                        class="text-icon hover:text-highlight-strongest hidden shrink-0 transition-colors hover:cursor-pointer lg:block"
                    >
                        <span class="material-symbols-outlined text-xl">{prefs().feedView === 'grid' ? 'view_agenda' : 'grid_view'}</span>
                    </button>

                    {/* Filter popover (v2.2): date range + media/source. Desktop
                        only. On mobile filtering lives in the bottom-nav sheet. */}
                    <Show when={isDesktop()}>
                    <div class="relative shrink-0" ref={filterWrapRef}>
                        <button
                            onClick={() => setShowFilters((v) => !v)}
                            title="Filter moments"
                            class="text-icon hover:text-highlight-strongest relative flex items-center transition-colors hover:cursor-pointer"
                            classList={{ 'text-highlight-strongest': activeFilterCount(props.filters) > 0 }}
                        >
                            <span class="material-symbols-outlined text-xl">filter_list</span>
                            <Show when={activeFilterCount(props.filters) > 0}>
                                <span class="bg-highlight-strongest text-plain absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-black">
                                    {activeFilterCount(props.filters)}
                                </span>
                            </Show>
                        </button>

                        <Show when={showFilters()}>
                            <Portal>
                            <div
                                ref={filterMenuRef}
                                style={filterMenuStyle()}
                                class="bg-element-matte border-element-accent z-30 flex flex-col gap-3 rounded-xl border p-4 shadow-2xl"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <div class="flex items-center justify-between">
                                    <span class="text-main text-xs font-bold tracking-widest uppercase">Filters</span>
                                    <button
                                        onClick={() => setShowFilters(false)}
                                        class="text-sub hover:text-plain transition-colors"
                                    >
                                        <span class="material-symbols-outlined text-base">close</span>
                                    </button>
                                </div>

                                <label class="flex flex-col gap-1">
                                    <span class="text-sub text-xs font-bold">From</span>
                                    <input
                                        type="date"
                                        value={props.filters.from}
                                        max={props.filters.to || undefined}
                                        onInput={(e) => patchFilter({ from: e.currentTarget.value })}
                                        class="bg-element text-main border-element-accent rounded-md border px-2 py-1 text-sm focus:border-highlight focus:outline-none"
                                    />
                                </label>
                                <label class="flex flex-col gap-1">
                                    <span class="text-sub text-xs font-bold">To</span>
                                    <input
                                        type="date"
                                        value={props.filters.to}
                                        min={props.filters.from || undefined}
                                        onInput={(e) => patchFilter({ to: e.currentTarget.value })}
                                        class="bg-element text-main border-element-accent rounded-md border px-2 py-1 text-sm focus:border-highlight focus:outline-none"
                                    />
                                </label>

                                <label class="flex items-center justify-between gap-2 cursor-pointer">
                                    <span class="text-main text-sm font-bold">Has media</span>
                                    <input
                                        type="checkbox"
                                        checked={props.filters.media}
                                        onChange={(e) => patchFilter({ media: e.currentTarget.checked })}
                                        class="accent-highlight-strongest h-4 w-4 cursor-pointer"
                                    />
                                </label>
                                <label class="flex items-center justify-between gap-2 cursor-pointer">
                                    <span class="text-main text-sm font-bold">Has link</span>
                                    <input
                                        type="checkbox"
                                        checked={props.filters.link}
                                        onChange={(e) => patchFilter({ link: e.currentTarget.checked })}
                                        class="accent-highlight-strongest h-4 w-4 cursor-pointer"
                                    />
                                </label>

                                <Show when={activeFilterCount(props.filters) > 0}>
                                    <button
                                        onClick={clearFilters}
                                        class="text-sub hover:text-highlight-strongest mt-1 text-xs font-bold hover:cursor-pointer"
                                    >
                                        Clear filters
                                    </button>
                                </Show>
                            </div>
                            </Portal>
                        </Show>
                    </div>
                    </Show>
                </div>

                {/* Inline creator (SmartEditor, 4.5) or the classic button.
                    Outside the loading gate on purpose: posting reloads the
                    feed, and a composer inside the gate is torn down and
                    rebuilt by its own submit, taking the picked archive and
                    the keyboard focus with it. */}
                <Show when={props.showComposer}>
                    <Show
                        when={inlineCreator()}
                        fallback={
                            <button
                                onClick={props.onCreateMoment}
                                class="bg-element-accent hover:border-highlight border-element-accent flex w-full items-center justify-center gap-2 rounded-xl border p-4 text-center font-bold transition-all duration-100 hover:scale-[1.02] hover:cursor-pointer"
                            >
                                <span class="material-symbols-outlined text-xl">add</span>
                                <span class="text-sub">New Moment</span>
                            </button>
                        }
                    >
                        <div class="w-full">{inlineCreator() as any}</div>
                    </Show>
                </Show>

                <Show
                    when={!props.loading}
                    fallback={
                        <div class="text-sub text-center py-8">
                            <span class="material-symbols-outlined text-4xl animate-spin">progress_activity</span>
                            <p class="mt-2 text-sm">Loading...</p>
                        </div>
                    }
                >
                    <Show when={props.moments.length === 0 && props.pinnedMoments.length === 0}>
                        <div class="text-sub text-center py-12">
                            <span class="material-symbols-outlined text-4xl">inbox</span>
                            {/* Don't tell someone who cannot write to write. */}
                            <p class="mt-2 text-sm">
                                {props.canCreate
                                    ? 'No moments yet. Create one to get started.'
                                    : 'No moments yet.'}
                            </p>
                        </div>
                    </Show>

                    {/* Mobile: one continuous swipeable card sequence (pinned
                        first) replaces the list entirely, with no separate
                        pinned section, no list/grid toggle. Desktop keeps
                        the classic pinned section + list/grid view. */}
                    <Show
                        when={isDesktop()}
                        fallback={
                            <Show when={mobileMoments().length > 0}>
                                <MomentSwiper
                                    moments={mobileMoments()}
                                    hasMore={props.hasMore}
                                    onLoadMore={props.onLoadMore}
                                    onOpenMoment={props.onOpenMoment}
                                    onLongPress={momentActions}
                                    card={(moment) => <MomentPreviewCard moment={moment} />}
                                />
                            </Show>
                        }
                    >
                        {/* Pinned section, hidden while searching to
                            avoid mixing pinned items into result relevance. */}
                        <Show when={!props.searchQuery && props.pinnedMoments.length > 0}>
                            <div class="flex w-full flex-col items-center gap-4 rounded-xl">
                                <div class="flex w-full items-center gap-2">
                                    <span class="material-symbols-outlined text-highlight-strongest text-base">push_pin</span>
                                    <span class="text-sub text-xs font-bold uppercase tracking-widest">Pinned</span>
                                    <Line class="bg-element-accent h-0.5 flex-1" />
                                </div>
                                <For each={props.pinnedMoments}>
                                    {(moment) => <MomentCard moment={moment} pinned />}
                                </For>
                            </div>
                        </Show>

                        <div class="flex h-full w-full flex-col items-center gap-4 rounded-xl">
                            <Show
                                when={prefs().feedView === 'grid'}
                                fallback={
                                    <For each={props.moments}>{(moment) => <MomentCard moment={moment} />}</For>
                                }
                            >
                                <div class="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                    <For each={props.moments}>{(moment) => <MomentGridCard moment={moment} />}</For>
                                </div>
                            </Show>
                        </div>

                        {/* Infinite scroll: the sentinel below is watched by
                            loadMoreObserver, which auto-appends the next page.
                            A spinner shows while a page is in flight. */}
                        <Show when={props.loadingMore}>
                            <div class="flex w-full justify-center py-4">
                                <span class="material-symbols-outlined text-sub animate-spin text-2xl">
                                    progress_activity
                                </span>
                            </div>
                        </Show>
                        <div
                            ref={(el) => {
                                // Only ever one sentinel is mounted at a time;
                                // drop any prior observation before re-observing.
                                loadMoreObserver?.disconnect()
                                loadMoreObserver?.observe(el)
                            }}
                            class="h-px w-full"
                            aria-hidden="true"
                        />
                    </Show>
                </Show>
            </div>
        </div>
    )
}

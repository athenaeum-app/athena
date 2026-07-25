import { For, Show, createSignal, onCleanup, onMount, type Component, type JSX } from 'solid-js'
import { prefs, type MenuWidgetId } from '../prefs'
import { api, type Moment, type Tag, type ServerStats } from '../api'
import { users, loadUsers } from '../users'
import { useAuth } from '../auth'
import { ChatPanel } from './ChatPanel'
import { ChatPreview } from './ChatPreview'
import { visibleTags } from '../tagFacets'

// Rich desktop Menu (§ Menu revamp). A full-height panel: a sticky nav hub of
// actions + identity, then a scrollable stack of toggleable widgets whose order
// and enabled-state come from prefs.menuWidgets (configured in the Widgets
// settings category). The compact "minimal" menu (FilterBar) remains available
// via the menuLayout pref.

interface MenuPanelProps {
    onOpenChat: () => void
    onOpenSettings: () => void
    onOpenAdmin: () => void
    onOpenTodos: () => void
    onOpenCanvas: () => void
    username: string
    isOwner: boolean
    canManageUsers: boolean
    canManageRoles: boolean
    canViewAuditLog: boolean
    // Widget data / handlers (owned by App).
    pinnedMoments: Moment[]
    tags: Tag[]
    selectedTagIds: string[]
    onToggleTag: (id: string) => void
    onOpenMoment: (id: string) => void
    onOpenTodoEmbed: (id: string) => void
    onOpenCanvasEmbed: (id: string) => void
    // Tags that still match at least one moment under the current filter; see
    // tagFacets.ts. null until the first facet response lands.
    availableTagIds?: Set<string> | null
}

const initials = (name: string) => name.trim().slice(0, 2).toUpperCase() || '?'

export const MenuPanel: Component<MenuPanelProps> = (props) => {
    const auth = useAuth()
    const hasAdmin = () => props.canManageUsers || props.canManageRoles || props.canViewAuditLog

    // Only enabled widgets, in their configured order.
    const activeWidgets = () => prefs().menuWidgets.filter((w) => w.enabled)

    const HubButton: Component<{ icon: string; label: string; onClick: () => void }> = (b) => (
        <button
            type="button"
            onClick={b.onClick}
            title={b.label}
            aria-label={b.label}
            class="bg-element-matte text-sub hover:text-main hover:border-highlight border-element-accent flex h-9 w-9 items-center justify-center rounded-lg border transition-colors hover:cursor-pointer"
        >
            <span class="material-symbols-outlined text-xl">{b.icon}</span>
        </button>
    )

    const NavHub = () => (
        <div class="shrink-0">
            <span class="text-sub text-lg font-bold tracking-widest">Menu</span>
            <div class="mt-3 flex flex-wrap items-center gap-1">
                <HubButton icon="message" label="Chat" onClick={props.onOpenChat} />
                <HubButton icon="checklist" label="Todos" onClick={props.onOpenTodos} />
                <HubButton icon="dashboard" label="Canvas" onClick={props.onOpenCanvas} />
                <HubButton icon="settings" label="Settings" onClick={props.onOpenSettings} />
                <Show when={hasAdmin()}>
                    <HubButton icon="admin_panel_settings" label="Admin" onClick={props.onOpenAdmin} />
                </Show>
            </div>
            <div class="bg-element-matte mt-3 flex items-center gap-2 rounded-lg p-2 shadow-inner">
                <span class="material-symbols-outlined text-highlight text-lg">person</span>
                <span class="text-main truncate text-sm font-bold">{props.username}</span>
                <Show when={props.isOwner}>
                    <span class="text-highlight-strongest text-xs font-bold">★ Owner</span>
                </Show>
            </div>
        </div>
    )

    // Shared card chrome for a widget.
    const Card: Component<{ title: string; children: JSX.Element; bodyClass?: string }> = (c) => (
        <div class="bg-element-matte border-element-accent flex flex-col rounded-lg border">
            <p class="text-sub border-element-accent border-b px-3 py-2 text-[11px] font-bold uppercase tracking-widest">{c.title}</p>
            <div class={`p-3 ${c.bodyClass ?? ''}`}>{c.children}</div>
        </div>
    )

    // --- Chat (docked) ---
    // Preview mode is the default: a compact read-only peek at the latest
    // messages, so the column stays uncluttered; click it to open the full
    // ChatModal. Opting in to prefs.chatWidgetFull docks the full panel +
    // composer instead.
    //
    // w-full on both children is load-bearing, not decoration. Electron 33
    // ships Chromium 130, which does not stretch a column-flex <button>'s
    // children to the button's own width: they lay out at max-content and
    // spill straight out of the button box. A single long chat line then
    // measured ~6200px inside a 278px card, and the widget stack above
    // (lg:overflow-y-auto, which makes overflow-x auto too) grew a horizontal
    // scrollbar across the whole Menu column. Newer Chromium stretches
    // correctly, so this never reproduced in a browser or in the Playwright
    // e2e run, only in the desktop app. Sizing the children explicitly gives
    // the truncate below something finite to clip against everywhere.
    //
    // Clipping the button with overflow-hidden looks like the obvious belt to
    // add here; it is not. On the same Chromium it also stops the button
    // sizing to its own content, collapsing the card to the header row and
    // hiding the preview entirely. The explicit widths are the whole fix.
    const ChatCard = () => (
        <Show
            when={prefs().chatWidgetFull}
            fallback={
                <button
                    type="button"
                    onClick={props.onOpenChat}
                    class="bg-element-matte border-element-accent hover:border-highlight flex w-full flex-col rounded-lg border text-left transition-colors hover:cursor-pointer"
                >
                    <p class="text-sub border-element-accent flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-[11px] font-bold uppercase tracking-widest">
                        <span>Chat</span>
                        <span class="material-symbols-outlined text-sm opacity-50">open_in_new</span>
                    </p>
                    <div class="w-full min-w-0 p-3">
                        <ChatPreview />
                    </div>
                </button>
            }
        >
            <div class="border-element-accent bg-element-matte h-[26rem] shrink-0 overflow-hidden rounded-lg border">
                <ChatPanel
                    class="h-full"
                    onOpenMoment={props.onOpenMoment}
                    onOpenTodo={props.onOpenTodoEmbed}
                    onOpenCanvas={props.onOpenCanvasEmbed}
                />
            </div>
        </Show>
    )

    // --- Members roster ---
    const UsersCard = () => {
        onMount(() => {
            loadUsers()
            // The directory is otherwise fetched once and memoized (users.ts);
            // re-poll it (forced) so each member's online dot stays live.
            const interval = window.setInterval(() => loadUsers(true), 15000)
            onCleanup(() => window.clearInterval(interval))
        })
        const roster = () => Object.values(users()).sort((a, b) => a.username.localeCompare(b.username))
        return (
            <Card title={`Members · ${roster().length}`} bodyClass="flex flex-col gap-0.5">
                <Show when={roster().length > 0} fallback={<p class="text-sub/60 text-xs italic">No members to show.</p>}>
                    <For each={roster()}>
                        {(u) => (
                            <div class="hover:bg-element-accent flex items-center gap-2 rounded-md px-1.5 py-1">
                                <span class="relative flex h-6 w-6 shrink-0 items-center justify-center">
                                    <span class="bg-element-accent flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-black">{initials(u.username)}</span>
                                    <Show when={u.online}>
                                        <span class="border-element-matte absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 bg-green-500" title="Online" />
                                    </Show>
                                </span>
                                <span class="text-main truncate text-sm">{u.username}</span>
                                <Show when={u.id === auth.user()?.id}>
                                    <span class="text-sub/70 ml-auto text-[10px]">you</span>
                                </Show>
                            </div>
                        )}
                    </For>
                </Show>
            </Card>
        )
    }

    // --- Pinned moments ---
    const PinnedCard = () => (
        <Card title="Pinned" bodyClass="flex flex-col gap-1">
            <Show when={props.pinnedMoments.length > 0} fallback={<p class="text-sub/60 text-xs italic">No pinned moments.</p>}>
                <For each={props.pinnedMoments}>
                    {(m) => (
                        <button
                            type="button"
                            onClick={() => props.onOpenMoment(m.id)}
                            class="text-sub hover:bg-element-accent hover:text-main flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:cursor-pointer"
                        >
                            <span class="material-symbols-outlined text-highlight text-sm">push_pin</span>
                            <span class="min-w-0 truncate">{m.title || 'Untitled'}</span>
                        </button>
                    )}
                </For>
            </Show>
        </Card>
    )

    // --- Quick stats (server totals) ---
    const StatsCard = () => {
        const [stats, setStats] = createSignal<ServerStats['stats'] | null>(null)
        onMount(async () => {
            try {
                setStats((await api.getStats()).stats)
            } catch {
                /* best-effort */
            }
        })
        const Tile = (p: { label: string; value: number }) => (
            <div class="bg-element flex flex-col items-center rounded-md px-2 py-2">
                <span class="text-main text-lg font-black">{p.value}</span>
                <span class="text-sub text-[10px] uppercase tracking-wide">{p.label}</span>
            </div>
        )
        return (
            <Card title="Stats">
                <Show when={stats()} fallback={<p class="text-sub/60 text-xs italic">Loading…</p>}>
                    {(s) => (
                        <div class="grid grid-cols-3 gap-2">
                            <Tile label="Moments" value={s().moments_count} />
                            <Tile label="Tags" value={s().tags_count} />
                            <Tile label="Archives" value={s().archives_count} />
                            <Tile label="Members" value={s().users_count} />
                            <Tile label="Messages" value={s().chat_count} />
                        </div>
                    )}
                </Show>
            </Card>
        )
    }

    // --- Tags (quick filter chips) ---
    // Same offerable-tag rule as the desktop TagBar and the mobile filter
    // sheet: these chips drive the same selectedTagIds, so they must agree.
    const TagsCard = () => {
        const shown = () => visibleTags(props.tags, props.availableTagIds, props.selectedTagIds)
        return (
        <Card title="Tags" bodyClass="flex flex-wrap gap-1.5">
            <Show when={shown().length > 0} fallback={<p class="text-sub/60 text-xs italic">No tags to filter by.</p>}>
                <For each={shown()}>
                    {(t) => {
                        const selected = () => props.selectedTagIds.includes(t.id)
                        return (
                            <button
                                type="button"
                                onClick={() => props.onToggleTag(t.id)}
                                class="rounded-lg px-2 py-1 text-xs font-black tracking-wide uppercase transition-all hover:cursor-pointer"
                                classList={{ 'ring-2 ring-highlight-strongest': selected() }}
                                style={selected() ? { 'background-color': t.color, color: '#fff' } : { 'background-color': 'var(--color-element-accent)' }}
                            >
                                #{t.name}
                            </button>
                        )
                    }}
                </For>
            </Show>
        </Card>
        )
    }

    const renderWidget = (id: MenuWidgetId): JSX.Element => {
        switch (id) {
            case 'chat':
                return <ChatCard />
            case 'users':
                return <UsersCard />
            case 'pinned':
                return <PinnedCard />
            case 'stats':
                return <StatsCard />
            case 'tags':
                return <TagsCard />
        }
    }

    return (
        <div class="bg-element flex h-full flex-col gap-3 rounded-xl p-4 text-left">
            <NavHub />
            <div class="flex min-h-0 flex-1 flex-col gap-3 lg:overflow-y-auto">
                <For each={activeWidgets()}>{(w) => renderWidget(w.id)}</For>
            </div>
        </div>
    )
}

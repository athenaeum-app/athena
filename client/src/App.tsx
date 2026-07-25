import { createSignal, For, Show, onMount, onCleanup, createEffect, Switch, Match, type Component } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { useQuery } from '@tanstack/solid-query'
import { queryClient, qk } from './query'
import { useAuth } from './auth'
import { useUI } from './ui'
import { hasPermission } from './permissions'
import { keybinds, matchEvent } from './keybinds'
import { getArchiveTheme, resolveUserThemeColors, themeColorVars } from './themes'
import { prefs, setPref, DEFAULT_PREFS } from './prefs'
import { api, type Archive, type Moment, type Tag } from './api'
import { loadUsers } from './users'
import { TagBar } from './components/TagBar'
import { ArchivesBar } from './components/ArchivesBar'
import { Feed, EMPTY_FEED_FILTERS, activeFilterCount, type FeedFilters } from './components/Feed'
import { FilterBar } from './components/FilterBar'
import { BottomNav, type NavTarget } from './components/BottomNav'
import { Sheet } from './components/Sheet'
import { MobileFilterSheet } from './components/MobileFilterSheet'
import { MobileArchivesSheet } from './components/MobileArchivesSheet'
import { MobileMoreSheet } from './components/MobileMoreSheet'
import { useIsDesktop } from './media'
import { Line } from './components/Line'
import { ChatModal } from './components/ChatModal'
import { Editor } from './components/Editor'
import { SettingsModal } from './components/SettingsModal'
import { AdminModal } from './components/AdminModal'
import { TodoModule } from './components/TodoModule'
import { CanvasModule } from './components/CanvasModule'
import { LibrariesPanel, librariesSwitcherVisible } from './components/LibrariesPanel'
import { MenuPanel } from './components/MenuPanel'
import { FocusedMomentModal } from './components/FocusedMomentModal'
import { Lightbox } from './components/Lightbox'

// Moments are cheap rows, so we pull a large page at a time and rely on
// infinite scroll to fetch the next one automatically (no manual "load more").
// Server clamps `limit` to 500; 100 keeps each page snappy while making manual
// paging effectively invisible on normal libraries.
const MOMENTS_PAGE_SIZE = 100

export const App: Component = () => {
    const auth = useAuth()
    const ui = useUI()
    const navigate = useNavigate()

    // Permission gates (bits mirror server/internal/permissions/permissions.go).
    const perms = () => auth.user()?.permissions || 0
    const canCreateMoment = () => hasPermission(perms(), 1) // CREATE_MOMENT
    const canManageArchives = () => hasPermission(perms(), 6) // MANAGE_ARCHIVES
    const canManageTags = () => hasPermission(perms(), 7) // MANAGE_TAGS
    const canPin = () => hasPermission(perms(), 20) // PIN_MOMENT
    const canManageTodos = () => hasPermission(perms(), 21) // MANAGE_TODOS
    const canManageCanvas = () => hasPermission(perms(), 22) // MANAGE_CANVAS
    // Editing and deleting a moment are split into own/any variants server-side
    // (bits 2-5), so the gate depends on who wrote it rather than being a flat
    // capability. A moment with no author_id (legacy v1 rows) can't establish
    // ownership, so only the "any" bits reach it.
    const ownsMoment = (m: Moment) => !!m.author_id && m.author_id === auth.user()?.id
    const canEditMoment = (m: Moment) => hasPermission(perms(), 3) || (hasPermission(perms(), 2) && ownsMoment(m))
    const canDeleteMoment = (m: Moment) => hasPermission(perms(), 5) || (hasPermission(perms(), 4) && ownsMoment(m))

    // Archives + tags are the first surfaces on solid-query (Task 0.1): simple
    // mount-once reads, cached and invalidated from the event poll below. The
    // accessors keep the `archives()` / `tags()` call shape the rest of the
    // component already uses.
    const archivesQuery = useQuery(() => ({ queryKey: qk.archives, queryFn: () => api.listArchives() }))
    const tagsQuery = useQuery(() => ({ queryKey: qk.tags, queryFn: () => api.listTags() }))
    const archives = () => archivesQuery.data ?? []
    const tags = () => tagsQuery.data ?? []
    const refetchArchives = () => queryClient.invalidateQueries({ queryKey: qk.archives })
    const refetchTags = () => queryClient.invalidateQueries({ queryKey: qk.tags })

    const [selectedArchive, setSelectedArchive] = createSignal<string | null>(null)
    const [selectedTagIds, setSelectedTagIds] = createSignal<string[]>([])
    const [searchQuery, setSearchQuery] = createSignal('')
    // Server-side feed filters (v2.2): date range + media/source heuristics.
    const [feedFilters, setFeedFilters] = createSignal<FeedFilters>({ ...EMPTY_FEED_FILTERS })
    const [moments, setMoments] = createSignal<Moment[]>([])
    const [pinnedMoments, setPinnedMoments] = createSignal<Moment[]>([])
    const [loadingMoments, setLoadingMoments] = createSignal(false)
    // Distinct from `loadingMoments`: this tracks an infinite-scroll append so
    // it doesn't blank the whole feed behind the initial-load spinner.
    const [loadingMore, setLoadingMore] = createSignal(false)
    const [cursor, setCursor] = createSignal<{ ts: string; id: string } | null>(null)
    const [hasMore, setHasMore] = createSignal(false)
    // Bumped on every reset load to invalidate slower in-flight appends.
    let loadGeneration = 0
    const [showEditor, setShowEditor] = createSignal(false)
    const [editingMoment, setEditingMoment] = createSignal<Moment | null>(null)
    // A referenced moment opened in the read-only focused reader (from a task or
    // a canvas card). Held by id so it works even for moments not in the feed.
    const [focusMomentId, setFocusMomentId] = createSignal<string | null>(null)
    const [showChat, setShowChat] = createSignal(false)
    const [showSettings, setShowSettings] = createSignal(false)
    const [showAdmin, setShowAdmin] = createSignal(false)
    const [showTodos, setShowTodos] = createSignal(false)
    const [showCanvas, setShowCanvas] = createSignal(false)
    // Focus-layout drawers: the side panels collapse into slide-in
    // drawers toggled by floating buttons.
    const [showArchivesDrawer, setShowArchivesDrawer] = createSignal(false)
    const [showMenuDrawer, setShowMenuDrawer] = createSignal(false)

    // Mobile app-shell (§ mobile refresh): below lg the layout becomes a fixed
    // shell: feed swiper in the middle, a bottom nav, and the side panels moved
    // into bottom sheets. `mobileSheet` is which sheet (if any) is open.
    const isDesktop = useIsDesktop()
    const [mobileSheet, setMobileSheet] = createSignal<'archives' | 'filter' | 'more' | null>(null)
    const toggleSheet = (s: 'archives' | 'filter' | 'more') => setMobileSheet((cur) => (cur === s ? null : s))
    // Any admin permission (users/roles/audit) or the superuser bit gates the
    // Admin entry, same test the desktop FilterBar uses.
    const canAdmin = () => {
        const permissions = auth.user()?.permissions || 0
        return !!((permissions & (1 << 15)) || (permissions & (1 << 16)) || (permissions & (1 << 18)) || (permissions & (1 << 19)))
    }

    // Resizable Feed column: `resizeWidth` holds the live px width while
    // dragging the divider; otherwise the persisted pref is used.
    const FEED_MIN = 560
    const FEED_MAX = 1440
    const [resizeWidth, setResizeWidth] = createSignal<number | null>(null)
    const feedWidth = () => resizeWidth() ?? Math.min(FEED_MAX, Math.max(FEED_MIN, prefs().feedWidth))
    const startFeedResize = (e: PointerEvent) => {
        e.preventDefault()
        const startX = e.clientX
        const start = feedWidth()
        // The feed is centred, so widening it moves each edge out by half the
        // width change. Doubling the delta keeps the divider under the cursor.
        const onMove = (ev: PointerEvent) =>
            setResizeWidth(Math.min(FEED_MAX, Math.max(FEED_MIN, start + 2 * (ev.clientX - startX))))
        const onUp = () => {
            const w = resizeWidth()
            if (w != null) setPref('feedWidth', w)
            setResizeWidth(null)
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
    }

    let libraryVersion = 0
    let pollTimer: number | undefined

    // Auth guard: redirect to /setup when the server has no users yet,
    // otherwise to /login. The setup check is only done once when we
    // discover there's no session, to avoid hitting the endpoint on every
    // render.
    let setupChecked = false
    createEffect(() => {
        if (auth.loading()) return
        if (auth.user()) return
        if (setupChecked) return
        setupChecked = true
        api.getSetup()
            .then((s) => {
                if (s.needs_setup) navigate('/setup')
                else navigate('/login')
            })
            .catch(() => navigate('/login'))
    })

    const loadMoments = async (reset = false) => {
        // Infinite scroll can fire onLoadMore repeatedly; ignore appends while
        // one is in flight or when the server has nothing more to give.
        if (!reset && (loadingMore() || loadingMoments() || !hasMore())) return
        if (reset) setLoadingMoments(true)
        else setLoadingMore(true)
        // Generation token: every reset (archive/search/filter change) bumps it,
        // so a slow in-flight append can't splice stale, wrong-filter moments
        // onto a list that has since been reset.
        const gen = reset ? ++loadGeneration : loadGeneration
        try {
            const params: Parameters<typeof api.listMoments>[0] = {
                limit: MOMENTS_PAGE_SIZE,
                q: searchQuery() || undefined,
            }
            if (selectedArchive()) params.archive = selectedArchive()!
            // Translate the date-picker values (local YYYY-MM-DD) into RFC3339
            // day bounds: `from` = start of that day, `to` = end of that day.
            const filters = feedFilters()
            if (filters.from) params.from = new Date(`${filters.from}T00:00:00`).toISOString()
            if (filters.to) params.to = new Date(`${filters.to}T23:59:59.999`).toISOString()
            if (filters.media) params.media = true
            if (filters.link) params.link = true
            if (!reset && cursor()) {
                params.cursor_ts = cursor()!.ts
                params.cursor_id = cursor()!.id
            }
            // Guard against a null/empty body so an empty library never
            // crashes the feed on `.length`.
            const result = (await api.listMoments(params)) ?? []
            // A newer reset superseded this request while it was in flight;
            // drop its results so we don't corrupt the current list/cursor.
            if (gen !== loadGeneration) return
            if (reset) {
                setMoments(result)
                setCursor(null)
            } else {
                setMoments((prev) => [...prev, ...result])
            }
            setHasMore(result.length === MOMENTS_PAGE_SIZE)
            if (result.length > 0) {
                const last = result[result.length - 1]
                setCursor({ ts: last.timestamp, id: last.id })
            }
        } catch (err) {
            console.error('Failed to load moments:', err)
        } finally {
            if (reset) {
                // Only the latest reset owns the initial-load spinner; a
                // superseded one clearing it would flicker the newer load.
                if (gen === loadGeneration) setLoadingMoments(false)
            } else {
                // Appends are single-in-flight, so this call always owns it.
                setLoadingMore(false)
            }
        }
    }

    const loadPinned = async () => {
        try {
            setPinnedMoments((await api.listPinnedMoments()) ?? [])
        } catch {
            /* pinned section is best-effort */
        }
    }

    const handleTogglePin = async (moment: Moment, pinned: boolean) => {
        // Optimistic: reflect the pin instantly, reconcile on reply, roll back
        // on failure (Task 0.1 acceptance criteria).
        const prevMoments = moments()
        const prevPinned = pinnedMoments()
        setMoments((prev) => prev.map((m) => (m.id === moment.id ? { ...m, pinned } : m)))
        if (pinned) {
            setPinnedMoments((prev) => (prev.some((m) => m.id === moment.id) ? prev : [{ ...moment, pinned: true }, ...prev]))
        } else {
            setPinnedMoments((prev) => prev.filter((m) => m.id !== moment.id))
        }
        try {
            const updated = await api.pinMoment(moment.id, pinned)
            setMoments((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
            await loadPinned()
        } catch (err: any) {
            setMoments(prevMoments)
            setPinnedMoments(prevPinned)
            ui.toast(err.message || 'Failed to update pin', 'error')
        }
    }

    // Re-read the session's permissions and reload everything they gate.
    // Granting a permission is the interesting direction: the surfaces a user
    // couldn't reach answered 403 and cached that emptiness, so simply
    // re-rendering with the new bits would still show an empty library.
    const onPermissionsChanged = async () => {
        await auth.refresh()
        refetchArchives()
        refetchTags()
        await loadMoments(true)
        await loadPinned()
    }

    // Delta sync polling
    const pollEvents = async () => {
        try {
            const data = await api.getEvents(libraryVersion)
            if (data.events.length === 0) return
            libraryVersion = data.current_version

            let permissionsChanged = false
            let directoryChanged = false
            for (const event of data.events) {
                if (event.type === 'MOMENT_CREATED' || event.type === 'MOMENT_UPDATED') {
                    const moment = JSON.parse(event.payload!) as Moment
                    setMoments((prev) => {
                        const idx = prev.findIndex((m) => m.id === moment.id)
                        if (idx >= 0) {
                            const copy = [...prev]
                            copy[idx] = moment
                            return copy
                        }
                        return [moment, ...prev]
                    })
                } else if (event.type === 'MOMENT_PINNED') {
                    const moment = JSON.parse(event.payload!) as Moment
                    setMoments((prev) => prev.map((m) => (m.id === moment.id ? moment : m)))
                    loadPinned()
                } else if (event.type === 'MOMENT_DELETED') {
                    setMoments((prev) => prev.filter((m) => m.id !== event.target_id))
                    setPinnedMoments((prev) => prev.filter((m) => m.id !== event.target_id))
                } else if (event.type === 'ARCHIVE_CREATED' || event.type === 'ARCHIVE_UPDATED' || event.type === 'ARCHIVE_DELETED') {
                    refetchArchives()
                } else if (event.type === 'TAG_CREATED' || event.type === 'TAG_UPDATED' || event.type === 'TAG_DELETED') {
                    refetchTags()
                } else if (
                    event.type === 'ROLE_CREATED' ||
                    event.type === 'ROLE_UPDATED' ||
                    event.type === 'ROLE_DELETED' ||
                    event.type === 'USER_ROLES_UPDATED'
                ) {
                    // Permissions are baked into the /users/me response the
                    // session was loaded with, so a role edit used to sit
                    // invisible until the client was thrown away and rebuilt
                    // (swapping libraries and back). Re-read them here so a
                    // permission change lands within one poll instead.
                    // Deferred: a batch can hold several role events, and
                    // re-reading once at the end is the same result.
                    permissionsChanged = true
                } else if (event.type === 'USER_UPDATED') {
                    // Someone renamed themselves. The directory is fetched once
                    // and memoized, so without this every surface that resolves
                    // an author id (chat, the roster, the audit log) would
                    // keep showing the old name for the life of the session.
                    directoryChanged = true
                }
            }
            if (permissionsChanged) await onPermissionsChanged()
            if (directoryChanged) await loadUsers(true)
        } catch (err) {
            // Silent fail, will retry next poll
        }
    }

    // Close whichever overlay is open, topmost-first. Returns true if it
    // consumed the keypress (so Escape doesn't also do something else).
    const closeTopOverlay = (): boolean => {
        if (focusMomentId()) return setFocusMomentId(null), true
        if (showEditor()) return setShowEditor(false), true
        if (showChat()) return setShowChat(false), true
        if (showSettings()) return setShowSettings(false), true
        if (showAdmin()) return setShowAdmin(false), true
        if (showTodos()) return setShowTodos(false), true
        if (showCanvas()) return setShowCanvas(false), true
        return false
    }

    const handleGlobalKey = (e: KeyboardEvent) => {
        if (!auth.user()) return
        const target = e.target as HTMLElement | null
        const editable =
            !!target &&
            (target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'SELECT' ||
                target.isContentEditable)

        const binds = keybinds()
        for (const action of Object.keys(binds) as (keyof typeof binds)[]) {
            const combo = binds[action]
            if (!matchEvent(e, combo)) continue
            const allowInInput = action === 'closeOverlay'
            const hasMod = /Mod|Alt/.test(combo)
            if (editable && !allowInInput && !hasMod) continue

            switch (action) {
                case 'focusSearch':
                    e.preventDefault()
                    window.dispatchEvent(new CustomEvent('athena:focus-search'))
                    return
                case 'openChat':
                    e.preventDefault()
                    setShowChat(true)
                    return
                case 'openSettings':
                    e.preventDefault()
                    setShowSettings(true)
                    return
                case 'newMoment':
                    e.preventDefault()
                    handleCreateMoment()
                    return
                case 'closeOverlay':
                    if (closeTopOverlay()) e.preventDefault()
                    return
            }
        }
    }

    onMount(() => {
        loadMoments(true)
        loadPinned()
        pollTimer = window.setInterval(pollEvents, 3000)
        window.addEventListener('keydown', handleGlobalKey)
    })

    onCleanup(() => {
        if (pollTimer) clearInterval(pollTimer)
        window.removeEventListener('keydown', handleGlobalKey)
    })

    const handleArchiveSelect = (id: string | null) => {
        setSelectedArchive(id)
        setSearchQuery('')
        loadMoments(true)
    }

    const handleSearch = (q: string) => {
        setSearchQuery(q)
        loadMoments(true)
    }

    const handleChangeFilters = (f: FeedFilters) => {
        setFeedFilters(f)
        loadMoments(true)
    }

    // The composer is hidden without CREATE_MOMENT, but this is the single
    // choke point every entry into it goes through: the feed button, the
    // mobile nav, and the Ctrl+M keybind, which no amount of hiding covers.
    const handleCreateMoment = () => {
        if (!canCreateMoment()) return
        setEditingMoment(null)
        setShowEditor(true)
    }

    const handleEditMoment = (moment: Moment) => {
        setEditingMoment(moment)
        setShowEditor(true)
    }

    // When a task's "link a moment" flow chooses "create a new one", the editor
    // opens in create mode and this callback links the freshly-created moment
    // back to the task (kept in a signal; store a fn via the () => fn form).
    const [pendingLink, setPendingLink] = createSignal<((momentId: string) => void) | null>(null)
    const handleCreateMomentToLink = (link: (momentId: string) => void) => {
        setPendingLink(() => link)
        setEditingMoment(null)
        setShowEditor(true)
    }

    const handleSaveMoment = async (title: string, content: string, tagIds: string[], archiveId: string) => {
        if (editingMoment()) {
            await api.updateMoment(editingMoment()!.id, title, content, tagIds, editingMoment()!.updated_at)
        } else {
            const created = await api.createMoment(archiveId, title, content, tagIds)
            const link = pendingLink()
            if (link && created) {
                link(created.id)
                setPendingLink(null)
            }
        }
        setShowEditor(false)
        loadMoments(true)
        refetchArchives()
        refetchTags()
    }

    const handleDeleteMoment = async (id: string) => {
        await api.deleteMoment(id)
        setMoments((prev) => prev.filter((m) => m.id !== id))
    }

    // Inline creator (SmartEditor, 4.5): create-only, then refresh the feed.
    const handleInlineCreate = async (title: string, content: string, tagIds: string[], archiveId: string) => {
        await api.createMoment(archiveId, title, content, tagIds)
        loadMoments(true)
        refetchArchives()
        refetchTags()
    }

    const handleInlineCreateTag = async (name: string, color: string): Promise<Tag> => {
        const tag = await api.createTag(name, color)
        refetchTags()
        return tag
    }

    // Lightweight index for the [[reference]] autocomplete in the editor.
    const momentIndex = () =>
        [...pinnedMoments(), ...moments()].map((m) => ({ id: m.id, title: m.title || 'Untitled' }))

    const handleDeleteArchive = async (archive: Archive) => {
        const ok = await ui.confirm({
            title: 'Delete archive?',
            message: `Archive "${archive.name}" and its moments will be permanently deleted. This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
            confirmText: archive.name,
        })
        if (!ok) return
        try {
            await api.deleteArchive(archive.id)
            if (selectedArchive() === archive.id) {
                setSelectedArchive(null)
                loadMoments(true)
            }
            refetchArchives()
            ui.toast('Archive deleted.', 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Failed to delete archive', 'error')
        }
    }

    const handleRenameArchive = async (archive: Archive, name: string) => {
        try {
            await api.updateArchive(archive.id, name)
            refetchArchives()
            ui.toast('Archive renamed.', 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Failed to rename archive', 'error')
        }
    }

    const handleDeleteTag = async (tag: Tag) => {
        const ok = await ui.confirm({
            title: 'Delete tag?',
            message: `Tag "#${tag.name}" will be removed from all moments. This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
        })
        if (!ok) return
        try {
            await api.deleteTag(tag.id)
            setSelectedTagIds((prev) => prev.filter((id) => id !== tag.id))
            // Drop the tag id from loaded moments so tag filtering stays
            // consistent without waiting for a refetch. The server
            // cascades moment_tags rows; the card pill already resolves against
            // the live tags list, so this just keeps tag_ids honest in memory.
            const strip = (m: Moment) => (m.tag_ids?.includes(tag.id) ? { ...m, tag_ids: m.tag_ids.filter((id) => id !== tag.id) } : m)
            setMoments((prev) => prev.map(strip))
            setPinnedMoments((prev) => prev.map(strip))
            refetchTags()
            ui.toast('Tag deleted.', 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Failed to delete tag', 'error')
        }
    }

    // Filter moments by selected tags (client-side, since server doesn't
    // support tag filtering yet). Pinned moments render in their own section,
    // so exclude them from the main list to avoid showing them twice.
    const filteredMoments = () => {
        const pinnedIds = new Set(pinnedMoments().map((m) => m.id))
        const selected = selectedTagIds()
        return moments().filter((m) => {
            if (pinnedIds.has(m.id) && !searchQuery()) return false
            if (selected.length === 0) return true
            const tagIds = m.tag_ids || []
            return selected.every((id) => tagIds.includes(id))
        })
    }

    // Per-archive theme: when the selected archive has an assigned user
    // theme, expose its colours as inline CSS variables scoped to the feed
    // column. No mapping -> empty style -> inherits the global theme.
    const archiveScopedStyle = () => {
        const id = selectedArchive()
        if (!id) return {}
        const themeId = getArchiveTheme(id)
        if (!themeId) return {}
        const colors = resolveUserThemeColors(themeId)
        return colors ? themeColorVars(colors) : {}
    }

    // Apply the same tag filter to pinned moments so filtering is consistent.
    const filteredPinned = () => {
        const selected = selectedTagIds()
        if (selected.length === 0) return pinnedMoments()
        return pinnedMoments().filter((m) => {
            const tagIds = m.tag_ids || []
            return selected.every((id) => tagIds.includes(id))
        })
    }

    // Reusable panel/feed fragments, shared by the Standard and Focus layouts.
    const archivesInner = () => (
        <ArchivesBar
            archives={archives() || []}
            selectedArchive={selectedArchive()}
            onSelect={(id) => {
                handleArchiveSelect(id)
                setShowArchivesDrawer(false)
            }}
            onCreate={async (name) => {
                await api.createArchive(name)
                refetchArchives()
            }}
            onRename={handleRenameArchive}
            onDelete={handleDeleteArchive}
            canManage={canManageArchives()}
        />
    )

    // Shared props for both menu layouts (minimal FilterBar / rich MenuPanel).
    const menuActionProps = () => ({
        onOpenChat: () => setShowChat(true),
        onOpenSettings: () => setShowSettings(true),
        onOpenAdmin: () => setShowAdmin(true),
        onOpenTodos: () => setShowTodos(true),
        onOpenCanvas: () => setShowCanvas(true),
        username: auth.user()?.username || '',
        isOwner: auth.user()?.is_owner || false,
        canManageUsers: (auth.user()?.permissions || 0) & (1 << 15) ? true : (auth.user()?.permissions || 0) & (1 << 19) ? true : false,
        canManageRoles: (auth.user()?.permissions || 0) & (1 << 16) ? true : (auth.user()?.permissions || 0) & (1 << 19) ? true : false,
        canViewAuditLog: (auth.user()?.permissions || 0) & (1 << 18) ? true : (auth.user()?.permissions || 0) & (1 << 19) ? true : false,
    })

    const menuInner = () =>
        prefs().menuLayout === 'rich' ? (
            <MenuPanel
                {...menuActionProps()}
                pinnedMoments={filteredPinned()}
                tags={tags() || []}
                selectedTagIds={selectedTagIds()}
                onToggleTag={(id) =>
                    setSelectedTagIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]))
                }
                onOpenMoment={(id) => setFocusMomentId(id)}
                onOpenTodoEmbed={() => setShowTodos(true)}
                onOpenCanvasEmbed={() => setShowCanvas(true)}
            />
        ) : (
            <FilterBar {...menuActionProps()} />
        )

    // `mobile` drops the inline composer (create moves to the bottom-nav "New")
    // and Feed hides its own filter trigger (filtering moves to the nav sheet).
    const feedInner = (mobile = false) => (
        <Feed
            moments={filteredMoments()}
            pinnedMoments={filteredPinned()}
            tags={tags() || []}
            archives={archives() || []}
            selectedTagIds={selectedTagIds()}
            loading={loadingMoments()}
            loadingMore={loadingMore()}
            hasMore={hasMore()}
            searchQuery={searchQuery()}
            filters={feedFilters()}
            onChangeFilters={handleChangeFilters}
            canPin={canPin()}
            canEditMoment={canEditMoment}
            canDeleteMoment={canDeleteMoment}
            onSearch={handleSearch}
            onCreateMoment={handleCreateMoment}
            onEditMoment={handleEditMoment}
            onDeleteMoment={handleDeleteMoment}
            onTogglePin={handleTogglePin}
            onLoadMore={() => loadMoments(false)}
            onOpenMoment={(id) => setFocusMomentId(id)}
            onOpenTodo={() => setShowTodos(true)}
            onOpenCanvas={() => setShowCanvas(true)}
            canCreate={canCreateMoment()}
            showComposer={!mobile && canCreateMoment()}
            inlineCreator={
                mobile || !canCreateMoment() ? undefined : (
                    <Editor
                        chrome="inline"
                        draftKey="inline-moment"
                        archives={archives() || []}
                        tags={tags() || []}
                        defaultArchive={selectedArchive()}
                        onSubmit={handleInlineCreate}
                        onCreateTag={handleInlineCreateTag}
                        momentIndex={momentIndex()}
                    />
                )
            }
        />
    )

    // Not-logged-in welcome, shared by the desktop Switch and the mobile shell.
    const welcome = () => (
        <div class="flex h-full w-full items-center justify-center p-4">
            <div class="bg-element-matte border-element-accent flex max-w-xl flex-col items-center gap-8 rounded-lg border p-8 shadow-2xl sm:p-12">
                <div class="flex flex-col items-center gap-4 text-center">
                    <img src="/logo.png" alt="Athena" class="h-14 w-14" />
                    <h1 class="text-main font-serif text-3xl tracking-tight">Welcome to Athena</h1>
                    <p class="text-sub text-md max-w-md leading-relaxed">
                        You need an account to continue. Log in or register to get started.
                    </p>
                </div>
                <div class="flex gap-4">
                    <button
                        onClick={() => navigate('/login')}
                        class="bg-highlight-strongest rounded-md px-8 py-3 text-lg font-bold text-white shadow-lg transition-[filter] hover:cursor-pointer hover:brightness-110"
                    >
                        Log In
                    </button>
                    <button
                        onClick={() => navigate('/register')}
                        class="bg-element-accent text-main hover:bg-element-accent-highlight rounded-md px-8 py-3 text-lg font-bold shadow-lg transition-colors hover:cursor-pointer"
                    >
                        Register
                    </button>
                </div>
            </div>
        </div>
    )

    // The mobile bottom sheets (Archives / Filter / More) + bottom nav.
    const mobileShell = () => (
        <>
            <div class="flex min-h-0 flex-1 flex-col overflow-hidden" style={archiveScopedStyle()}>
                {feedInner(true)}
            </div>

            <BottomNav
                active={showChat() ? 'chat' : mobileSheet()}
                filterCount={activeFilterCount(feedFilters()) + selectedTagIds().length}
                onArchives={() => toggleSheet('archives')}
                onFilter={() => toggleSheet('filter')}
                canCreate={canCreateMoment()}
                onNew={handleCreateMoment}
                onChat={() => setShowChat(true)}
                onMore={() => toggleSheet('more')}
            />

            <Sheet open={mobileSheet() === 'archives'} title="Archives" onClose={() => setMobileSheet(null)}>
                <MobileArchivesSheet
                    archives={archives() || []}
                    selectedArchive={selectedArchive()}
                    onSelect={(id) => {
                        handleArchiveSelect(id)
                        setMobileSheet(null)
                    }}
                    onCreate={async (name) => {
                        await api.createArchive(name)
                        refetchArchives()
                    }}
                    onRename={handleRenameArchive}
                    onDelete={handleDeleteArchive}
                    canManage={canManageArchives()}
                />
            </Sheet>

            <Sheet open={mobileSheet() === 'filter'} title="Filter" onClose={() => setMobileSheet(null)}>
                <MobileFilterSheet
                    tags={tags() || []}
                    selectedTagIds={selectedTagIds()}
                    onToggleTag={(id) =>
                        setSelectedTagIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]))
                    }
                    onClearTags={() => setSelectedTagIds([])}
                    onCreateTag={async (name, color) => {
                        await api.createTag(name, color)
                        refetchTags()
                    }}
                    onDeleteTag={handleDeleteTag}
                    canManageTags={canManageTags()}
                    filters={feedFilters()}
                    onChangeFilters={handleChangeFilters}
                />
            </Sheet>

            <Sheet open={mobileSheet() === 'more'} title="Menu" onClose={() => setMobileSheet(null)}>
                <MobileMoreSheet
                    username={auth.user()?.username || ''}
                    isOwner={auth.user()?.is_owner || false}
                    canAdmin={canAdmin()}
                    onTodos={() => {
                        setMobileSheet(null)
                        setShowTodos(true)
                    }}
                    onCanvas={() => {
                        setMobileSheet(null)
                        setShowCanvas(true)
                    }}
                    onSettings={() => {
                        setMobileSheet(null)
                        setShowSettings(true)
                    }}
                    onAdmin={() => {
                        setMobileSheet(null)
                        setShowAdmin(true)
                    }}
                    onLogout={async () => {
                        const ok = await ui.confirm({
                            title: 'Log out?',
                            message: 'You will need to sign in again to access your moments.',
                            confirmLabel: 'Log out',
                            danger: true,
                        })
                        if (!ok) return
                        setMobileSheet(null)
                        auth.logout()
                    }}
                />
            </Sheet>
        </>
    )

    return (
        <div class="bg-background text-sub flex h-[100dvh] flex-col overflow-hidden">
            {/* 3-cell grid keeps the brand truly centred regardless of any
                side content (e.g. the Electron window-control gutter, which
                simply overlays the empty right cell). */}
            <header class="app-drag-region bg-element m-0 grid shrink-0 grid-cols-[1fr_auto_1fr] items-center py-2">
                <div aria-hidden="true" />
                <div class="flex items-center justify-center gap-2">
                    <Show when={prefs().showTopbarLogo}>
                        <img src="/logo.png" alt="Athena" class="h-7 w-7" />
                    </Show>
                    <h1 class="font-serif text-2xl font-black tracking-tight">
                        Athena v{__APP_VERSION__}
                        {import.meta.env.DEV ? ' [DEV BUILD]' : ''}
                    </h1>
                </div>
                <div aria-hidden="true" />
            </header>
            <Line class="bg-element-accent h-0.5 w-full" />

            {/* Tag bar is desktop-only; on mobile tags live in the Filter sheet. */}
            <Show when={auth.user() && isDesktop()}>
                <TagBar
                    tags={tags() || []}
                    selectedTagIds={selectedTagIds()}
                    onToggleTag={(id) => {
                        setSelectedTagIds((prev) =>
                            prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
                        )
                    }}
                    onClear={() => setSelectedTagIds([])}
                    onCreateTag={async (name, color) => {
                        await api.createTag(name, color)
                        refetchTags()
                    }}
                    onDeleteTag={handleDeleteTag}
                    canManage={canManageTags()}
                />
            </Show>

            {/* Mobile app-shell (below lg): feed swiper + bottom nav + sheets. */}
            <Show when={!isDesktop()}>
                <Show when={auth.user()} fallback={<Show when={!auth.loading()}>{welcome()}</Show>}>
                    {mobileShell()}
                </Show>
            </Show>

            {/* Desktop: the classic 3-column / focus layouts. */}
            <Show when={isDesktop()}>
            <div class="flex flex-1 justify-center lg:overflow-hidden pt-6">
                <div class="h-full w-[95%]">
                    <Switch>
                        <Match when={auth.user()}>
                            {/* Standard: 3-column layout. */}
                            <Show when={prefs().layout !== 'focus'}>
                                <div class="relative flex h-[95%] w-full flex-col items-center gap-2 transition-all duration-100 lg:flex-row lg:items-stretch lg:overflow-hidden">
                                    {/* Far-left: narrow libraries rail ('left-rail' placement).
                                        Renders nothing outside the desktop shell (no bridge), so
                                        it's inert in a browser. The column itself is gated too,
                                        not just its contents, so that standing down for the
                                        native rail doesn't leave an empty gutter where this one
                                        was. */}
                                    <Show when={prefs().librariesPlacement === 'left-rail' && librariesSwitcherVisible()}>
                                        {/* 15rem matches the native shell sidebar this is a
                                            port of, and the rail scrolls internally rather
                                            than the column scrolling around it. */}
                                        <div class="order-0 w-full lg:h-full lg:w-60 lg:shrink-0">
                                            <LibrariesPanel variant="rail" />
                                        </div>
                                    </Show>

                                    {/* Left: Archives (per-panel scoped theme vars, 4.6) */}
                                    <div
                                        class="z-10 order-1 w-full min-w-0 gap-2 rounded-xl md:flex md:flex-col lg:h-full lg:max-w-xs"
                                        style={{
                                            'background-color': 'var(--theme-archive-panel-bg, transparent)',
                                            'border-color': 'var(--theme-archive-panel-accent, transparent)',
                                        }}
                                    >
                                        <div class="flex flex-col gap-2 lg:overflow-y-auto">
                                            {/* Libraries inline, above or below Archives */}
                                            <Show when={prefs().librariesPlacement === 'inline-above'}>
                                                <LibrariesPanel />
                                            </Show>
                                            {archivesInner()}
                                            <Show when={prefs().librariesPlacement === 'inline-below'}>
                                                <LibrariesPanel />
                                            </Show>
                                        </div>
                                    </div>

                                    {/* Center: Feed + resize divider. The middle region takes the
                                        remaining width (lg:flex-1) and centres the feed within it,
                                        so the moments column stays centred between the side columns
                                        at any width. */}
                                    <div class="order-3 flex w-full min-w-0 justify-center lg:order-2 lg:h-full lg:flex-1">
                                        {/* Mirrors the resize divider on the feed's other side, so
                                            what gets centred here is the feed itself rather than
                                            feed+divider (which sits it ~10px left of centre). */}
                                        <div aria-hidden="true" class="mr-1 hidden shrink-0 self-stretch lg:block lg:w-1.5" />
                                        <div
                                            data-testid="feed-column"
                                            class="max-h-screen w-full max-w-full lg:h-full lg:max-w-(--feed-width) lg:overflow-y-auto"
                                            style={{ ...archiveScopedStyle(), '--feed-width': `${feedWidth()}px` }}
                                        >
                                            {feedInner()}
                                        </div>

                                        {/* Drag-to-resize divider (lg only), on the feed's right edge */}
                                        <div
                                            onPointerDown={startFeedResize}
                                            onDblClick={() => setPref('feedWidth', DEFAULT_PREFS.feedWidth)}
                                            title="Drag to resize the moments column (double-click to reset)"
                                            class="bg-element-accent/40 hover:bg-highlight-strongest/60 z-10 ml-1 hidden shrink-0 cursor-col-resize self-stretch rounded-full transition-colors lg:block lg:w-1.5"
                                            classList={{ 'bg-highlight-strongest/60': resizeWidth() != null }}
                                        />
                                    </div>

                                    {/* Right: Filters + Chat + Settings (per-panel scoped theme, 4.6) */}
                                    <div
                                        class="z-10 order-2 w-full min-w-0 rounded-xl text-center md:block lg:order-3 lg:h-full lg:max-w-xs lg:text-left"
                                        style={{
                                            'background-color': 'var(--theme-menu-panel-bg, transparent)',
                                            'border-color': 'var(--theme-menu-panel-accent, transparent)',
                                        }}
                                    >
                                        <div class="z-10 order-1 w-full min-w-0 justify-between gap-2 md:flex md:flex-col lg:h-full lg:max-w-xs">
                                            <div data-testid="menu-column" class="min-h-0 lg:h-full lg:overflow-y-auto">{menuInner()}</div>
                                        </div>
                                    </div>

                                    <Show when={prefs().librariesPlacement === 'left-rail' && librariesSwitcherVisible()}>
                                        <div aria-hidden="true" class="order-4 hidden lg:block lg:h-full lg:w-60 lg:shrink-0" />
                                    </Show>
                                </div>
                            </Show>

                            {/* Focus: single centred writing column; the side panels
                                live in floating drawers toggled by edge buttons. */}
                            <Show when={prefs().layout === 'focus'}>
                                <div class="relative h-[95%] w-full overflow-hidden">
                                    <div class="mx-auto h-full max-w-3xl overflow-y-auto" style={archiveScopedStyle()}>
                                        {feedInner()}
                                    </div>

                                    {/* Edge toggles */}
                                    <button
                                        onClick={() => setShowArchivesDrawer(true)}
                                        title="Archives"
                                        class="bg-element-matte border-element-accent text-sub hover:text-main fixed left-3 top-1/2 z-20 flex -translate-y-1/2 items-center gap-1 rounded-full border p-3 shadow-xl transition-all hover:scale-105"
                                    >
                                        <span class="material-symbols-outlined">folder</span>
                                    </button>
                                    <button
                                        onClick={() => setShowMenuDrawer(true)}
                                        title="Menu"
                                        class="bg-element-matte border-element-accent text-sub hover:text-main fixed right-3 top-1/2 z-20 flex -translate-y-1/2 items-center gap-1 rounded-full border p-3 shadow-xl transition-all hover:scale-105"
                                    >
                                        <span class="material-symbols-outlined">menu</span>
                                    </button>

                                    {/* Archives drawer */}
                                    <Show when={showArchivesDrawer()}>
                                        <div class="fixed inset-0 z-30 animate-fade-in" onClick={() => setShowArchivesDrawer(false)}>
                                            <div class="bg-element-matte border-element-accent absolute left-0 top-0 h-full w-72 overflow-y-auto border-r p-3 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                                                {archivesInner()}
                                            </div>
                                        </div>
                                    </Show>
                                    {/* Menu drawer */}
                                    <Show when={showMenuDrawer()}>
                                        <div class="fixed inset-0 z-30 animate-fade-in" onClick={() => setShowMenuDrawer(false)}>
                                            <div class="bg-element-matte border-element-accent absolute right-0 top-0 h-full w-72 overflow-y-auto border-l p-3 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                                                {menuInner()}
                                            </div>
                                        </div>
                                    </Show>
                                </div>
                            </Show>
                        </Match>
                        <Match when={!auth.loading() && !auth.user()}>{welcome()}</Match>
                    </Switch>
                </div>
            </div>
            </Show>

            {/* Logout: fixed bottom-right on desktop. On mobile it lives in the
                More sheet, so it's hidden here to clear the bottom nav. */}
            <Show when={auth.user() && isDesktop()}>
                <button
                    onClick={() => auth.logout()}
                    title="Logout"
                    class="bg-element-matte border-element-accent hover:border-danger hover:text-danger text-sub fixed right-4 bottom-4 z-40 flex items-center gap-2 rounded-full border p-3 font-bold shadow-2xl transition-all hover:scale-105 hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-xl">logout</span>
                    <span class="hidden text-sm sm:inline">Logout</span>
                </button>
            </Show>

            <Show when={showChat()}>
                <ChatModal
                    onClose={() => setShowChat(false)}
                    onOpenMoment={(id) => setFocusMomentId(id)}
                    onOpenTodo={() => setShowTodos(true)}
                    onOpenCanvas={() => setShowCanvas(true)}
                />
            </Show>

            <Show when={showSettings()}>
                <SettingsModal
                    onClose={() => setShowSettings(false)}
                    myPermissions={perms()}
                    archives={archives() || []}
                />
            </Show>

            <Show when={showAdmin()}>
                <AdminModal
                    onClose={() => setShowAdmin(false)}
                    myPermissions={auth.user()?.permissions || 0}
                />
            </Show>

            <Show when={showEditor()}>
                <Editor
                    chrome="modal"
                    moment={editingMoment()}
                    // Shares the inline composer's draft: they are two windows
                    // onto the same "moment I am writing", and starting one
                    // after abandoning the other should not lose the text. The
                    // Editor ignores this while editing an existing moment.
                    draftKey="inline-moment"
                    archives={archives() || []}
                    tags={tags() || []}
                    defaultArchive={selectedArchive()}
                    momentIndex={momentIndex()}
                    onSubmit={handleSaveMoment}
                    onCreateTag={handleInlineCreateTag}
                    onCancel={() => {
                        setShowEditor(false)
                        setPendingLink(null)
                    }}
                />
            </Show>

            <Show when={showTodos()}>
                <TodoModule
                    onClose={() => setShowTodos(false)}
                    canManage={canManageTodos()}
                    onOpenMoment={(id) => setFocusMomentId(id)}
                    onRequestNewMoment={handleCreateMomentToLink}
                />
            </Show>

            <Show when={showCanvas()}>
                <CanvasModule
                    onClose={() => setShowCanvas(false)}
                    canManage={canManageCanvas()}
                    onOpenMoment={(id) => setFocusMomentId(id)}
                />
            </Show>

            {/* Read-only focused reader for a referenced moment (sits above any
                open module; Edit closes everything and opens the full editor). */}
            <Show when={focusMomentId()}>
                <FocusedMomentModal
                    momentId={focusMomentId()!}
                    archives={archives() || []}
                    tags={tags() || []}
                    canEditMoment={canEditMoment}
                    canDeleteMoment={canDeleteMoment}
                    canPin={canPin()}
                    resolveRef={(id) => [...pinnedMoments(), ...moments()].find((m) => m.id === id)?.title || undefined}
                    onEdit={(m) => {
                        setFocusMomentId(null)
                        setShowTodos(false)
                        setShowCanvas(false)
                        handleEditMoment(m)
                    }}
                    onTogglePin={handleTogglePin}
                    onDelete={async (id) => {
                        await handleDeleteMoment(id)
                        setFocusMomentId(null)
                    }}
                    onClose={() => setFocusMomentId(null)}
                    onOpenMoment={(id) => setFocusMomentId(id)}
                    onOpenTodo={() => setShowTodos(true)}
                    onOpenCanvas={() => setShowCanvas(true)}
                />
            </Show>

            {/* Global image viewer: any content image opens it (ADR image work). */}
            <Lightbox />
        </div>
    )
}

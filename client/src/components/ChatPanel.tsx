import { createSignal, createMemo, createEffect, on, For, onMount, onCleanup, Show, type Component } from 'solid-js'
import { api, type ChatMessage } from '../api'
import { loadUsers, userName } from '../users'
import { recentChat, watchChatFeed, refreshChatFeed, mutateChatFeed, CHAT_PAGE_SIZE } from '../chatFeed'
import { keybinds, matchEvent } from '../keybinds'
import { formatTime } from '../format'
import { useAuth } from '../auth'
import { hasPermission } from '../permissions'
import { useUI } from '../ui'
import { MomentBody, stripEmbedTokens } from './MomentBody'
import { LinkPreviewList } from './LinkPreview'
import { AttachmentList } from './AttachmentList'
import { Editor, type EditorHandle } from './Editor'
import { createLongPress } from '../longPress'

// The chat surface (header, scrollback and composer) factored out of
// ChatModal so it can be reused two ways:
//  - inside ChatModal (mobile / on-demand), wrapped in a modal frame;
//  - docked in the desktop Menu column as a rich-menu widget.
// All chat state/behaviour (paging, polling, edit/delete) lives here; the
// callers only supply embed click-through handlers and an optional close.

interface ChatPanelProps {
    // Embed click-through (ADR-0015).
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
    onOpenDoc?: (id: string, projectId: string) => void
    // When provided, a close button appears in the header (modal use).
    onClose?: () => void
    // Whether this panel claims the global Focus search shortcut for its own
    // search box. On for the modal, which is the surface you are looking at
    // when you press it; off for the docked widget, where the shortcut still
    // belongs to the feed behind it.
    hotkeys?: boolean
    // Extra classes for the root (frame/rounding differs per host).
    class?: string
}

// Messages within this window from the same author are grouped under a single
// header, so a burst of same-minute messages no longer repeats the name/time.
const GROUP_WINDOW_MS = 5 * 60 * 1000

interface GroupedMessage {
    msg: ChatMessage
    showHeader: boolean
}

// The message as a markdown blockquote, ready to type a reply under. Every line
// is prefixed, so a multi-line message stays one quote instead of a quote
// followed by loose prose that reads as part of the reply.
//
// Embed tokens are dropped: MomentBody splits `::todo:<id>::` and `[[<id>]]`
// out of the text wherever they sit, so carrying one into a quote would leave
// an empty `>` behind and render its card full size outside the quote.
export function quoteFor(content: string): string {
    const text = stripEmbedTokens(content).trim()
    if (!text) return ''
    return text.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n') + '\n\n'
}

// A message counts as edited when its updated_at moved meaningfully past its
// created_at (both are equal on insert).
const wasEdited = (msg: ChatMessage) =>
    !msg.is_legacy && new Date(msg.updated_at).getTime() - new Date(msg.created_at).getTime() > 1000

// The inline edit box was a fixed two rows, which is cramped on a desktop
// window for anything longer than a sentence: you edit a paragraph through a
// slot barely taller than the message you are replacing. Size it to the draft
// instead, from a comfortable floor up to a cap so editing a very long message
// cannot swallow the whole scrollback.
const EDIT_MIN_HEIGHT = 112
const EDIT_MAX_HEIGHT = 420

const fitEditBox = (el: HTMLTextAreaElement) => {
    // Collapse first, or scrollHeight only ever reports the current height and
    // the box can grow but never shrink back.
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, EDIT_MIN_HEIGHT), EDIT_MAX_HEIGHT)}px`
}

export const ChatPanel: Component<ChatPanelProps> = (props) => {
    const auth = useAuth()
    const ui = useUI()
    const [messages, setMessages] = createSignal<ChatMessage[]>([])
    const [loading, setLoading] = createSignal(false)
    // Infinite scroll upward: whether older history remains, and whether a
    // page of it is currently loading.
    const [loadingOlder, setLoadingOlder] = createSignal(false)
    const [hasMoreOlder, setHasMoreOlder] = createSignal(false)
    const [editingId, setEditingId] = createSignal<string | null>(null)
    const [editDraft, setEditDraft] = createSignal('')
    // Search over the whole history, server-side (see api.listChat's `q`).
    // Open is separate from the query so the box can be focused and empty:
    // that is the state the shortcut puts you in.
    const [searchOpen, setSearchOpen] = createSignal(false)
    const [query, setQuery] = createSignal('')
    const [results, setResults] = createSignal<ChatMessage[]>([])
    const [searching, setSearching] = createSignal(false)
    // The message a result jumped to, briefly highlighted so the eye can find
    // it in the scrollback it landed in.
    const [flashId, setFlashId] = createSignal<string | null>(null)
    let searchInput: HTMLInputElement | undefined

    let scrollRef: HTMLDivElement | undefined
    let listRef: HTMLDivElement | undefined
    // Set right before we move the scrollbar ourselves, so the native 'scroll'
    // event that assignment triggers doesn't reach onScroll's isAtBottom()
    // check. That event fires asynchronously, not in the same tick, so
    // without this, content that grows the list in the gap (an image, an
    // embed, a link preview finishing after we scrolled) makes isAtBottom()
    // measure against a taller scrollHeight than the one we scrolled to. It
    // reads as "not at the bottom" and permanently turns stickToBottom off,
    // even though the user never touched the scrollbar.
    let ownScroll = false
    const scrollToBottom = () => {
        if (!scrollRef) return
        ownScroll = true
        scrollRef.scrollTop = scrollRef.scrollHeight
        requestAnimationFrame(() => {
            ownScroll = false
        })
    }
    // Treat "within 60px of the bottom" as pinned, so polls only auto-scroll
    // when the user is already reading the latest messages.
    const isAtBottom = () => {
        const el = scrollRef
        if (!el) return true
        return el.scrollHeight - el.scrollTop - el.clientHeight < 60
    }

    // Whether to keep the view glued to the newest message. Starts true so a
    // freshly opened chat opens at the bottom, and follows the user after that.
    //
    // A single scroll after loading is not enough: message bodies grow *after*
    // they are inserted (images decode, embeds resolve, link previews arrive),
    // so the one scroll landed at what was then the bottom and the content
    // pushed past it, which is why opening chat left you partway up the
    // scrollback. Re-pin whenever the content resizes instead.
    let stickToBottom = true

    const myId = () => auth.user()?.id
    // Bits mirror server/internal/permissions. Authorship alone used to decide
    // this, so a member without the chat edit/delete flags was still offered
    // both on their own messages and only found out when the server refused.
    const perms = () => auth.user()?.permissions || 0
    const ownsMessage = (msg: ChatMessage) => !!msg.author_id && msg.author_id === myId()
    const canEdit = (msg: ChatMessage) => hasPermission(perms(), 10) && ownsMessage(msg) // EDIT_OWN_CHAT_MESSAGE
    // DELETE_ANY_CHAT_MESSAGE covers other people's messages too, which the
    // old authorship-only test could never express.
    const canDelete = (msg: ChatMessage) => hasPermission(perms(), 12) || (hasPermission(perms(), 11) && ownsMessage(msg))
    // SEND_CHAT_MESSAGE, bit 9.
    const canSend = () => hasPermission(perms(), 9)

    const loadMessages = async () => {
        setLoading(true)
        try {
            // The shared feed is what everyone else is already reading, so the
            // panel opens on the same window rather than fetching a second copy
            // of it.
            await refreshChatFeed()
            const msgs = recentChat()
            setHasMoreOlder(msgs.length === CHAT_PAGE_SIZE)
            setMessages(msgs)
            stickToBottom = true
            requestAnimationFrame(scrollToBottom)
        } finally {
            setLoading(false)
        }
    }

    // Pull the next older page when the user scrolls near the top, prepending
    // it while preserving the visual scroll position so the viewport doesn't
    // jump. Keyset cursor = the oldest message currently loaded.
    const loadOlder = async () => {
        if (loadingOlder() || !hasMoreOlder()) return
        const oldest = messages()[0]
        if (!oldest) return
        // Prepending grows the content, which is exactly what the re-pin
        // observer reacts to, and re-pinning here would yank the reader from
        // the history they scrolled up to read.
        stickToBottom = false
        setLoadingOlder(true)
        const el = scrollRef
        const prevHeight = el?.scrollHeight ?? 0
        const prevTop = el?.scrollTop ?? 0
        try {
            const batch = await api.listChat({
                limit: CHAT_PAGE_SIZE,
                cursor_ts: oldest.created_at,
                cursor_id: oldest.id,
            })
            setHasMoreOlder(batch.length === CHAT_PAGE_SIZE)
            if (batch.length > 0) {
                const asc = batch.reverse()
                setMessages((prev) => [...asc, ...prev])
                // Keep the message that was at the top anchored under the cursor.
                requestAnimationFrame(() => {
                    if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop
                })
            }
        } catch (err) {
            console.error('Failed to load older chat:', err)
        } finally {
            setLoadingOlder(false)
        }
    }

    const onScroll = () => {
        if (ownScroll) return
        // Scrolling up is how you say "stop following the bottom", and coming
        // back down is how you say "resume".
        stickToBottom = isAtBottom()
        if (scrollRef && scrollRef.scrollTop < 120) void loadOlder()
    }

    // Reconcile the most-recent window from a poll (new / edited / deleted
    // messages) without discarding older history loaded via infinite scroll,
    // and only stick to the bottom if the user is already reading the latest.
    //
    // Every poll fetches brand-new message objects, even for rows that didn't
    // change. Naively replacing the tail with them would give <For> a new
    // reference for every message each cycle, so it tears down and rebuilds
    // the whole visible list every 5s (flicker, lost hover state, replayed
    // animations). Preserve the existing object identity for anything whose
    // content is actually unchanged so <For> only touches real diffs.
    const mergeRecent = (fetchedAsc: ChatMessage[]) => {
        if (fetchedAsc.length === 0) return
        const stick = isAtBottom()
        const cutoff = new Date(fetchedAsc[0].created_at).getTime()
        setMessages((prev) => {
            const older = prev.filter((m) => new Date(m.created_at).getTime() < cutoff)
            const merged = fetchedAsc.map((fresh) => {
                const existing = prev.find((m) => m.id === fresh.id)
                return existing && existing.content === fresh.content && existing.updated_at === fresh.updated_at
                    ? existing
                    : fresh
            })
            return [...older, ...merged]
        })
        if (stick) requestAnimationFrame(scrollToBottom)
    }

    // An optimistic change belongs to the scrollback and to the shared newest
    // window alike, so the docked preview shows a send, an edit or a delete on
    // the same frame this panel does rather than on its next poll.
    const applyLocal = (fn: (msgs: ChatMessage[]) => ChatMessage[]) => {
        setMessages(fn)
        mutateChatFeed(fn)
    }

    // Full render pipeline + unified editor: send through the shared chat
    // editor, append optimistically, reconcile on reply.
    const sendMessage = async (content: string) => {
        const text = content.trim()
        if (!text) return
        try {
            const msg = await api.sendChat(text)
            applyLocal((prev) => [...prev, msg])
            // Sending is an unambiguous "I want to be at the latest".
            stickToBottom = true
            scrollToBottom()
        } catch (err) {
            console.error('Failed to send message:', err)
            ui.toast('Could not send message.', 'error')
        }
    }

    const startEdit = (msg: ChatMessage) => {
        setEditingId(msg.id)
        setEditDraft(msg.content)
    }
    const cancelEdit = () => setEditingId(null)

    const saveEdit = async (msg: ChatMessage) => {
        const text = editDraft().trim()
        setEditingId(null)
        if (!text || text === msg.content) return
        const prev = messages()
        applyLocal((ms) => ms.map((m) => (m.id === msg.id ? { ...m, content: text, updated_at: new Date().toISOString() } : m)))
        try {
            const updated = await api.updateChat(msg.id, text)
            applyLocal((ms) => ms.map((m) => (m.id === updated.id ? updated : m)))
        } catch (err) {
            console.error('Failed to edit message:', err)
            setMessages(prev)
            void refreshChatFeed()
            ui.toast('Could not edit message.', 'error')
        }
    }

    const deleteMessage = async (msg: ChatMessage) => {
        const ok = await ui.confirm({ title: 'Delete message?', message: 'This message will be removed for everyone.', confirmLabel: 'Delete', danger: true })
        if (!ok) return
        const prev = messages()
        applyLocal((ms) => ms.filter((m) => m.id !== msg.id))
        try {
            await api.deleteChat(msg.id)
        } catch (err) {
            console.error('Failed to delete message:', err)
            setMessages(prev)
            void refreshChatFeed()
            ui.toast('Could not delete message.', 'error')
        }
    }

    onMount(() => {
        loadUsers()
        loadMessages()

        // Keeps the newest message in view as the rendered content settles.
        if (listRef && typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(() => {
                if (stickToBottom) scrollToBottom()
            })
            observer.observe(listRef)
            onCleanup(() => observer.disconnect())
        }

        // The poll itself is the shared feed's; this panel only says it is
        // watching, and reconciles each window it publishes (below).
        onCleanup(watchChatFeed())
    })

    // deferred: the first window is the one loadMessages already put on
    // screen, and merging it again would fight that initial scroll.
    createEffect(on(recentChat, (msgs) => mergeRecent(msgs), { defer: true }))

    // --- search ---

    // One page of hits is as far as the panel goes: chat search is for finding
    // a message you remember, and a query that matches more than fifty is a
    // query to narrow rather than a list to page through.
    const SEARCH_LIMIT = 50
    // How many older pages a jump will pull in before giving up. A hit from
    // months back sits thousands of messages behind the newest window, and
    // paging all of it in costs more than the answer is worth.
    const JUMP_MAX_PAGES = 20

    let searchTimer: ReturnType<typeof setTimeout> | undefined
    const runSearch = (text: string) => {
        setQuery(text)
        if (searchTimer) clearTimeout(searchTimer)
        const wanted = text.trim()
        if (!wanted) {
            setResults([])
            setSearching(false)
            return
        }
        setSearching(true)
        // Typed one letter at a time, so wait for a pause rather than asking
        // the server about every prefix on the way to the word.
        searchTimer = setTimeout(async () => {
            try {
                const hits = await api.listChat({ q: wanted, limit: SEARCH_LIMIT })
                // A slower earlier request must not land on top of a later
                // one: only the answer to what is in the box now counts.
                if (wanted !== query().trim()) return
                setResults(hits)
            } catch (err) {
                console.error('Failed to search chat:', err)
                if (wanted === query().trim()) setResults([])
            } finally {
                if (wanted === query().trim()) setSearching(false)
            }
        }, 250)
    }

    const openSearch = () => {
        setSearchOpen(true)
        queueMicrotask(() => {
            searchInput?.focus()
            searchInput?.select()
        })
    }
    const closeSearch = () => {
        if (searchTimer) clearTimeout(searchTimer)
        setSearchOpen(false)
        setQuery('')
        setResults([])
        setSearching(false)
    }
    onCleanup(() => {
        if (searchTimer) clearTimeout(searchTimer)
    })

    // Walk older pages until the message is on the list, then put it under the
    // reader's eye. The scrollback is the whole point of the jump: a result on
    // its own says what was said, not what it was said about.
    const jumpTo = async (target: ChatMessage) => {
        closeSearch()
        let pages = 0
        while (!messages().some((m) => m.id === target.id) && hasMoreOlder() && pages++ < JUMP_MAX_PAGES) {
            await loadOlder()
        }
        if (!messages().some((m) => m.id === target.id)) {
            ui.toast('That message is too far back in the history to jump to.', 'error')
            return
        }
        stickToBottom = false
        setFlashId(target.id)
        requestAnimationFrame(() => {
            listRef?.querySelector(`[data-message-id="${target.id}"]`)?.scrollIntoView({ block: 'center' })
        })
        setTimeout(() => setFlashId((id) => (id === target.id ? null : id)), 2500)
    }

    // Focus search belongs to whichever surface is in front, which in the
    // modal is this panel rather than the feed behind it. Capture phase: the
    // global handler listens on window too, and the first one to see the key
    // wins it.
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!props.hotkeys || !matchEvent(e, keybinds().focusSearch)) return
            e.preventDefault()
            e.stopPropagation()
            openSearch()
        }
        window.addEventListener('keydown', onKey, true)
        onCleanup(() => window.removeEventListener('keydown', onKey, true))
    })

    const authorLabel = (msg: ChatMessage) => (msg.author_id ? userName(msg.author_id) : msg.display_name || 'Unknown')

    // Handed over by the composer on mount. Undefined without SEND_CHAT_MESSAGE,
    // where there is no composer to quote into and no Reply offered either.
    let composer: EditorHandle | undefined
    // A message with nothing but an embed in it quotes to nothing, and an
    // action that silently does nothing is worse than one that isn't offered.
    const canReply = (msg: ChatMessage) => canSend() && !!quoteFor(msg.content)
    const reply = (msg: ChatMessage) => {
        const quote = quoteFor(msg.content)
        if (!quote) return
        composer?.insertBlock(quote)
    }

    // Wrapper objects for <For>, which diffs by reference. messages() gets a
    // new array on every poll (see mergeRecent), so recomputing this naively
    // would wrap every message in a fresh {msg, showHeader} object each time,
    // even ones mergeRecent kept stable, and <For> would still rebuild their
    // DOM. Reuse the previous wrapper when both the message and its computed
    // showHeader are unchanged, so only genuine adds/edits/removes re-render.
    let groupedCache = new Map<string, GroupedMessage>()
    const grouped = createMemo<GroupedMessage[]>(() => {
        const out: GroupedMessage[] = []
        const nextCache = new Map<string, GroupedMessage>()
        let prev: ChatMessage | null = null
        for (const msg of messages()) {
            const sameAuthor = prev ? (prev.author_id ? prev.author_id === msg.author_id : prev.display_name === msg.display_name) : false
            const withinWindow = prev ? new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_WINDOW_MS : false
            const showHeader = !(sameAuthor && withinWindow)
            const cached = groupedCache.get(msg.id)
            const entry = cached && cached.msg === msg && cached.showHeader === showHeader ? cached : { msg, showHeader }
            nextCache.set(msg.id, entry)
            out.push(entry)
            prev = msg
        }
        groupedCache = nextCache
        return out
    })

    return (
        <div data-testid="chat-panel" class={`flex min-h-0 flex-col ${props.class ?? ''}`}>
            {/* Header. Search is an icon until it is wanted and an input once
                it is, so the header stays a header rather than a toolbar. */}
            <div class="bg-element border-element-accent flex items-center gap-2 border-b p-3">
                <span class="material-symbols-outlined text-highlight text-xl">message</span>
                <h2 class="text-main font-serif text-lg tracking-wide">Chat</h2>
                <Show
                    when={searchOpen()}
                    fallback={
                        <button
                            onClick={openSearch}
                            data-testid="chat-search-open"
                            class="text-sub hover:text-main ml-auto shrink-0 transition-colors hover:cursor-pointer"
                            title="Search chat"
                            aria-label="Search chat"
                        >
                            <span class="material-symbols-outlined text-xl">search</span>
                        </button>
                    }
                >
                    <div class="relative ml-auto min-w-0 flex-1 sm:max-w-64">
                        <span class="material-symbols-outlined text-sub pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-base">search</span>
                        <input
                            ref={searchInput}
                            type="text"
                            value={query()}
                            onInput={(e) => runSearch(e.currentTarget.value)}
                            onKeyDown={(e) => {
                                if (e.key !== 'Escape') return
                                // Closes the search, not the chat: the global
                                // handler skips a key a component has taken.
                                e.preventDefault()
                                e.stopPropagation()
                                closeSearch()
                            }}
                            placeholder="Search chat…"
                            data-testid="chat-search"
                            aria-label="Search chat"
                            class="bg-element-matte text-main border-element-accent focus:border-highlight w-full rounded-md border py-1 pl-8 pr-7 text-sm focus:outline-none"
                        />
                        <button
                            onClick={closeSearch}
                            class="text-sub hover:text-main absolute right-1.5 top-1/2 -translate-y-1/2 transition-colors hover:cursor-pointer"
                            title="Close search"
                            aria-label="Close search"
                        >
                            <span class="material-symbols-outlined text-base">close</span>
                        </button>
                    </div>
                </Show>
                <Show when={props.onClose}>
                    <button onClick={() => props.onClose?.()} class="text-sub hover:text-plain shrink-0 transition-colors" aria-label="Close chat">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </Show>
            </div>

            {/* Messages, with search results laid over them rather than in
                place of them: unmounting the scrollback would lose the scroll
                position, and with it the resize observer pinned to the list. */}
            <div class="relative min-h-0 flex-1">
            <div ref={scrollRef} onScroll={onScroll} data-testid="chat-scroll" class="h-full overflow-y-auto p-4">
              <div ref={listRef}>
                <Show when={loading()}>
                    <p class="text-sub text-center text-sm">Loading…</p>
                </Show>
                {/* Older-history loader, shown while scrolling up fetches a page. */}
                <Show when={loadingOlder()}>
                    <p class="text-sub/70 text-center text-xs py-2">Loading earlier messages…</p>
                </Show>
                <Show when={messages().length === 0 && !loading()}>
                    <p class="text-sub/60 text-center text-sm italic">No messages yet. Type a quick thought!</p>
                </Show>
                <For each={grouped()}>
                    {({ msg, showHeader }) => {
                        // Long-press own messages → edit/delete on touch (the
                        // hover buttons below are invisible without a pointer).
                        const lp = createLongPress(() => {
                            if (editingId() === msg.id) return
                            const actions = []
                            // First, and ungated: replying is the one action
                            // that applies to someone else's message too.
                            if (canReply(msg)) actions.push({ label: 'Reply', icon: 'reply', onSelect: () => reply(msg) })
                            if (canEdit(msg)) actions.push({ label: 'Edit', icon: 'edit', onSelect: () => startEdit(msg) })
                            if (canDelete(msg))
                                actions.push({ label: 'Delete', icon: 'delete', danger: true, onSelect: () => deleteMessage(msg) })
                            if (!actions.length) return
                            ui.actionSheet({ title: 'Message', actions })
                        })
                        return (
                            <div
                                {...lp.handlers}
                                data-message-id={msg.id}
                                classList={{
                                    'mt-4': showHeader,
                                    'mt-0.5': !showHeader,
                                    // Fades out on its own, so a jump lands on something the eye
                                    // can pick out without leaving the scrollback marked up.
                                    'bg-highlight/15 rounded-md': flashId() === msg.id,
                                }}
                                class="group relative transition-colors duration-700"
                            >
                                <Show when={showHeader}>
                                    <div class="flex items-baseline gap-2">
                                        <span class="text-highlight-strong text-xs font-bold">{authorLabel(msg)}</span>
                                        <Show when={msg.is_legacy}>
                                            <span class="rounded bg-yellow-900/40 px-1 text-[10px] text-yellow-400">Legacy</span>
                                        </Show>
                                        <span class="text-sub text-[11px]">{formatTime(msg.created_at)}</span>
                                    </div>
                                </Show>

                                <div class="flex items-start gap-2">
                                    <div class="min-w-0 flex-1">
                                        <Show
                                            when={editingId() === msg.id}
                                            fallback={
                                                <div class="text-sm leading-snug">
                                                    <MomentBody
                                                        content={msg.content}
                                                        class="text-main text-sm"
                                                        onOpenMoment={props.onOpenMoment}
                                                        onOpenTodo={props.onOpenTodo}
                                                        onOpenCanvas={props.onOpenCanvas}
                                                        onOpenProject={props.onOpenProject}
                                                        onOpenDoc={props.onOpenDoc}
                                                    />
                                                    <AttachmentList content={msg.content} />
                                                    <LinkPreviewList content={msg.content} />
                                                    <Show when={wasEdited(msg)}>
                                                        <span class="text-sub/60 ml-1 text-[10px]">(edited)</span>
                                                    </Show>
                                                </div>
                                            }
                                        >
                                            {/* Discord-style inline edit */}
                                            <textarea
                                                value={editDraft()}
                                                ref={(el) =>
                                                    queueMicrotask(() => {
                                                        el.focus()
                                                        // Caret at the end, so a long message does not
                                                        // start you typing in front of your own text.
                                                        el.setSelectionRange(el.value.length, el.value.length)
                                                        fitEditBox(el)
                                                    })
                                                }
                                                onInput={(e) => {
                                                    setEditDraft(e.currentTarget.value)
                                                    fitEditBox(e.currentTarget)
                                                }}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' && !e.shiftKey) {
                                                        e.preventDefault()
                                                        void saveEdit(msg)
                                                    } else if (e.key === 'Escape') {
                                                        cancelEdit()
                                                    }
                                                }}
                                                class="bg-element-matte text-main border-element-accent focus:border-highlight w-full resize-none overflow-y-auto rounded-md border px-2 py-1.5 text-sm focus:outline-none"
                                            />
                                            <div class="text-sub/70 mt-0.5 text-[10px]">
                                                Enter to save · Esc to{' '}
                                                <button onClick={cancelEdit} class="underline hover:cursor-pointer">
                                                    cancel
                                                </button>
                                            </div>
                                        </Show>
                                    </div>

                                    <Show when={showHeader && editingId() !== msg.id}>
                                        <span class="text-sub/70 mt-0.5 shrink-0 text-[10px] opacity-0 transition-opacity group-hover:opacity-100">
                                            {formatTime(msg.created_at)}
                                        </span>
                                    </Show>

                                    {/* Hover actions, each gated on its own permission */}
                                    <Show when={(canReply(msg) || canEdit(msg) || canDelete(msg)) && editingId() !== msg.id}>
                                        <div class="shrink-0 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                            {/* Ungated by author: quoting someone
                                                else is the whole point. */}
                                            <Show when={canReply(msg)}>
                                                <button
                                                    onClick={() => reply(msg)}
                                                    title="Reply"
                                                    aria-label={`Reply to ${authorLabel(msg)}`}
                                                    class="text-sub hover:text-main hover:cursor-pointer"
                                                >
                                                    <span class="material-symbols-outlined text-sm">reply</span>
                                                </button>
                                            </Show>
                                            <Show when={canEdit(msg)}>
                                                <button onClick={() => startEdit(msg)} title="Edit" class="text-sub hover:text-main hover:cursor-pointer">
                                                    <span class="material-symbols-outlined text-sm">edit</span>
                                                </button>
                                            </Show>
                                            <Show when={canDelete(msg)}>
                                                <button onClick={() => deleteMessage(msg)} title="Delete" class="text-sub hover:text-danger hover:cursor-pointer">
                                                    <span class="material-symbols-outlined text-sm">delete</span>
                                                </button>
                                            </Show>
                                        </div>
                                    </Show>
                                </div>
                            </div>
                        )
                    }}
                </For>
              </div>
            </div>

            <Show when={searchOpen() && query().trim()}>
                <div data-testid="chat-search-results" class="bg-element-matte absolute inset-0 overflow-y-auto p-3">
                    <Show when={!searching()} fallback={<p class="text-sub text-center text-sm">Searching…</p>}>
                        <Show when={results().length > 0} fallback={<p class="text-sub/60 text-center text-sm italic">No messages match that.</p>}>
                            <p class="text-sub/70 mb-2 text-[11px] font-bold uppercase tracking-widest">
                                {results().length}
                                {results().length === SEARCH_LIMIT ? '+' : ''} {results().length === 1 ? 'match' : 'matches'}
                            </p>
                            <div class="flex flex-col gap-1">
                                <For each={results()}>
                                    {(msg) => (
                                        <button
                                            onClick={() => void jumpTo(msg)}
                                            class="border-element-accent hover:border-highlight w-full rounded-md border p-2 text-left transition-colors hover:cursor-pointer"
                                        >
                                            <div class="flex items-baseline gap-2">
                                                <span class="text-highlight-strong text-xs font-bold">{authorLabel(msg)}</span>
                                                <span class="text-sub text-[11px]">{formatTime(msg.created_at)}</span>
                                            </div>
                                            {/* Plain text, not the render pipeline: a result is a
                                                line to recognise, and the message itself is one
                                                click away. */}
                                            <p class="text-main line-clamp-3 whitespace-pre-wrap text-sm">
                                                {stripEmbedTokens(msg.content).trim() || msg.content}
                                            </p>
                                        </button>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </Show>
                </div>
            </Show>
            </div>

            {/* Composer: unified editor, chat chrome. Absent without
                SEND_CHAT_MESSAGE. The default role has it, but a custom role
                need not, and offering a composer the server will refuse reads
                as a broken app rather than a permission you lack. */}
            <Show
                when={canSend()}
                fallback={
                    <div class="bg-element border-element-accent text-sub/70 border-t p-3 text-center text-xs italic">
                        You can read this conversation but not post to it.
                    </div>
                }
            >
                <div class="bg-element border-element-accent border-t p-3">
                    <Editor
                        chrome="chat"
                        onSubmit={(_t, content) => sendMessage(content)}
                        onReady={(handle) => (composer = handle)}
                    />
                </div>
            </Show>
        </div>
    )
}

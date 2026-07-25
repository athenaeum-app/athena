import { createSignal, createMemo, For, onMount, onCleanup, Show, type Component } from 'solid-js'
import { api, type ChatMessage } from '../api'
import { loadUsers, userName } from '../users'
import { formatTime } from '../format'
import { useAuth } from '../auth'
import { hasPermission } from '../permissions'
import { useUI } from '../ui'
import { MomentBody } from './MomentBody'
import { LinkPreviewList } from './LinkPreview'
import { AttachmentList } from './AttachmentList'
import { Editor } from './Editor'
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
    // When provided, a close button appears in the header (modal use).
    onClose?: () => void
    // Extra classes for the root (frame/rounding differs per host).
    class?: string
}

// Messages within this window from the same author are grouped under a single
// header, so a burst of same-minute messages no longer repeats the name/time.
const GROUP_WINDOW_MS = 5 * 60 * 1000

// How many messages we fetch per page: both the initial newest page and each
// older page pulled in as you scroll up. Server clamps `limit` to 500.
const CHAT_PAGE_SIZE = 50

interface GroupedMessage {
    msg: ChatMessage
    showHeader: boolean
}

// A message counts as edited when its updated_at moved meaningfully past its
// created_at (both are equal on insert).
const wasEdited = (msg: ChatMessage) =>
    !msg.is_legacy && new Date(msg.updated_at).getTime() - new Date(msg.created_at).getTime() > 1000

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

    let scrollRef: HTMLDivElement | undefined
    let listRef: HTMLDivElement | undefined
    const scrollToBottom = () => {
        if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight
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
    const canEdit = (msg: ChatMessage) => !!msg.author_id && msg.author_id === myId()
    // SEND_CHAT_MESSAGE, bit 9 (mirrors server/internal/permissions).
    const canSend = () => hasPermission(auth.user()?.permissions || 0, 9)

    const loadMessages = async () => {
        setLoading(true)
        try {
            const msgs = await api.listChat({ limit: CHAT_PAGE_SIZE })
            setHasMoreOlder(msgs.length === CHAT_PAGE_SIZE)
            // API returns newest-first; the UI shows oldest→newest.
            setMessages(msgs.reverse())
            stickToBottom = true
            requestAnimationFrame(scrollToBottom)
        } catch (err) {
            console.error('Failed to load chat:', err)
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

    // Full render pipeline + unified editor: send through the shared chat
    // editor, append optimistically, reconcile on reply.
    const sendMessage = async (content: string) => {
        const text = content.trim()
        if (!text) return
        try {
            const msg = await api.sendChat(text)
            setMessages((prev) => [...prev, msg])
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
        setMessages((ms) => ms.map((m) => (m.id === msg.id ? { ...m, content: text, updated_at: new Date().toISOString() } : m)))
        try {
            const updated = await api.updateChat(msg.id, text)
            setMessages((ms) => ms.map((m) => (m.id === updated.id ? updated : m)))
        } catch (err) {
            console.error('Failed to edit message:', err)
            setMessages(prev)
            ui.toast('Could not edit message.', 'error')
        }
    }

    const deleteMessage = async (msg: ChatMessage) => {
        const ok = await ui.confirm({ title: 'Delete message?', message: 'This message will be removed for everyone.', confirmLabel: 'Delete', danger: true })
        if (!ok) return
        const prev = messages()
        setMessages((ms) => ms.filter((m) => m.id !== msg.id))
        try {
            await api.deleteChat(msg.id)
        } catch (err) {
            console.error('Failed to delete message:', err)
            setMessages(prev)
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

        const interval = setInterval(async () => {
            try {
                const msgs = await api.listChat({ limit: CHAT_PAGE_SIZE })
                mergeRecent(msgs.reverse())
            } catch {}
        }, 5000)
        onCleanup(() => clearInterval(interval))
    })

    const authorLabel = (msg: ChatMessage) => (msg.author_id ? userName(msg.author_id) : msg.display_name || 'Unknown')

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
        <div class={`flex min-h-0 flex-col ${props.class ?? ''}`}>
            {/* Header */}
            <div class="bg-element border-element-accent flex items-center justify-between border-b p-3">
                <div class="flex items-center gap-2">
                    <span class="material-symbols-outlined text-highlight text-xl">message</span>
                    <h2 class="text-main font-serif text-lg tracking-wide">Chat</h2>
                </div>
                <Show when={props.onClose}>
                    <button onClick={() => props.onClose?.()} class="text-sub hover:text-plain transition-colors" aria-label="Close chat">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </Show>
            </div>

            {/* Messages */}
            <div ref={scrollRef} onScroll={onScroll} class="min-h-0 flex-1 overflow-y-auto p-4">
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
                            if (!canEdit(msg) || editingId() === msg.id) return
                            ui.actionSheet({
                                title: 'Message',
                                actions: [
                                    { label: 'Edit', icon: 'edit', onSelect: () => startEdit(msg) },
                                    { label: 'Delete', icon: 'delete', danger: true, onSelect: () => deleteMessage(msg) },
                                ],
                            })
                        })
                        return (
                            <div {...lp.handlers} classList={{ 'mt-4': showHeader, 'mt-0.5': !showHeader }} class="group relative">
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
                                                ref={(el) => queueMicrotask(() => el.focus())}
                                                onInput={(e) => setEditDraft(e.currentTarget.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' && !e.shiftKey) {
                                                        e.preventDefault()
                                                        void saveEdit(msg)
                                                    } else if (e.key === 'Escape') {
                                                        cancelEdit()
                                                    }
                                                }}
                                                rows={2}
                                                class="bg-element-matte text-main border-element-accent focus:border-highlight w-full resize-none rounded-md border px-2 py-1.5 text-sm focus:outline-none"
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

                                    {/* Hover actions on own messages */}
                                    <Show when={canEdit(msg) && editingId() !== msg.id}>
                                        <div class="shrink-0 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                            <button onClick={() => startEdit(msg)} title="Edit" class="text-sub hover:text-main hover:cursor-pointer">
                                                <span class="material-symbols-outlined text-sm">edit</span>
                                            </button>
                                            <button onClick={() => deleteMessage(msg)} title="Delete" class="text-sub hover:text-danger hover:cursor-pointer">
                                                <span class="material-symbols-outlined text-sm">delete</span>
                                            </button>
                                        </div>
                                    </Show>
                                </div>
                            </div>
                        )
                    }}
                </For>
              </div>
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
                    <Editor chrome="chat" onSubmit={(_t, content) => sendMessage(content)} />
                </div>
            </Show>
        </div>
    )
}

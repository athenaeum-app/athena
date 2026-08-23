import { createSignal } from 'solid-js'
import { api, type ChatMessage } from './api'

// One poll of the newest chat messages, shared by every surface that shows
// them: the panel's scrollback and the Menu column's preview widget.
//
// They used to poll separately on their own five-second timers. Two timers
// started at different moments never line up, so the preview sat up to a full
// cycle behind the panel beside it, showing the message before the one you
// had just sent. It also meant two requests for the same rows.
//
// The panel still owns its scrollback (older pages, grouping, scroll
// position); this owns only the newest window and who is currently watching
// it. A surface that mutates chat writes the change here as well, so the
// preview reflects a send or a delete on the same frame rather than on the
// next poll.

// How many messages one page of chat is: the newest window this polls, the
// page ChatPanel pulls per scroll upward, and the server's own default. The
// preview reads the tail of the same window rather than asking for a shorter
// one of its own, so the two never disagree about what the latest message is.
// The server clamps `limit` to 500.
export const CHAT_PAGE_SIZE = 50
const POLL_MS = 5000

// Oldest first, the order both readers render in.
const [recentChat, setRecentChat] = createSignal<ChatMessage[]>([])
// False until the first fetch settles, so a reader can tell "no messages yet"
// from "not asked yet" without a loading flag of its own.
const [chatFeedLoaded, setChatFeedLoaded] = createSignal(false)

export { recentChat, chatFeedLoaded }

// Preserve the identity of anything that did not actually change. Every poll
// returns brand-new objects even for untouched rows, and handing <For> a new
// reference per message per cycle rebuilds the whole visible list every five
// seconds: flicker, lost hover state, replayed animations.
// Whether two copies of a message say the same thing, and so whether the older
// object can be kept. Exported because the panel merges its own scrollback the
// same way and the two answers must not drift apart.
//
// The reply line counts as part of the message: editing what a reply answers
// changes nothing on the reply's own row, so comparing content and updated_at
// alone would keep a stale preview of it forever.
export const sameChatMessage = (a: ChatMessage, b: ChatMessage): boolean =>
    a.content === b.content &&
    a.updated_at === b.updated_at &&
    a.reply_to?.content === b.reply_to?.content &&
    a.reply_to?.deleted === b.reply_to?.deleted

const merge = (prev: ChatMessage[], fresh: ChatMessage[]): ChatMessage[] =>
    fresh.map((msg) => {
        const existing = prev.find((m) => m.id === msg.id)
        return existing && sameChatMessage(existing, msg) ? existing : msg
    })

// Concurrent callers (a second subscriber mounting mid-poll) share one request
// rather than racing two responses into the same signal.
let inFlight: Promise<void> | null = null

export function refreshChatFeed(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = api
        .listChat({ limit: CHAT_PAGE_SIZE })
        .then((msgs) => {
            setRecentChat((prev) => merge(prev, msgs.reverse()))
        })
        .catch(() => {
            /* polling is best-effort; the next cycle tries again */
        })
        .finally(() => {
            setChatFeedLoaded(true)
            inFlight = null
        })
    return inFlight
}

// An optimistic local change (a send, an edit, a delete), applied to the shared
// window so every reader shows it at once. The next poll reconciles it against
// the server; a failed mutation should call refreshChatFeed() to undo it.
export function mutateChatFeed(fn: (msgs: ChatMessage[]) => ChatMessage[]): void {
    setRecentChat((prev) => fn(prev))
}

let watchers = 0
let timer: ReturnType<typeof setInterval> | undefined

// Poll only while something is on screen to see it. Returns the unsubscribe.
export function watchChatFeed(): () => void {
    watchers++
    if (watchers === 1) timer = setInterval(refreshChatFeed, POLL_MS)
    void refreshChatFeed()
    return () => {
        watchers--
        if (watchers === 0 && timer) {
            clearInterval(timer)
            timer = undefined
        }
    }
}

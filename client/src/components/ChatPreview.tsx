import { For, Show, createSignal, onMount, onCleanup, type Component } from 'solid-js'
import { api, type ChatMessage } from '../api'
import { loadUsers, userName } from '../users'

// Read-only preview of the last few chat messages for the docked Menu-column
// widget (see prefs.chatWidgetFull): plain text, no composer, no edit/delete.
// The whole thing is one big click target that opens the full ChatModal.
// Deliberately NOT MomentBody-rendered (no embeds/links) since this sits
// inside a <button> in MenuPanel and nested interactive elements would break.

const PREVIEW_COUNT = 5
const POLL_MS = 5000

export const ChatPreview: Component = () => {
    const [messages, setMessages] = createSignal<ChatMessage[]>([])
    const [loading, setLoading] = createSignal(true)

    // Same identity-preserving merge as ChatPanel's mergeRecent, so the
    // preview doesn't flicker/rebuild on every poll when nothing changed.
    const fetchRecent = async () => {
        try {
            const msgs = await api.listChat({ limit: PREVIEW_COUNT })
            setMessages((prev) =>
                msgs
                    .slice()
                    .reverse()
                    .map((fresh) => {
                        const existing = prev.find((m) => m.id === fresh.id)
                        return existing && existing.content === fresh.content && existing.updated_at === fresh.updated_at
                            ? existing
                            : fresh
                    }),
            )
        } catch {
            /* preview is best-effort */
        } finally {
            setLoading(false)
        }
    }

    onMount(() => {
        loadUsers()
        fetchRecent()
        const interval = setInterval(fetchRecent, POLL_MS)
        onCleanup(() => clearInterval(interval))
    })

    const authorLabel = (msg: ChatMessage) => (msg.author_id ? userName(msg.author_id) : msg.display_name || 'Unknown')

    return (
        <div class="flex min-w-0 flex-col gap-1.5">
            <Show when={!loading()} fallback={<p class="text-sub/60 text-xs italic">Loading…</p>}>
                <Show when={messages().length > 0} fallback={<p class="text-sub/60 text-xs italic">No messages yet. Tap to start chatting.</p>}>
                    <For each={messages()}>
                        {(msg) => (
                            <div class="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
                                <span class="text-highlight-strong shrink-0 text-xs font-bold">{authorLabel(msg)}</span>
                                <span class="text-sub min-w-0 truncate text-xs">{msg.content}</span>
                            </div>
                        )}
                    </For>
                </Show>
            </Show>
        </div>
    )
}

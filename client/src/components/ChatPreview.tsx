import { For, Show, onMount, onCleanup, createMemo, type Component } from 'solid-js'
import { type ChatMessage } from '../api'
import { loadUsers, userName } from '../users'
import { recentChat, chatFeedLoaded, watchChatFeed } from '../chatFeed'

// Read-only preview of the last few chat messages for the docked Menu-column
// widget (see prefs.chatWidgetFull): plain text, no composer, no edit/delete.
// The whole thing is one big click target that opens the full ChatModal.
// Deliberately NOT MomentBody-rendered (no embeds/links) since this sits
// inside a <button> in MenuPanel and nested interactive elements would break.
//
// The messages come off the shared chat feed rather than a fetch of its own,
// so the preview shows exactly what the panel beside it shows instead of
// trailing it by a poll.

const PREVIEW_COUNT = 5

export const ChatPreview: Component = () => {
    const messages = createMemo(() => recentChat().slice(-PREVIEW_COUNT))

    onMount(() => {
        loadUsers()
        onCleanup(watchChatFeed())
    })

    const authorLabel = (msg: ChatMessage) => (msg.author_id ? userName(msg.author_id) : msg.display_name || 'Unknown')

    return (
        <div class="flex min-w-0 flex-col gap-1.5">
            <Show when={chatFeedLoaded()} fallback={<p class="text-sub/60 text-xs italic">Loading…</p>}>
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

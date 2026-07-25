// Tiny client-local pub/sub so a live-embedded todo card (MomentBody's
// TodoEmbed, used in moments and chat) knows to refetch when its list is
// edited from the full Todo board. The two are separate component instances
// with no shared state otherwise: without this, an embed only ever fetches
// once on mount, so changes made in the board (or by another embed) don't
// show up until something forces the embed to remount, for example resaving the
// moment that hosts it.

import { createSignal } from 'solid-js'

const [versions, setVersions] = createSignal<Record<string, number>>({})

export function notifyTodoChanged(listId: string) {
    setVersions((v) => ({ ...v, [listId]: (v[listId] ?? 0) + 1 }))
}

export function todoVersion(listId: string): number {
    return versions()[listId] ?? 0
}

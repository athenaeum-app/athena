// Client-side user directory cache. Resolves author/actor IDs to usernames for
// chat, the audit log, and canvas so raw UUIDs never surface in the UI. The
// directory is fetched once (via the member-visible GET /api/v1/users) and
// memoized; it is backed by a Solid signal so anything calling userName()
// inside a reactive scope re-renders when the directory loads.

import { createSignal } from 'solid-js'
import { api, type PublicUser } from './api'

const [users, setUsers] = createSignal<Record<string, PublicUser>>({})
let loaded = false
let inflight: Promise<void> | null = null

export { users }

// loadUsers fetches and caches the directory. Concurrent callers share one
// request; it's a no-op once loaded unless `force` is set. Best-effort: on
// failure the cache stays empty and callers fall back to short IDs.
export function loadUsers(force = false): Promise<void> {
    if (loaded && !force) return Promise.resolve()
    if (inflight) return inflight
    inflight = api
        .listUsers()
        .then((list) => {
            const map: Record<string, PublicUser> = {}
            for (const u of list) map[u.id] = u
            setUsers(map)
            loaded = true
        })
        .catch(() => {
            /* directory is best-effort; callers fall back to IDs */
        })
        .finally(() => {
            inflight = null
        })
    return inflight
}

// userName resolves an id to its username, falling back to a short id form
// while the directory is still loading or if the user is unknown.
export function userName(id: string | undefined | null): string {
    if (!id) return 'Unknown'
    const user = users()[id]
    return user ? user.username : `${id.slice(0, 8)}…`
}

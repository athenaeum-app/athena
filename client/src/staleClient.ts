import { api } from './api'
import { desktop } from './desktop'

// The client and the server ship as one artifact but do not run as one: the
// browser (or the desktop shell's persistent partition) keeps serving the build
// it loaded until something evicts it. Upgrade the server and the open session
// carries on with the old PWA, which is what Settings > Library content > Reload
// existed to fix by hand. This watches for that gap and closes it.

// The answer changes when someone deploys, not on a human timescale, so a slow
// interval buys freshness for one small request a minute per open tab. The
// delta-sync poll runs at 3s and is deliberately not reused: it exists to keep
// content live, and hanging a rare concern off a hot path makes both worse.
const CHECK_INTERVAL_MS = 60_000

// Which server build we already reloaded for, kept where it survives the reload
// it triggers. If the fresh page still reports the old client version (a cache
// that will not clear, a proxy serving stale assets), the second attempt is
// skipped rather than becoming a boot loop.
const ATTEMPTED_KEY = 'athena-reloaded-for'

// The server takes its version from the git tag, the client from package.json,
// so 'v2.4.3' and '2.4.3' are the same build.
const normalize = (v: string) => v.trim().replace(/^v/, '')

// What a server built without ldflags reports, which is every developer build
// and every `go build ./...`. A mismatch against that is normal, not stale.
const isDevBuild = (v: string) => !v || normalize(v) === 'dev'

// Reloading throws away anything typed but not yet posted. The moment composer
// mirrors to localStorage and would come back; the chat composer does not. So
// rather than reason about which surfaces are mounted, hold off while anything
// holds text and take the next tick instead. A reload deferred indefinitely is
// the right trade: their unsent message beats our freshness, and the next
// ordinary page load picks the new build up anyway.
const holdingUnsavedText = () =>
    Array.from(document.querySelectorAll('textarea')).some((field) => field.value.trim() !== '')

function attempted(): string | null {
    try {
        return sessionStorage.getItem(ATTEMPTED_KEY)
    } catch {
        return null
    }
}

function rememberAttempt(version: string | null) {
    try {
        if (version === null) sessionStorage.removeItem(ATTEMPTED_KEY)
        else sessionStorage.setItem(ATTEMPTED_KEY, version)
    } catch {
        // Private mode with storage disabled. Without the marker the loop guard
        // is gone, so the check below refuses to reload at all rather than risk
        // reloading forever.
    }
}

// In the desktop shell this is the same path the manual button takes: clearing
// the partition's service worker, cache storage and HTTP cache, leaving cookies
// and localStorage (the session and the PWA's prefs) alone. In a browser there
// is no such bridge, and a plain reload can hand back exactly the assets we are
// trying to replace, so the service worker and its caches are dropped first.
async function reloadFromServer(): Promise<void> {
    const bridge = desktop()
    if (bridge?.reloadContent) {
        await bridge.reloadContent()
        return
    }
    try {
        const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? []
        await Promise.all(registrations.map((registration) => registration.unregister()))
        if (typeof caches !== 'undefined') {
            const keys = await caches.keys()
            await Promise.all(keys.map((key) => caches.delete(key)))
        }
    } catch {
        // Best effort. A reload against a stale cache is still worth trying,
        // and the attempt marker stops it repeating if it changes nothing.
    }
    location.reload()
}

// Exported for its own sake: the decision is the part worth testing, separately
// from the timer and the reload it drives.
export function shouldReload(serverVersion: string, clientVersion: string, alreadyTried: string | null): boolean {
    if (isDevBuild(serverVersion)) return false
    if (normalize(serverVersion) === normalize(clientVersion)) return false
    return alreadyTried !== normalize(serverVersion)
}

async function check(): Promise<void> {
    let serverVersion: string
    try {
        serverVersion = (await api.getServerVersion()).version
    } catch {
        // Offline, or signed out. Either way there is nothing to compare.
        return
    }

    // Back in step, so a later upgrade gets a fresh attempt.
    if (!isDevBuild(serverVersion) && normalize(serverVersion) === normalize(__APP_VERSION__)) {
        if (attempted()) rememberAttempt(null)
        return
    }

    if (!shouldReload(serverVersion, __APP_VERSION__, attempted())) return
    if (holdingUnsavedText()) return

    rememberAttempt(normalize(serverVersion))
    // Without storage the marker never sticks, and a reload that does not fix
    // the mismatch would repeat every tick.
    if (attempted() !== normalize(serverVersion)) return
    await reloadFromServer()
}

// Starts the watch and returns its teardown. Checks on a slow interval, and
// again whenever the tab comes back to the foreground: a session left open
// overnight should not wait out the rest of its interval to notice.
export function watchForNewBuild(): () => void {
    const onVisible = () => {
        if (document.visibilityState === 'visible') void check()
    }
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisible)
    void check()
    return () => {
        clearInterval(timer)
        document.removeEventListener('visibilitychange', onVisible)
    }
}

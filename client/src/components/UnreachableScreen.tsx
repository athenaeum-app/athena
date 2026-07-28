import { createSignal, onCleanup, onMount, type Component } from 'solid-js'
import { api } from '../api'
import { useAuth } from '../auth'
import { desktop } from '../desktop'
import { serverUnreachable } from '../reachability'
import { AuthShell } from './AuthShell'
import { LibrariesPanel } from './LibrariesPanel'

// What renders instead of the app, and instead of the login form, when the
// server cannot be reached at all. Its one job is to stop the dead end: name
// the library that is down, keep trying to come back on its own, and, in the
// desktop shell, keep the other libraries one click away. Before this screen
// existed, a stopped server produced a login form whose only possible answer
// was the browser's raw "Failed to fetch".
//
// Recovery is a soft re-run of the session check, not a page reload, so
// appearance and prefs are not re-hydrated from scratch. If the outage was an
// update landing a new build, staleClient's own watcher reloads within a
// minute of re-entering the app, so nothing is lost by staying soft here.

// Waits between automatic probes. The first retry is quick because most
// outages here are a container swap measured in seconds (an unattended update
// restarting the server); the cap keeps a genuinely-down server from being
// hammered while also keeping "walk back to the desk" recovery under 15s.
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]

export const UnreachableScreen: Component = () => {
    const auth = useAuth()
    const [checking, setChecking] = createSignal(false)

    // Which library this even is. The bridge holds the profile list offline,
    // so the name survives the server being gone; a plain browser falls back
    // to the origin it is looking at.
    const [name, setName] = createSignal('')
    const [url, setUrl] = createSignal(typeof location !== 'undefined' ? location.host : '')

    onMount(async () => {
        const bridge = desktop()
        if (!bridge?.listLibraries || !bridge.activeLibraryId) return
        try {
            const [libs, active] = await Promise.all([bridge.listLibraries(), bridge.activeLibraryId()])
            const lib = (libs ?? []).find((l) => l.id === active)
            if (lib) {
                setName(lib.name)
                setUrl(lib.url)
            }
        } catch {
            /* the fallback identity is already set */
        }
    })

    let timer: number | undefined
    let attempts = 0
    let disposed = false

    const schedule = () => {
        if (disposed) return
        const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
        attempts++
        timer = window.setTimeout(() => void attempt(), delay)
    }

    // One probe: is the server answering at all, and if so, do we have a
    // session. health is public, so this works logged out; refresh() then
    // routes the outcome, and a success flips serverUnreachable off, which
    // unmounts this screen from the gate in index.tsx. refresh() never
    // throws, so reading the signal afterwards is the real verdict: the
    // server can die again between the two awaits.
    const attempt = async () => {
        if (checking() || disposed) return
        setChecking(true)
        try {
            await api.getHealth()
            await auth.refresh()
        } catch {
            /* still down; the signal check below schedules the next probe */
        } finally {
            setChecking(false)
        }
        if (serverUnreachable()) schedule()
    }

    // Coming back to the tab, or the OS reporting the network returned, are
    // both stronger signals than any timer. Probe immediately on either.
    const onVisible = () => {
        if (document.visibilityState === 'visible') void attempt()
    }
    const onOnline = () => void attempt()

    onMount(() => {
        schedule()
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('online', onOnline)
    })
    onCleanup(() => {
        disposed = true
        if (timer !== undefined) clearTimeout(timer)
        document.removeEventListener('visibilitychange', onVisible)
        window.removeEventListener('online', onOnline)
    })

    return (
        <AuthShell>
            <div class="flex w-full max-w-sm flex-col gap-4" data-testid="unreachable-screen">
                <div class="bg-element-matte border-element-accent flex w-full flex-col items-center gap-4 border p-10 text-center shadow-xl">
                    <img src="/logo.png" alt="Athena" class="h-14 w-14 opacity-80" />
                    <div>
                        <h1 class="text-main font-serif text-2xl font-semibold">
                            Can't reach {name() || 'this library'}
                        </h1>
                        <p class="text-sub mt-1 break-all font-mono text-xs">{url()}</p>
                    </div>
                    <p class="text-sub text-sm leading-relaxed">
                        The server isn't answering. It may be restarting or offline; this page returns
                        on its own as soon as it comes back.
                    </p>
                    <button
                        type="button"
                        onClick={() => void attempt()}
                        disabled={checking()}
                        class="bg-highlight-strongest w-full rounded-sm py-2.5 font-semibold text-white transition-[filter] hover:brightness-110 disabled:opacity-50"
                    >
                        {checking() ? 'Checking…' : 'Retry now'}
                    </button>
                </div>

                {/* Desktop shell only (it gates itself on the bridge): the rest
                    of the shelf, so a dead library is a switch away from a live
                    one instead of a wall. */}
                <LibrariesPanel />
            </div>
        </AuthShell>
    )
}

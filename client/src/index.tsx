import { Show } from 'solid-js'
import { render } from 'solid-js/web'
import { Router, Route } from '@solidjs/router'
import { QueryClientProvider } from '@tanstack/solid-query'
import { queryClient } from './query'
import { AuthProvider } from './auth'
import { UIProvider } from './ui'
import { App } from './App'
import { Login } from './pages/Login'
import { Register } from './pages/Register'
import { Setup } from './pages/Setup'
import { applyTheme, getActiveTheme } from './themes'
import { applyLook, getActiveLook } from './looks'
import { applyPrefs, reloadPrefs } from './prefs'
import { hydrateAppearance } from './appearance'
import { isElectron } from './electron'
import { serverUnreachable } from './reachability'
import { UnreachableScreen } from './components/UnreachableScreen'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

const applyAppearance = () => {
    applyTheme(getActiveTheme())
    applyLook(getActiveLook())
    applyPrefs()
}

// Apply from local values immediately so a browser paints the right theme with
// no flash. On desktop, hydrateAppearance() below may replace these with the
// shared global appearance and we re-apply.
applyAppearance()

// A per-server override reset (ADR-0016) rewrites localStorage; re-apply.
window.addEventListener('athena:appearance-reapply', () => {
    reloadPrefs()
    applyAppearance()
})

async function boot() {
    // Pull the shared global appearance (+ this server's overrides) into
    // localStorage before mounting. No-op in a browser / older shell.
    await hydrateAppearance()
    reloadPrefs()
    applyAppearance()
    mount()
}

const mount = () =>
    render(
    () => (
        <QueryClientProvider client={queryClient}>
        <AuthProvider>
            <UIProvider>
                {/* The Electron shell hides the OS title bar (main.js), so this
                    strip is the only way to drag the window. It sits above every
                    route, not just App's header, since Setup/Login/Register have
                    no header of their own. */}
                <Show when={isElectron}>
                    <div class="app-drag-region fixed inset-x-0 top-0 z-40 h-9" />
                </Show>
                {/* One gate above the Router, so every route answers a dead
                    server the same way. /login and /setup are inside on
                    purpose: a server that is not answering cannot take a
                    password or a first account, and the form pretending
                    otherwise was the dead end this replaces. Mid-session
                    failures never flip this signal (see reachability.ts), so
                    the app tree is never unmounted out from under a draft. */}
                <Show when={!serverUnreachable()} fallback={<UnreachableScreen />}>
                    <Router>
                        <Route path="/setup" component={Setup} />
                        <Route path="/login" component={Login} />
                        <Route path="/register" component={Register} />
                        <Route path="/*" component={App} />
                    </Router>
                </Show>
            </UIProvider>
        </AuthProvider>
        </QueryClientProvider>
    ),
    root,
)

void boot()

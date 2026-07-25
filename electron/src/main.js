// Athena desktop shell: main process (ES module).
//
// v2.2 (ADR-0014): Electron is now the PRIMARY Athena client. The window is a
// persistent chrome shell. `shell.html` renders a LibraryBar-style server
// sidebar as permanent left chrome, and the active server's PWA is embedded
// in a child `WebContentsView` positioned to the right of the sidebar. This
// replaces the old model where the whole window navigated between a local
// picker page and `loadURL(serverUrl)` (which destroyed the picker on open).
//
// Each server view runs in its own persistent session partition
// (`persist:srv-<id>`), implementing the per-server isolation ADR-0012
// promised. Persistent partitions keep cookies, so the user stays logged in to
// every server at once and switching is instant. We (re)create a single
// content view per switch. Keeping N views alive for zero-flicker switching is
// a later optimization.
//
// The embedded PWA gets a minimal, read-only preload bridge
// (`content-preload.cjs` → `window.athenaDesktop`): a deliberate, narrow
// exception to ADR-0002's "the PWA runs with no preload", used only for
// desktop-integration reads (system fonts, app version, update check) and
// server switching. No library data flows through it.
//
// This file is ESM (package.json has "type": "module") because its two
// dependencies (electron-store v10) are ESM-only and can no longer be
// require()d from CommonJS.

import { app, BrowserWindow, WebContentsView, ipcMain, Menu } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Store from 'electron-store'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

// __dirname does not exist in ESM; derive it from this module's URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// A dev run (`npm run dev` / `electron .`) reads the same package.json "name"
// as the packaged app, so app.getPath('userData') would otherwise resolve to
// the SAME directory as a real install, sharing electron-store's config
// (saved server profiles, last-opened server, themes, appearance) and every
// server's session partition (cookies/login/localStorage). That let a dev
// run mutate or wipe (see reset-store.mjs) a real installed app's state.
// Electron's own recipe for this is to give dev a separate userData path,
// keyed off app.isPackaged (true only for a real install). Must run before
// anything reads app.getPath('userData'), in particular before `new Store()`.
if (!app.isPackaged) {
    app.setPath('userData', app.getPath('userData') + ' (dev)')
}

// App icon for the window/taskbar. electron-builder uses electron/build/icon.*
// for packaged apps, but a dev run (`npm run dev`) needs it set explicitly on
// the BrowserWindow or Windows/Linux fall back to the default Electron icon.
// (macOS shows the .icns from the app bundle and ignores the window icon.)
const APP_ICON = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')

const store = new Store({
    defaults: {
        // List of saved server profiles: [{ id, name, url }], in rail order.
        servers: [],
        // The profile id to open on launch, or null to show the welcome page.
        lastServerId: null,
        // Per-server theme map (Proposal 1 / ADR-0012): serverId -> theme id.
        // Note: because each server is its own origin, the PWA's own
        // localStorage theme is already per-server; this shell-level map
        // additionally lets the chrome remember a preferred theme per profile.
        serverThemes: {},
        // Global appearance (ADR-0016): the PWA's appearance surface (theme,
        // look, prefs, per-archive themes) is shared across all servers instead
        // of being trapped per-partition. `appearanceGlobal` maps a localStorage
        // key -> its stringified value; `appearanceOverrides` maps serverId ->
        // { key: value } for the per-server deviations.
        appearanceGlobal: {},
        appearanceOverrides: {},
    },
})

// Dev mode: `npm run dev` sets ATHENA_DEV_URL to the Vite dev server.
const devUrl = process.env.ATHENA_DEV_URL

// Sidebar (rail) widths in CSS pixels. These MUST match the sidebar widths in
// shell.html. The main process owns the content view's x-offset while the
// renderer owns the visible sidebar, so a mismatch would leave a gap or an
// overlap. Keep the two in sync if you change them.
//
// The PWA now renders its own Libraries switcher inline
// (see client/src/components/LibrariesPanel.tsx, prefs.librariesPlacement),
// so the native sidebar's job is reduced to on-demand server *management*
// (add/rename/remove/reorder) rather than being permanently reserved chrome.
// It defaults to hidden (0) and only opens to RAIL_EXPANDED, on request.
// There is no more persistent "always a rail" state.
const RAIL_EXPANDED = 240
const RAIL_HIDDEN = 0

// Default native titlebar-overlay colours (the OS window-control strip above
// the sidebar). Mirrors shell.html's dark defaults / the window backgroundColor
// so the strip matches the chrome before any server theme arrives, and is
// restored in the welcome state. Themed live from the active server (see
// applyChromeTheme) so the controls sit on the sidebar's own background.
const DEFAULT_TITLEBAR = { color: '#0f172a', symbolColor: '#94a3b8', height: 36 }

let mainWindow = null
// The active server's embedded PWA view, or null in the zero-server / welcome
// state (when the shell shows the full-window hero instead).
let contentView = null
let activeServerId = null
// Current sidebar width; hidden by default (see RAIL_HIDDEN above), opened
// on demand by the shell's toggle or the embedded PWA's "manage" action.
let railWidth = RAIL_HIDDEN
// Periodic health-ping timer (status dots in the rail).
let healthTimer = null
// Last known reachability per server id, from those pings. The shell keeps its
// own copy from the push events; this one exists so a *fresh* reader (the
// embedded PWA's own switcher, which lists libraries on mount) sees the
// statuses already gathered instead of grey dots until the next 30s round.
const serverStatuses = new Map()
// Transparent overlay view hosting the add-/remove-library modals. Created
// lazily and reused; stacked above the content view while a modal is open (see
// the modal-overlay comment block below).
let overlayView = null
// Whether the modal overlay is currently stacked/visible. Used to push live
// theme updates to it while it is open.
let overlayVisible = false
// The last chrome palette applied by applyChromeTheme (or null in the welcome
// state). Cached so a newly-shown modal overlay can inherit the *current*
// library's theme instead of rendering with its hard-coded dark defaults.
// Otherwise opening "Add library" looks like the theme reset to default.
let currentPalette = null

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: 'Athena',
        icon: APP_ICON,
        backgroundColor: '#0f172a',
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#0f172a',
            symbolColor: '#94a3b8',
            height: 36,
        },
        webPreferences: {
            // The shell chrome (shell.html) uses the preload below for its IPC
            // bridge. The embedded PWA gets a *separate*, narrower preload set
            // per content view (see setActiveServer).
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.cjs'),
        },
    })

    // Hide the menu bar; the shell provides its own UI.
    mainWindow.setMenuBarVisibility(false)
    mainWindow.loadFile(path.join(__dirname, 'shell.html'))

    // Keep the embedded content view (and the modal overlay, when shown) sized
    // to the window as it resizes.
    mainWindow.on('resize', () => {
        updateContentBounds()
        updateOverlayBounds()
    })

    mainWindow.on('closed', () => {
        mainWindow = null
        contentView = null
        overlayView = null
        activeServerId = null
    })

    return mainWindow
}

// normalizeUrl prefixes a bare host with http:// so both the content view and
// the health pinger get an absolute URL.
function normalizeUrl(url) {
    return /^https?:\/\//i.test(url) ? url : 'http://' + url
}

// updateContentBounds positions the embedded PWA view to fill the window to
// the right of the sidebar. No-op when there is no active content view.
function updateContentBounds() {
    if (!contentView || !mainWindow) return
    const [width, height] = mainWindow.getContentSize()
    contentView.setBounds({
        x: railWidth,
        y: 0,
        width: Math.max(0, width - railWidth),
        height,
    })
}

// --- Modal overlay ---------------------------------------------------------
// The add-/remove-library modals cannot render from shell.html: a child
// WebContentsView (the active library's embedded PWA) is always composited
// ABOVE the host window's DOM, so a shell-DOM modal would be hidden behind the
// open library (only its dim leaked through the sidebar sliver). Instead the
// modals live in their own transparent WebContentsView that we stack on top of
// the content view while a modal is open, so the library stays visible (dimmed)
// behind them. The view is created once and reused (add/remove child, not
// destroy) to keep opening a modal instant.

function overlayBounds() {
    const [width, height] = mainWindow.getContentSize()
    return { x: 0, y: 0, width, height }
}

function updateOverlayBounds() {
    if (overlayView && mainWindow) overlayView.setBounds(overlayBounds())
}

function ensureOverlay() {
    if (overlayView) return overlayView
    const view = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, 'overlay-preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    })
    // Transparent so the dim backdrop darkens the library showing through.
    view.setBackgroundColor('#00000000')
    view.webContents.loadFile(path.join(__dirname, 'modal-overlay.html'))
    overlayView = view
    return view
}

// showOverlay stacks the modal overlay on top of the content view and tells it
// which modal to show. payload: { type: 'add' } | { type: 'remove', id, name }.
function showOverlay(payload) {
    if (!mainWindow) return
    const view = ensureOverlay()
    view.setBounds(overlayBounds())
    mainWindow.contentView.addChildView(view) // append -> top of the z-order
    overlayVisible = true
    const send = () => {
        // Theme the modal to the active library before revealing it, so opening
        // a modal doesn't flash the overlay's hard-coded dark defaults over a
        // custom-themed library.
        view.webContents.send('overlay:theme', currentPalette)
        view.webContents.send('overlay:show', payload)
        view.webContents.focus()
    }
    if (view.webContents.isLoading()) view.webContents.once('did-finish-load', send)
    else send()
}

// hideOverlay detaches the overlay (keeping the view alive for reuse).
function hideOverlay() {
    overlayVisible = false
    if (overlayView && mainWindow) {
        try {
            mainWindow.contentView.removeChildView(overlayView)
        } catch {
            // best-effort; a destroyed window can throw.
        }
    }
}

// setActiveServer swaps the embedded PWA to the given server profile. It
// recreates the content view against the server's persistent session
// partition (cheap because persistent partitions keep the login cookie), so
// switching stays logged in. Returns true on success.
function setActiveServer(server) {
    if (!server || !mainWindow) return false

    // Tear down the previous view, if any.
    if (contentView) {
        try {
            mainWindow.contentView.removeChildView(contentView)
            contentView.webContents.close()
        } catch {
            // best-effort teardown; a closed webContents can throw.
        }
        contentView = null
    }

    const view = new WebContentsView({
        webPreferences: {
            partition: 'persist:srv-' + server.id,
            preload: path.join(__dirname, 'content-preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    })
    // Paint the app background, not white, so the strip exposed when the rail
    // collapses (the view grows before its page repaints) doesn't flash white.
    view.setBackgroundColor('#0f172a')
    contentView = view
    activeServerId = server.id
    store.set('lastServerId', server.id)

    mainWindow.contentView.addChildView(view)
    updateContentBounds()
    view.webContents.loadURL(normalizeUrl(server.url))

    // Open devtools for the dev server only when explicitly asked (ATHENA_DEVTOOLS).
    // Auto-opening it on every dev launch instruments the embedded webContents,
    // which makes resizing it ~5x more expensive per frame (measured), and with
    // a heavy panel open that turns the rail collapse into a 1-2s freeze. Devs
    // can still toggle devtools from the Servers menu (Ctrl/Cmd+Shift+I).
    if (devUrl && server.url === devUrl && process.env.ATHENA_DEVTOOLS) {
        view.webContents.openDevTools({ mode: 'detach' })
    }

    notifyActiveChanged()
    return true
}

// showWelcome tears down the content view so the shell's zero-server hero (or
// an unselected sidebar) shows through. Used when the last server is removed.
function showWelcome() {
    if (contentView && mainWindow) {
        try {
            mainWindow.contentView.removeChildView(contentView)
            contentView.webContents.close()
        } catch {
            // best-effort
        }
    }
    contentView = null
    activeServerId = null
    store.set('lastServerId', null)
    notifyActiveChanged()
    // No active server = no theme; restore the chrome to its dark defaults.
    applyChromeTheme(null)
}

function notifyActiveChanged() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('servers:active-changed', activeServerId)
    }
}

// notifyRailVisibility tells the embedded PWA whether the native sidebar is
// currently showing. The PWA renders its own Libraries switcher, and the
// two are the same control, so it hides its copy while this one is up rather
// than presenting the user with two switchers side by side.
function notifyRailVisibility() {
    if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.send('ui:rail-visibility', railWidth > 0)
    }
}

// toHex normalizes a CSS colour to #rrggbb. The palette arrives as computed
// `rgb(r, g, b)` / `rgba(...)` strings; setTitleBarOverlay wants a hex colour,
// so convert. Returns null for anything unparseable (caller falls back).
function toHex(color) {
    if (typeof color !== 'string') return null
    if (/^#[0-9a-f]{6}$/i.test(color)) return color
    const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
    if (!match) return null
    const h = (n) => Number(n).toString(16).padStart(2, '0')
    return '#' + h(match[1]) + h(match[2]) + h(match[3])
}

// applyChromeTheme themes the shell chrome to the active server: it relays the
// resolved palette to the sidebar renderer and re-tints the native titlebar
// overlay. A null palette resets both to the dark defaults (welcome state).
function applyChromeTheme(palette) {
    if (!mainWindow || mainWindow.isDestroyed()) return
    currentPalette = palette || null
    mainWindow.webContents.send('servers:theme', currentPalette)
    // Keep an open modal in sync if the active library re-themes while it's up.
    if (overlayVisible && overlayView) {
        overlayView.webContents.send('overlay:theme', currentPalette)
    }
    try {
        const bg = palette && toHex(palette.bg)
        if (bg) {
            mainWindow.setTitleBarOverlay({
                color: bg,
                symbolColor: toHex(palette.sub) || DEFAULT_TITLEBAR.symbolColor,
            })
        } else {
            mainWindow.setTitleBarOverlay(DEFAULT_TITLEBAR)
        }
    } catch {
        // setTitleBarOverlay is unavailable on some platforms (e.g. macOS
        // without the overlay); theming the sidebar is enough there.
    }
}

// content:theme carries the active PWA's resolved theme palette (from
// content-preload.cjs). Accept it only from the *current* content view so a
// closing view can't repaint the chrome, then push it to the sidebar.
ipcMain.on('content:theme', (event, palette) => {
    if (!contentView || event.sender !== contentView.webContents) return
    applyChromeTheme(palette)
})

// notifyServersChanged tells the shell to re-fetch its library list. Used after
// an add/remove driven by the modal overlay (which the shell can't observe on
// its own, since the overlay is a separate view).
function notifyServersChanged() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('servers:changed')
    }
}

// addServerProfile persists a new library profile and returns it. Shared by the
// legacy servers:add IPC and the modal overlay's submit.
function addServerProfile(name, url) {
    const servers = store.get('servers', [])
    const id = 'srv-' + Date.now()
    const server = { id, name: name || url, url }
    servers.push(server)
    store.set('servers', servers)
    rebuildMenu()
    pingAll()
    return server
}

// removeServerProfile deletes a library profile and its theme, and moves the
// view to another library (or the welcome hero) if the removed one was active.
function removeServerProfile(id) {
    const servers = store.get('servers', []).filter((s) => s.id !== id)
    store.set('servers', servers)
    if (store.get('lastServerId') === id) store.set('lastServerId', null)
    const themes = store.get('serverThemes', {})
    delete themes[id]
    store.set('serverThemes', themes)
    rebuildMenu()

    if (activeServerId === id) {
        const next = listServers()[0]
        if (next) setActiveServer(next)
        else showWelcome()
    }
}

// listServers returns the persisted server profiles, plus, in dev, a
// transient "Dev Server" entry for ATHENA_DEV_URL, so `npm run dev` exercises
// the real sidebar/rail flow instead of skipping straight to the client. This
// entry is never written to the store: it must not leak into the profiles a
// real user builds up, and it disappears the moment ATHENA_DEV_URL isn't set.
function listServers() {
    const servers = store.get('servers', [])
    if (devUrl && !servers.some((s) => s.url === devUrl)) {
        return [...servers, { id: 'dev-local', name: 'Dev Server', url: devUrl }]
    }
    return servers
}

function getServerById(id) {
    return listServers().find((s) => s.id === id)
}

// --- IPC handlers for the shell UI ---

ipcMain.handle('servers:list', () =>
    listServers().map((s) => ({ ...s, status: serverStatuses.get(s.id) })),
)
ipcMain.handle('servers:getActive', () => activeServerId)

ipcMain.handle('servers:add', (_event, name, url) => addServerProfile(name, url))

// servers:rename updates a profile's display name (v2.2 inline rename).
ipcMain.handle('servers:rename', (_event, id, name) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return false
    const servers = store.get('servers', [])
    const server = servers.find((x) => x.id === id)
    if (!server) return false
    server.name = trimmed
    store.set('servers', servers)
    rebuildMenu()
    return true
})

ipcMain.handle('servers:remove', (_event, id) => {
    removeServerProfile(id)
    return true
})

// --- Modal overlay IPC (driven by shell.html and modal-overlay.html) ---

// ui:openModal (from the shell) stacks the overlay and shows the requested
// modal. payload: { type: 'add' } | { type: 'remove', id, name }.
ipcMain.handle('ui:openModal', (_event, payload) => {
    showOverlay(payload)
    return true
})

// overlay:close dismisses the overlay without acting.
ipcMain.handle('overlay:close', () => {
    hideOverlay()
    return true
})

// overlay:addSubmit commits an add: persist, hide the overlay, refresh the
// shell rail, then open the freshly added library.
ipcMain.handle('overlay:addSubmit', (_event, name, url) => {
    hideOverlay()
    const server = addServerProfile(name, url)
    notifyServersChanged()
    setActiveServer(server)
    return server
})

// overlay:removeSubmit commits a removal: hide the overlay, delete, refresh.
ipcMain.handle('overlay:removeSubmit', (_event, id) => {
    hideOverlay()
    removeServerProfile(id)
    notifyServersChanged()
    return true
})

// servers:reorder persists a new rail order (Proposal 12, "library
// reordering"). orderedIds is the full list of server ids in the desired
// order; any ids not present are appended in their existing order.
ipcMain.handle('servers:reorder', (_event, orderedIds) => {
    const servers = store.get('servers', [])
    const byId = new Map(servers.map((s) => [s.id, s]))
    const next = []
    for (const id of orderedIds || []) {
        if (byId.has(id)) {
            next.push(byId.get(id))
            byId.delete(id)
        }
    }
    for (const s of byId.values()) next.push(s) // preserve any stragglers
    store.set('servers', next)
    rebuildMenu()
    return next
})

// Global appearance accessors (ADR-0016). The PWA hydrates its localStorage
// appearance from `{ global, override }` on load, and pushes changes back to
// whichever scope it is editing. `override` is scoped to the active server.
ipcMain.handle('appearance:get', () => ({
    global: store.get('appearanceGlobal', {}),
    override: (store.get('appearanceOverrides', {}) || {})[activeServerId] || {},
}))
ipcMain.handle('appearance:setGlobal', (_event, key, value) => {
    const globalAppearance = store.get('appearanceGlobal', {}) || {}
    globalAppearance[key] = value
    store.set('appearanceGlobal', globalAppearance)
    return true
})
ipcMain.handle('appearance:setOverride', (_event, key, value) => {
    if (!activeServerId) return false
    const all = store.get('appearanceOverrides', {}) || {}
    const forServer = all[activeServerId] || {}
    forServer[key] = value
    all[activeServerId] = forServer
    store.set('appearanceOverrides', all)
    return true
})
ipcMain.handle('appearance:clearOverride', (_event, key) => {
    if (!activeServerId) return false
    const all = store.get('appearanceOverrides', {}) || {}
    if (all[activeServerId]) {
        delete all[activeServerId][key]
        store.set('appearanceOverrides', all)
    }
    return true
})

// Per-server theme map accessors (Proposal 1).
ipcMain.handle('servers:getThemes', () => store.get('serverThemes', {}))
ipcMain.handle('servers:setTheme', (_event, id, themeId) => {
    const themes = store.get('serverThemes', {})
    if (themeId) themes[id] = themeId
    else delete themes[id]
    store.set('serverThemes', themes)
    return true
})

ipcMain.handle('servers:open', (_event, id) => {
    const server = getServerById(id)
    if (!server) return false
    return setActiveServer(server)
})

// ui:setRailCollapsed lets the shell's hide/show toggle drive the embedded
// view's x-offset. The shell owns the visible sidebar; main owns the content
// view bounds, so the two must agree on the width (RAIL_* constants). Despite
// the name (kept to avoid churning the shell/preload channel), "collapsed"
// now means fully hidden (0), not the old narrow icon-rail width. The PWA's
// own left-rail placement covers that compact-switcher role now.
ipcMain.handle('ui:setRailCollapsed', (_event, collapsed) => {
    railWidth = collapsed ? RAIL_HIDDEN : RAIL_EXPANDED
    updateContentBounds()
    notifyRailVisibility()
    return true
})

// ui:railVisible is the PWA's initial read, for the window between its page
// loading and the next visibility change (it cannot have received a push yet).
ipcMain.handle('ui:railVisible', () => railWidth > 0)

// ui:openRail is called from the embedded PWA (via athenaDesktop.openRail) to
// surface the server rail. Here, ensure it is expanded and tell the shell.
ipcMain.handle('ui:openRail', () => {
    railWidth = RAIL_EXPANDED
    updateContentBounds()
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ui:expand-rail')
    }
    notifyRailVisibility()
    return true
})

// --- Desktop bridge (athenaDesktop): reads for the PWA settings UI ---

// Fallback font list used when native enumeration is unavailable (e.g. the
// optional `font-list` dependency isn't installed). Common cross-platform
// families so the dropdown is never empty.
const FALLBACK_FONTS = [
    'Arial',
    'Calibri',
    'Cambria',
    'Consolas',
    'Courier New',
    'Georgia',
    'Helvetica',
    'Lucida Console',
    'Segoe UI',
    'Tahoma',
    'Times New Roman',
    'Trebuchet MS',
    'Verdana',
]

ipcMain.handle('desktop:listFonts', async () => {
    try {
        // Dynamic import so a missing optional dependency degrades to the
        // fallback list instead of crashing the app at load time.
        const mod = await import('font-list')
        const fontList = mod.default || mod
        const fonts = await fontList.getFonts({ disableQuoting: true })
        return [...new Set(fonts)].sort((a, b) => a.localeCompare(b))
    } catch {
        return FALLBACK_FONTS
    }
})

ipcMain.handle('desktop:appVersion', () => app.getVersion())

// How long to wait for the updater to say something before giving up. A check
// that hangs is indistinguishable to the user from one that silently failed,
// so it has to resolve one way or the other.
const UPDATE_CHECK_TIMEOUT_MS = 30_000

// Run a check and resolve with its actual outcome. checkForUpdates() only
// promises that the request was made; whether an update exists arrives later on
// the emitter, which is why this waits for the first conclusive event instead
// of returning as soon as the check starts.
function checkForUpdatesNow() {
    return new Promise((resolve) => {
        let settled = false
        let timer
        const finish = (result) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            autoUpdater.removeListener('update-available', onAvailable)
            autoUpdater.removeListener('update-not-available', onNotAvailable)
            autoUpdater.removeListener('update-downloaded', onDownloaded)
            autoUpdater.removeListener('error', onError)
            resolve(result)
        }
        // autoDownload is on, so finding an update already starts fetching it.
        // Waiting for that to finish could take minutes, so report the find and
        // let the download continue in the background.
        const onAvailable = (info) =>
            finish({ status: 'available', message: `Version ${info.version} is available and downloading in the background.` })
        const onNotAvailable = (info) =>
            finish({ status: 'current', message: `Athena ${info?.version || app.getVersion()} is the latest version.` })
        const onDownloaded = (info) =>
            finish({ status: 'downloaded', message: `Version ${info.version} is ready. Restart Athena to install it.` })
        const onError = (err) => finish({ status: 'error', message: err?.message || 'Update check failed.' })

        autoUpdater.once('update-available', onAvailable)
        autoUpdater.once('update-not-available', onNotAvailable)
        autoUpdater.once('update-downloaded', onDownloaded)
        autoUpdater.once('error', onError)
        timer = setTimeout(() => finish({ status: 'error', message: 'Update check timed out.' }), UPDATE_CHECK_TIMEOUT_MS)

        // electron-updater reads the feed from the publish target baked in at
        // build time, so there is nothing to configure at the call site. A
        // rejection here is reported through the same path as an emitted error.
        autoUpdater.checkForUpdates().catch(onError)
    })
}

ipcMain.handle('desktop:checkForUpdates', () => {
    // In dev there is no packaged app to update.
    if (devUrl || !app.isPackaged) return { status: 'dev', message: 'Updates are disabled in dev.' }
    return checkForUpdatesNow()
})

// desktop:reloadContent force-refreshes the *active library's* embedded PWA:
// this is a distinct concern from desktop:checkForUpdates above (which
// updates the Electron app binary itself, not the server-hosted content a
// library serves). Each server's WebContentsView lives in a long-lived
// persistent session partition, and before setCacheHeaders (server-side) a
// stale build could get stuck in that partition's HTTP cache indefinitely.
// The only fix was deleting and re-adding the server, which mints a fresh
// partition. This clears just the service worker registration/cache storage
// and HTTP cache for the active partition (not cookies/localStorage, so the
// session and the PWA's own prefs survive) and hard-reloads, giving the same
// effect on demand without losing login or local settings.
ipcMain.handle('desktop:reloadContent', async () => {
    if (!contentView) return false
    const session = contentView.webContents.session
    try {
        await session.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
        await session.clearCache()
    } catch {
        // best-effort; still attempt the reload below even if clearing failed.
    }
    contentView.webContents.reloadIgnoringCache()
    return true
})

// --- Server health pings (rail status dots) ---

async function pingServer(server) {
    const base = normalizeUrl(server.url).replace(/\/$/, '')
    try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 4000)
        const res = await fetch(base + '/api/v1/health', { signal: ctrl.signal })
        clearTimeout(timer)
        return res.ok ? 'online' : 'offline'
    } catch {
        return 'offline'
    }
}

async function pingAll() {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const servers = listServers()
    await Promise.all(
        servers.map(async (s) => {
            const status = await pingServer(s)
            serverStatuses.set(s.id, status)
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('servers:status', { id: s.id, status })
            }
        }),
    )
}

// rebuildMenu installs an (invisible) application menu whose only purpose is to
// register accelerators: Ctrl/Cmd+Shift+1..9 jump straight to the Nth server,
// Ctrl/Cmd+Shift+S toggles the sidebar. With the persistent rail this is a
// convenience layer, not the primary switch UI.
function rebuildMenu() {
    const servers = listServers()
    const quickSwitch = servers.slice(0, 9).map((s, i) => ({
        label: s.name,
        accelerator: `CmdOrCtrl+Shift+${i + 1}`,
        click: () => setActiveServer(s),
    }))

    const template = [
        {
            label: 'Servers',
            submenu: [
                {
                    label: 'Toggle Sidebar',
                    accelerator: 'CmdOrCtrl+Shift+S',
                    click: () => {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('ui:toggle-rail')
                        }
                    },
                },
                ...(quickSwitch.length ? [{ type: 'separator' }, ...quickSwitch] : []),
                { type: 'separator' },
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { role: 'quit' },
            ],
        },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// --- App lifecycle ---

// openLastServerOrWelcome resumes the last-opened server profile into the
// embedded view, or leaves the shell on its welcome/empty state.
function openLastServerOrWelcome() {
    const lastId = store.get('lastServerId')
    const lastServer = lastId ? getServerById(lastId) : null
    const target = lastServer || listServers()[0] || null
    if (target) setActiveServer(target)
    else notifyActiveChanged()
}

app.whenReady().then(() => {
    if (!devUrl && app.isPackaged) {
        // Auto-update reads the latest.yml that electron-builder publishes
        // beside the installers, so the release it points at is the publish
        // target in electron-builder.yml. Nothing to configure here.
        //
        // This uses electron-updater rather than Electron's own autoUpdater:
        // the built-in one speaks Squirrel, which cannot read the NSIS and
        // AppImage artifacts this project ships, and does not support Linux
        // at all. electron-updater reads electron-builder's own metadata.
        //
        // macOS is the exception. Squirrel.Mac refuses to apply an update to
        // an unsigned bundle, and these builds are unsigned, so a mac user
        // has to download the new DMG by hand until signing is set up.
        try {
            autoUpdater.logger = null
            autoUpdater.autoDownload = true
            autoUpdater.checkForUpdatesAndNotify().catch((err) => {
                console.warn('Update check failed:', err.message)
            })
        } catch (err) {
            // Best-effort. A launcher that cannot reach GitHub still works.
            console.warn('Auto-update not available:', err.message)
        }
    }

    // Install the switch/toggle accelerators.
    rebuildMenu()

    createWindow()
    // Open the last server once the shell page is ready so its sidebar can
    // reflect the active id immediately.
    mainWindow.webContents.once('did-finish-load', () => {
        openLastServerOrWelcome()
        pingAll()
    })

    // Poll health every 30s for the rail status dots.
    healthTimer = setInterval(pingAll, 30000)

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
            mainWindow.webContents.once('did-finish-load', () => {
                openLastServerOrWelcome()
                pingAll()
            })
        }
    })
})

app.on('window-all-closed', () => {
    if (healthTimer) clearInterval(healthTimer)
    if (process.platform !== 'darwin') app.quit()
})

// Content-view preload for the embedded PWA (v2.2 / ADR-0014).
//
// A deliberate, narrow exception to ADR-0002's "the PWA runs with no preload":
// the desktop shell attaches this to each server's WebContentsView to expose a
// small, READ-ONLY bridge for desktop-integration features that the web PWA
// cannot do itself. It carries NO library data. Content still flows only over
// the server's same-origin API.
//
// Surface (window.athenaDesktop):
//   listSystemFonts()  -> string[]   enumerate installed fonts (font dropdown)
//   appVersion()       -> string     packaged app version (About / settings)
//   checkForUpdates()  -> { status, message }   trigger an update check
//   reloadContent()    -> boolean    hard-refresh the active library's PWA
//                                    (clears its SW/cache-storage/HTTP cache
//                                    first), for when a new server build
//                                    hasn't propagated yet
//   switchServer(id)   -> boolean    jump to another server profile
//   openRail()         -> boolean    surface/expand the server sidebar
//   railVisible()      -> boolean    is that sidebar showing right now?
//   onRailVisibility(cb) -> unsubscribe   ...and tell me when that changes
//   listLibraries()    -> [{id,name,url}]   the saved server/library profiles
//   activeLibraryId()  -> string|null       the currently-open library
//
// listLibraries/activeLibraryId let the PWA render its own
// Libraries switcher inline, so the native shell rail can be retired. Still no
// library *content* crosses this bridge, only the profile list (name + url),
// which the shell already knows; content flows over each server's own API.
//
// The presence of window.athenaDesktop is itself the signal that the PWA is
// running inside the desktop shell (used to gate desktop-only settings UI).
//
// It ALSO (send-only, not exposed to the page) reports the active theme's
// resolved colour palette up to main, so the shell chrome (server sidebar +
// titlebar) can theme itself to match. See reportTheme() below.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('athenaDesktop', {
    listSystemFonts: () => ipcRenderer.invoke('desktop:listFonts'),
    appVersion: () => ipcRenderer.invoke('desktop:appVersion'),
    checkForUpdates: () => ipcRenderer.invoke('desktop:checkForUpdates'),
    reloadContent: () => ipcRenderer.invoke('desktop:reloadContent'),
    switchServer: (id) => ipcRenderer.invoke('servers:open', id),
    openRail: () => ipcRenderer.invoke('ui:openRail'),
    railVisible: () => ipcRenderer.invoke('ui:railVisible'),
    onRailVisibility: (cb) => {
        const handler = (_event, visible) => cb(!!visible)
        ipcRenderer.on('ui:rail-visibility', handler)
        return () => ipcRenderer.off('ui:rail-visibility', handler)
    },
    listLibraries: () => ipcRenderer.invoke('servers:list'),
    activeLibraryId: () => ipcRenderer.invoke('servers:getActive'),
    // Global appearance (ADR-0016): shared appearance store + per-server
    // overrides, so theme/look/prefs are global-by-default across servers.
    getAppearance: () => ipcRenderer.invoke('appearance:get'),
    setAppearanceGlobal: (key, value) => ipcRenderer.invoke('appearance:setGlobal', key, value),
    setAppearanceOverride: (key, value) => ipcRenderer.invoke('appearance:setOverride', key, value),
    clearAppearanceOverride: (key) => ipcRenderer.invoke('appearance:clearOverride', key),
})

// --- Theme bridge: PWA -> shell chrome -------------------------------------
// The server sidebar lives in a *different* renderer (the host window) and so
// can't read this PWA's theme, which is chosen here and stored per-origin. We
// resolve the theme's concrete colours and push them to main, which relays
// them to the shell. Send-only; carries no library data.
//
// Map of the shell's palette slots -> the PWA's `--theme-*` custom properties
// (see client/src/index.css). Only the handful the chrome actually paints with.
const THEME_VARS = {
    bg: '--theme-bg',
    matte: '--theme-element-matte',
    accent: '--theme-element-accent',
    lighter: '--theme-element-lighter',
    main: '--theme-text-main',
    sub: '--theme-text-sub',
    plain: '--theme-plain',
    highlight: '--theme-highlight',
}

let lastSent = ''

// reportTheme reads each themed variable through a throwaway probe element and
// pushes the resolved palette to main. The probe is essential: the computed
// value of a custom property can still be an unresolved `var(--color-…)` chain,
// but a real property like background-color forces it down to a concrete rgb().
function reportTheme() {
    if (!document.body) return
    const probe = document.createElement('span')
    probe.style.cssText =
        'position:absolute;left:-9999px;top:-9999px;width:0;height:0;pointer-events:none'
    document.body.appendChild(probe)
    const palette = {}
    for (const key in THEME_VARS) {
        probe.style.backgroundColor = ''
        probe.style.backgroundColor = `var(${THEME_VARS[key]})`
        const computed = getComputedStyle(probe).backgroundColor
        // Skip a transparent read (an undefined var) so we never clobber the
        // chrome's palette with a hole.
        if (computed && computed !== 'rgba(0, 0, 0, 0)' && computed !== 'transparent') palette[key] = computed
    }
    probe.remove()
    const json = JSON.stringify(palette)
    if (json === lastSent) return // nothing changed; don't spam the chrome
    lastSent = json
    ipcRenderer.send('content:theme', palette)
}

function startThemeReporting() {
    reportTheme()
    // applyTheme() toggles data-theme and/or sets inline --theme-* styles on
    // <html>; watch both so switching themes in settings re-themes the chrome
    // live. reportTheme() dedupes, so unrelated inline-style writes are cheap.
    const obs = new MutationObserver(() => reportTheme())
    obs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'style'],
    })
}

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startThemeReporting)
} else {
    startThemeReporting()
}

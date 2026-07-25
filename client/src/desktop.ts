// Typed accessor for the desktop shell's read-only bridge (ADR-0014).
//
// The Athena Electron shell attaches `content-preload.cjs` to the embedded PWA,
// which exposes `window.athenaDesktop`. In a normal browser tab this is
// undefined. Desktop-only settings (font enumeration, animation controls,
// update check) are gated on `isDesktop` and call through `desktop()`.
//
// This carries NO library data. It is a narrow set of desktop-integration
// reads plus server switching. See content-preload.cjs for the full surface.

import { createSignal } from 'solid-js'

export interface DesktopLibrary {
    id: string
    name: string
    url: string
    status?: string
}

export interface AthenaDesktop {
    listSystemFonts: () => Promise<string[]>
    appVersion: () => Promise<string>
    checkForUpdates: () => Promise<{ status: string; message: string }>
    // Hard-refreshes the active library's embedded PWA (clears its service
    // worker/cache storage/HTTP cache, then reloads), a manual escape hatch
    // for when a new server build hasn't propagated yet. Absent on older
    // shells.
    reloadContent?: () => Promise<boolean>
    switchServer: (id: string) => Promise<boolean>
    openRail: () => Promise<boolean>
    // Whether the native shell sidebar is showing, and a subscription to that
    // changing. The PWA's own Libraries switcher is the same control, so it
    // stands down while the native one is up. Absent on older shells, where
    // the switcher just stays visible as it always did.
    railVisible?: () => Promise<boolean>
    onRailVisibility?: (cb: (visible: boolean) => void) => () => void
    // The saved server/library profiles + which one is active, so the PWA
    // can render its own Libraries switcher. Absent on older shells.
    listLibraries?: () => Promise<DesktopLibrary[]>
    activeLibraryId?: () => Promise<string | null>
    // ADR-0016: shared appearance store + per-server overrides. Absent on older
    // shells (the client falls back to plain per-origin localStorage).
    getAppearance?: () => Promise<{ global: Record<string, string>; override: Record<string, string> }>
    setAppearanceGlobal?: (key: string, value: string) => Promise<boolean>
    setAppearanceOverride?: (key: string, value: string) => Promise<boolean>
    clearAppearanceOverride?: (key: string) => Promise<boolean>
}

declare global {
    interface Window {
        athenaDesktop?: AthenaDesktop
    }
}

// desktop() returns the bridge, or undefined outside the desktop shell.
export function desktop(): AthenaDesktop | undefined {
    return typeof window !== 'undefined' ? window.athenaDesktop : undefined
}

// True when running inside the Athena desktop shell (the bridge is present).
// Prefer this over the UA-based isElectron for gating features that actually
// call the bridge, so the UI never offers a control that would no-op.
export const isDesktop = !!desktop()

// --- Native sidebar visibility ---------------------------------------------
// Module-level (not per-component) so every consumer shares one subscription
// and they can never disagree about whether the shell rail is up. Stays false
// on the web and on shells predating the bridge addition, which is the old
// behaviour: the PWA switcher is the only one there is.
const [shellRailOpen, setShellRailOpen] = createSignal(false)
export { shellRailOpen }

const bridge = desktop()
if (bridge?.railVisible) {
    void bridge.railVisible().then(setShellRailOpen).catch(() => {})
}
bridge?.onRailVisibility?.(setShellRailOpen)

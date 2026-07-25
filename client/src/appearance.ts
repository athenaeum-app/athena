// Global appearance with per-server overrides (ADR-0016).
//
// The PWA's appearance (theme, look, prefs, per-archive themes) lives in
// localStorage, which the Electron shell isolates per server partition, so the
// same key silently differs per server. This module lifts the source of truth
// into the desktop shell's shared store (via the content bridge) so appearance
// is GLOBAL by default, with opt-in per-server overrides.
//
// It is a thin sync layer: the individual stores (themes.ts / looks.ts /
// prefs.ts) keep reading and writing localStorage unchanged; they just call
// `syncKey(key)` after persisting, and startup calls `hydrateAppearance()`
// before applying. In a plain browser (or an older shell) the bridge is absent
// and every call no-ops, leaving today's per-origin behaviour intact.

import { createSignal } from 'solid-js'
import { desktop } from './desktop'

// Every appearance-bearing localStorage key. All are mirrored into the global
// store; custom theme/look *definitions* are shared globally and never
// overridden (a server override only changes selections + prefs).
export const APPEARANCE_KEYS = [
    'athena-active-theme',
    'athena-themes',
    'athena-active-look',
    'athena-looks',
    'athena-prefs',
    'athena-archive-themes',
] as const

// Keys a server may override. Definitions (athena-themes / athena-looks) stay
// global so a custom theme made on one server exists on all of them.
export const OVERRIDABLE_KEYS = ['athena-active-theme', 'athena-active-look', 'athena-prefs', 'athena-archive-themes']

// Human labels for the scope UI, at the key (bucket) granularity.
export const OVERRIDE_BUCKETS: { key: string; label: string }[] = [
    { key: 'athena-active-theme', label: 'Color theme' },
    { key: 'athena-active-look', label: 'Look' },
    { key: 'athena-prefs', label: 'Layout & preferences' },
    { key: 'athena-archive-themes', label: 'Per-archive themes' },
]

export type Scope = 'global' | 'server'

const [scope, setScopeSignal] = createSignal<Scope>('global')
const [overriddenKeys, setOverriddenKeys] = createSignal<string[]>([])

export { scope, overriddenKeys }
export const setScope = (s: Scope) => setScopeSignal(s)
export const isOverridden = (key: string) => overriddenKeys().includes(key)

// True only inside the desktop shell that understands the appearance bridge.
export function appearanceIsGlobal(): boolean {
    return !!desktop()?.getAppearance
}

// Hydrate localStorage from the shared store before the stores load/apply.
// Resolution is override → global (archive/server-scoped overrides win). A key
// absent from both is left at whatever this partition already has.
export async function hydrateAppearance(): Promise<void> {
    const bridge = desktop()
    if (!bridge?.getAppearance) return
    try {
        const { global, override } = await bridge.getAppearance()
        for (const key of APPEARANCE_KEYS) {
            const val = (OVERRIDABLE_KEYS.includes(key) ? override[key] : undefined) ?? global[key]
            if (val !== undefined) localStorage.setItem(key, val)
        }
        setOverriddenKeys(Object.keys(override).filter((k) => OVERRIDABLE_KEYS.includes(k)))

        // First-run seeding (ADR-0016 migration): if the shared global store is
        // empty, this is the first server opened after upgrading. Adopt its
        // current appearance as the global default so every server inherits it.
        if (Object.keys(global).length === 0) {
            for (const key of APPEARANCE_KEYS) {
                const cur = localStorage.getItem(key)
                if (cur !== null) void bridge.setAppearanceGlobal?.(key, cur)
            }
        }
    } catch {
        // Bridge failure: fall back to whatever is already in localStorage.
    }
}

// Push the current localStorage value of `key` to the shared store, routed to
// the scope currently being edited. Called by the stores after they persist.
export function syncKey(key: string): void {
    const bridge = desktop()
    if (!bridge?.setAppearanceGlobal) return
    const val = localStorage.getItem(key) ?? ''
    if (OVERRIDABLE_KEYS.includes(key) && scope() === 'server') {
        void bridge.setAppearanceOverride?.(key, val)
        if (!overriddenKeys().includes(key)) setOverriddenKeys([...overriddenKeys(), key])
    } else {
        void bridge.setAppearanceGlobal(key, val)
    }
}

// Drop a server override for `key`, re-hydrate that key from the global default,
// and signal a re-apply so the change shows immediately.
export async function resetOverride(key: string): Promise<void> {
    const bridge = desktop()
    if (!bridge?.clearAppearanceOverride) return
    await bridge.clearAppearanceOverride(key)
    setOverriddenKeys(overriddenKeys().filter((k) => k !== key))
    try {
        const { global } = await bridge.getAppearance!()
        if (global[key] !== undefined) localStorage.setItem(key, global[key])
    } catch {
        // Keep the local value if the global read fails.
    }
    window.dispatchEvent(new Event('athena:appearance-reapply'))
}

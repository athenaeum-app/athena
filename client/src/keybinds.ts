// Global keyboard shortcuts for the PWA. Ports the v1 global shortcuts that
// still map to v2 features (focus search, open chat, open settings, new
// moment, close overlay) and drops the orphans (library-bar toggle,
// grid/full toggle) which have no v2 equivalent.
//
// Bindings are stored in localStorage (`athena-keybinds`) as a map from action
// to a combo string like "Ctrl+F", "Ctrl+,", or "Escape". A binding may use the
// explicit "Ctrl" token (shown to the user verbatim) or the portable "Mod"
// token; both match Ctrl (or Cmd on macOS) at match time.

import { createSignal } from 'solid-js'

export type KeybindAction =
    | 'focusSearch'
    | 'openChat'
    | 'openSettings'
    | 'newMoment'
    | 'saveMoment'
    | 'closeOverlay'

export interface KeybindDef {
    action: KeybindAction
    label: string
    default: string
    // Whether the shortcut should fire while a text field is focused. Only
    // Escape does; everything else is suppressed so typing never triggers it.
    allowInInput?: boolean
}

export const KEYBIND_DEFS: KeybindDef[] = [
    { action: 'focusSearch', label: 'Focus search', default: 'Ctrl+F' },
    { action: 'openChat', label: 'Open chat', default: 'Ctrl+D' },
    { action: 'openSettings', label: 'Open settings', default: 'Mod+,' },
    { action: 'newMoment', label: 'New moment', default: 'Mod+M' },
    // Save/post from inside the editor. Handled by the editor's own key handler
    // (not the global one) so it fires while the textarea is focused.
    { action: 'saveMoment', label: 'Save / post (in editor)', default: 'Mod+S', allowInInput: true },
    { action: 'closeOverlay', label: 'Close dialog / search', default: 'Escape', allowInInput: true },
]

const STORAGE_KEY = 'athena-keybinds'

export type KeybindMap = Record<KeybindAction, string>

function defaults(): KeybindMap {
    const map = {} as KeybindMap
    for (const d of KEYBIND_DEFS) map[d.action] = d.default
    return map
}

function load(): KeybindMap {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return defaults()
        return { ...defaults(), ...JSON.parse(raw) }
    } catch {
        return defaults()
    }
}

const [keybinds, setKeybindsSignal] = createSignal<KeybindMap>(load())

export { keybinds }

export function setKeybind(action: KeybindAction, combo: string) {
    const next = { ...keybinds(), [action]: combo }
    setKeybindsSignal(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}

export function resetKeybinds() {
    setKeybindsSignal(defaults())
    localStorage.removeItem(STORAGE_KEY)
}

// eventToCombo builds a normalised combo string from a keydown event, for the
// rebinding capture UI. Returns '' for a bare modifier press.
export function eventToCombo(e: KeyboardEvent): string {
    const key = e.key
    if (key === 'Control' || key === 'Meta' || key === 'Shift' || key === 'Alt') return ''
    const parts: string[] = []
    if (e.ctrlKey || e.metaKey) parts.push('Mod')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    parts.push(normalizeKey(key))
    return parts.join('+')
}

function normalizeKey(key: string): string {
    if (key === ' ') return 'Space'
    if (key.length === 1) return key.toUpperCase()
    return key
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.platform)

// displayCombo renders a stored combo string for the user, resolving the
// portable "Mod" token to the actual platform modifier (Ctrl or ⌘) instead of
// showing "Mod" verbatim.
export function displayCombo(combo: string): string {
    return combo
        .split('+')
        .map((part) => (part === 'Mod' ? (isMac ? '⌘' : 'Ctrl') : part))
        .join('+')
}

// matchEvent reports whether a keydown event satisfies a combo string.
export function matchEvent(e: KeyboardEvent, combo: string): boolean {
    if (!combo) return false
    const parts = combo.split('+')
    const wantKey = parts[parts.length - 1]
    // Accept the portable "Mod" token or an explicit "Ctrl"/"Cmd"; all mean the
    // platform command modifier (Ctrl on Windows/Linux, Cmd on macOS).
    const wantMod = parts.includes('Mod') || parts.includes('Ctrl') || parts.includes('Cmd')
    const wantAlt = parts.includes('Alt')
    const wantShift = parts.includes('Shift')

    const hasMod = e.ctrlKey || e.metaKey
    if (wantMod !== hasMod) return false
    if (wantAlt !== e.altKey) return false
    // Shift is part of many printable combos implicitly; only enforce when the
    // binding explicitly asks for it.
    if (wantShift && !e.shiftKey) return false
    if (!wantShift && wantKey.length === 1 && e.shiftKey) return false

    return normalizeKey(e.key) === wantKey
}

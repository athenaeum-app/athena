// "Looks": a visual-language layer that sits on top of the colour theme.
// A look controls surface/typography/border/shadow treatment, not colour, so
// looks compose with the 11 themes. Applied via a `data-look` attribute on
// <html> plus a small set of `--look-*` CSS variables the rules in index.css
// consume. Mirrors the theme system (preset + user-made, localStorage).

import { syncKey } from './appearance'

export interface PresetLook {
    id: string
    name: string
    blurb: string
}

// The ship-with looks. Order = display order. Default = Legacy (v1).
export const PRESET_LOOKS: PresetLook[] = [
    { id: 'legacy', name: 'Legacy (v1)', blurb: 'Athena v1: Inter sans, chunky radii, neon shadows' },
    { id: 'editorial', name: 'Editorial', blurb: 'Warm parchment, full serif, hairline rules' },
    { id: 'glass', name: 'Glass', blurb: 'Translucent frosted surfaces' },
    { id: 'ink', name: 'Ink', blurb: 'Near-black, sharp corners, mono metadata' },
    { id: 'aurora', name: 'Aurora', blurb: 'Layered gradient backdrop, glowing accents' },
    { id: 'slate-soft', name: 'Slate-soft', blurb: 'Borderless, soft shadows, large radii' },
]

export const DEFAULT_LOOK = 'legacy'

const ACTIVE_KEY = 'athena-active-look'
const STORAGE_KEY = 'athena-looks'

// The tunables a user-made look exposes. Kept deliberately small.
export interface LookVars {
    radius: string // base border radius, e.g. '0.5rem'
    surfaceOpacity: number // 0.4 to 1, translucency of element surfaces
    blur: string // backdrop blur behind surfaces, e.g. '0px' | '12px'
    shadow: 'none' | 'soft' | 'strong'
    bodyFont: 'serif' | 'sans' | 'mono'
    borderWidth: string // '0px' | '1px'
}

export interface UserLook {
    id: string
    name: string
    vars: LookVars
}

export const DEFAULT_LOOK_VARS: LookVars = {
    radius: '0.5rem',
    surfaceOpacity: 1,
    blur: '0px',
    shadow: 'soft',
    bodyFont: 'sans',
    borderWidth: '1px',
}

const FONT_STACKS: Record<LookVars['bodyFont'], string> = {
    serif: "'Lora', ui-serif, Georgia, 'Times New Roman', serif",
    sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    mono: "ui-monospace, 'Cascadia Code', 'Source Code Pro', 'Courier New', monospace",
}

// The body fonts the preset looks ship with, offered to the font picker so a
// look's typography can be used without its look. Legacy's Inter on
// Editorial, say. The stacks must stay in step with the `--look-body-font`
// declarations in index.css; LOOK_FONT_STACKS_MATCH_CSS in looks.test.ts is
// what notices if they drift.
//
// Only three distinct stacks exist across the six presets: Editorial sets a
// serif, Legacy sets Inter, and the rest inherit the base sans. Mono is
// offered too because a user look can already choose it.
export const LOOK_FONTS: { label: string; stack: string }[] = [
    { label: 'Editorial (Lora serif)', stack: FONT_STACKS.serif },
    { label: 'Legacy (Inter)', stack: "'Inter', sans-serif" },
    { label: 'Glass / Ink / Aurora (system sans)', stack: FONT_STACKS.sans },
    { label: 'Monospace', stack: FONT_STACKS.mono },
]

const SHADOWS: Record<LookVars['shadow'], string> = {
    none: 'none',
    soft: '0 8px 24px -8px rgb(0 0 0 / 0.25)',
    strong: '0 18px 40px -12px rgb(0 0 0 / 0.45)',
}

const INLINE_VARS = ['--look-radius', '--look-surface-opacity', '--look-blur', '--look-shadow', '--look-body-font', '--look-border-width']

export function getActiveLook(): string {
    return localStorage.getItem(ACTIVE_KEY) || DEFAULT_LOOK
}

export function setActiveLook(id: string) {
    localStorage.setItem(ACTIVE_KEY, id)
    syncKey(ACTIVE_KEY)
    applyLook(id)
}

export function applyLook(id: string) {
    const root = document.documentElement
    // Clear any inline custom-look vars first; presets are pure CSS.
    for (const v of INLINE_VARS) root.style.removeProperty(v)

    const custom = loadUserLooks().find((l) => l.id === id)
    if (custom) {
        root.setAttribute('data-look', 'custom')
        const vars = custom.vars
        root.style.setProperty('--look-radius', vars.radius)
        root.style.setProperty('--look-surface-opacity', String(vars.surfaceOpacity))
        root.style.setProperty('--look-blur', vars.blur)
        root.style.setProperty('--look-shadow', SHADOWS[vars.shadow])
        root.style.setProperty('--look-body-font', FONT_STACKS[vars.bodyFont])
        root.style.setProperty('--look-border-width', vars.borderWidth)
    } else {
        root.setAttribute('data-look', id)
    }
}

export function loadUserLooks(): UserLook[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? (parsed as UserLook[]) : []
    } catch {
        return []
    }
}

export function saveUserLooks(looks: UserLook[]) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(looks))
    syncKey(STORAGE_KEY)
}

export function createUserLook(name: string, vars: LookVars): UserLook {
    const look: UserLook = { id: `look-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, vars }
    const looks = loadUserLooks()
    looks.push(look)
    saveUserLooks(looks)
    return look
}

export function updateUserLook(id: string, name: string, vars: LookVars) {
    const looks = loadUserLooks()
    const idx = looks.findIndex((l) => l.id === id)
    if (idx < 0) return
    looks[idx] = { id, name, vars }
    saveUserLooks(looks)
}

export function deleteUserLook(id: string) {
    saveUserLooks(loadUserLooks().filter((l) => l.id !== id))
    if (getActiveLook() === id) setActiveLook(DEFAULT_LOOK)
}

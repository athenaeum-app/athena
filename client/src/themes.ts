// Theme management for the Athena PWA. Themes are applied by setting the
// `data-theme` attribute on the <html> element. Ten themes ship as defaults;
// users can create custom themes stored in localStorage (key: `athena-themes`).
// Custom themes support import/export as a base64-encoded JSON string.
//
// Reference: docs/GLOSSARY.md, "Theme".

import { syncKey } from './appearance'

export interface ThemeColors {
    bg: string
    'element-matte': string
    'element-accent': string
    'element-lighter': string
    'text-main': string
    'text-sub': string
    plain: string
    highlight: string
    'highlight-alt': string
    'md-heading': string
    'md-strong': string
}

// Scoped panel overrides (advanced mode, 4.6). Each is optional; an unset
// value falls back to the corresponding global variable at apply time. Two
// scoped surfaces are supported: the archives panel and the menu/filter panel.
export interface ScopedColors {
    'archive-panel-bg'?: string
    'archive-panel-accent'?: string
    'menu-panel-bg'?: string
    'menu-panel-accent'?: string
}

export const SCOPED_VARS: Record<keyof ScopedColors, string> = {
    'archive-panel-bg': '--theme-archive-panel-bg',
    'archive-panel-accent': '--theme-archive-panel-accent',
    'menu-panel-bg': '--theme-menu-panel-bg',
    'menu-panel-accent': '--theme-menu-panel-accent',
}

export interface UserTheme {
    id: string
    name: string
    colors: ThemeColors
    // Advanced-mode per-panel overrides. Absent for simple themes.
    scoped?: ScopedColors
}

// The CSS variable names that map to ThemeColors keys. These match the
// `--theme-*` variables defined in src/index.css.
export const THEME_VARS: Record<keyof ThemeColors, string> = {
    bg: '--theme-bg',
    'element-matte': '--theme-element-matte',
    'element-accent': '--theme-element-accent',
    'element-lighter': '--theme-element-lighter',
    'text-main': '--theme-text-main',
    'text-sub': '--theme-text-sub',
    plain: '--theme-plain',
    highlight: '--theme-highlight',
    'highlight-alt': '--theme-highlight-alt',
    'md-heading': '--theme-md-heading',
    'md-strong': '--theme-md-strong',
}

// The list of preset theme IDs. These match the [data-theme='...'] blocks
// in src/index.css. The order here is the display order in the switcher.
export const PRESET_THEMES: string[] = [
    'legacy',
    'dark',
    'light',
    'neutral',
    'rose',
    'valentine',
    'ocean',
    'royal blue',
    'sunset',
    'arctic',
    'rosewood',
]

const STORAGE_KEY = 'athena-themes'
const ACTIVE_KEY = 'athena-active-theme'

// --- Legibility guardrail ---
//
// Custom themes come from a colour picker, so a user can easily pick text that
// is nearly invisible on their chosen background. ensureLegible() checks each
// text colour against the theme background and, when it fails a minimum WCAG
// contrast ratio, nudges it toward black/white (whichever raises contrast)
// just enough to pass, preserving the hue while keeping it readable.

type RGB = [number, number, number]

// Minimum contrast ratios per text role. Body text targets AA (4.5:1);
// larger/decorative roles (headings, strong) accept the AA-large 3:1 floor.
const MIN_CONTRAST: Partial<Record<keyof ThemeColors, number>> = {
    'text-main': 4.5,
    'text-sub': 4.5,
    plain: 4.5,
    'md-heading': 3,
    'md-strong': 4.5,
}

function parseColor(input: string): RGB | null {
    const s = input.trim()
    const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
    if (hex) {
        let h = hex[1]
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    }
    const rgb = s.match(/^rgba?\(([^)]+)\)$/i)
    if (rgb) {
        const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number)
        if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) return parts as RGB
    }
    return null
}

function toHex([r, g, b]: RGB): string {
    const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
    return `#${h(r)}${h(g)}${h(b)}`
}

function relLuminance([r, g, b]: RGB): number {
    const chan = (c: number) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}

function contrast(a: RGB, b: RGB): number {
    const la = relLuminance(a)
    const lb = relLuminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function mix(a: RGB, b: RGB, t: number): RGB {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// Nudge `text` toward whichever extreme (white/black) raises contrast against
// `bg`, stopping as soon as it meets `min`. Returns the original if it already
// passes or if no blend gets there.
function raiseContrast(text: RGB, bg: RGB, min: number): RGB {
    if (contrast(text, bg) >= min) return text
    const target: RGB = relLuminance(bg) > 0.4 ? [0, 0, 0] : [255, 255, 255]
    for (let t = 0.1; t <= 1.0001; t += 0.1) {
        const candidate = mix(text, target, t)
        if (contrast(candidate, bg) >= min) return candidate
    }
    return target
}

export function ensureLegible(colors: ThemeColors): ThemeColors {
    const bg = parseColor(colors.bg)
    if (!bg) return colors
    const out = { ...colors }
    for (const key of Object.keys(MIN_CONTRAST) as (keyof ThemeColors)[]) {
        const c = parseColor(out[key])
        if (!c) continue
        const fixed = raiseContrast(c, bg, MIN_CONTRAST[key]!)
        if (fixed !== c) out[key] = toHex(fixed)
    }
    return out
}

// --- Active theme ---

export function getActiveTheme(): string {
    return localStorage.getItem(ACTIVE_KEY) || 'legacy'
}

export function setActiveTheme(id: string) {
    localStorage.setItem(ACTIVE_KEY, id)
    syncKey(ACTIVE_KEY)
    applyTheme(id)
}

export function applyTheme(id: string) {
    const userThemes = loadUserThemes()
    const user = userThemes.find((t) => t.id === id)
    const root = document.documentElement
    // Always clear scoped overrides first; only advanced user themes set them.
    for (const key of Object.keys(SCOPED_VARS) as (keyof ScopedColors)[]) {
        root.style.removeProperty(SCOPED_VARS[key])
    }
    if (user) {
        // Apply custom theme: set data-theme to a sentinel and override each
        // CSS variable inline on :root. Run colours through the legibility
        // guardrail first so a low-contrast custom theme stays readable.
        const colors = ensureLegible(user.colors)
        root.setAttribute('data-theme', 'dark')
        for (const key of Object.keys(colors) as (keyof ThemeColors)[]) {
            root.style.setProperty(THEME_VARS[key], colors[key])
        }
        if (user.scoped) {
            for (const key of Object.keys(SCOPED_VARS) as (keyof ScopedColors)[]) {
                const v = user.scoped[key]
                if (v) root.style.setProperty(SCOPED_VARS[key], v)
            }
        }
    } else {
        // Preset theme: clear inline overrides and let the [data-theme]
        // block in index.css take over.
        for (const key of Object.keys(THEME_VARS) as (keyof ThemeColors)[]) {
            root.style.removeProperty(THEME_VARS[key])
        }
        root.setAttribute('data-theme', id)
    }
}

// --- User themes ---

export function loadUserThemes(): UserTheme[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed as UserTheme[]
    } catch {
        return []
    }
}

export function saveUserThemes(themes: UserTheme[]) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(themes))
    syncKey(STORAGE_KEY)
}

export function createUserTheme(name: string, colors: ThemeColors, scoped?: ScopedColors): UserTheme {
    const theme: UserTheme = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        colors,
        ...(scoped ? { scoped } : {}),
    }
    const themes = loadUserThemes()
    themes.push(theme)
    saveUserThemes(themes)
    return theme
}

export function updateUserTheme(id: string, name: string, colors: ThemeColors, scoped?: ScopedColors) {
    const themes = loadUserThemes()
    const idx = themes.findIndex((t) => t.id === id)
    if (idx < 0) return
    themes[idx] = { ...themes[idx], name, colors, scoped }
    saveUserThemes(themes)
}

export function deleteUserTheme(id: string) {
    const themes = loadUserThemes().filter((t) => t.id !== id)
    saveUserThemes(themes)
    if (getActiveTheme() === id) setActiveTheme('legacy')
}

// --- Import / export ---

// encodeTheme serializes a UserTheme to a base64-encoded JSON string for
// sharing. The string is prefixed with `athena-theme:` so it can be
// recognized when pasted back into the import field.
export function encodeTheme(theme: UserTheme): string {
    const json = JSON.stringify(theme)
    return 'athena-theme:' + btoa(unescape(encodeURIComponent(json)))
}

export function decodeTheme(str: string): UserTheme | null {
    const trimmed = str.trim()
    if (!trimmed.startsWith('athena-theme:')) return null
    try {
        const b64 = trimmed.slice('athena-theme:'.length)
        const json = decodeURIComponent(escape(atob(b64)))
        const parsed = JSON.parse(json)
        if (
            typeof parsed.id === 'string' &&
            typeof parsed.name === 'string' &&
            parsed.colors &&
            typeof parsed.colors === 'object'
        ) {
            return parsed as UserTheme
        }
        return null
    } catch {
        return null
    }
}

// importTheme adds an imported theme to the user's local collection. The
// imported theme's id is regenerated to avoid collisions with existing
// user themes.
export function importTheme(theme: UserTheme): UserTheme {
    const imported: UserTheme = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: theme.name,
        colors: theme.colors,
    }
    const themes = loadUserThemes()
    themes.push(imported)
    saveUserThemes(themes)
    return imported
}

// --- Per-archive themes (advanced mode, 4.6) ---
//
// A client-local map of archive ID -> user-theme ID. When an archive with a
// mapping is selected, App wraps the feed in a scoped element that sets the
// theme's CSS variables inline, so only that region is re-themed. Only user
// themes (which carry explicit colours) can be assigned per-archive; presets
// are defined in CSS and cannot be resolved to a colour map here.

const ARCHIVE_THEMES_KEY = 'athena-archive-themes'

export function loadArchiveThemes(): Record<string, string> {
    try {
        const raw = localStorage.getItem(ARCHIVE_THEMES_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

export function getArchiveTheme(archiveId: string): string | undefined {
    return loadArchiveThemes()[archiveId]
}

export function setArchiveTheme(archiveId: string, themeId: string | null) {
    const map = loadArchiveThemes()
    if (themeId) map[archiveId] = themeId
    else delete map[archiveId]
    localStorage.setItem(ARCHIVE_THEMES_KEY, JSON.stringify(map))
    syncKey(ARCHIVE_THEMES_KEY)
}

// themeColorVars converts a colour map into inline CSS custom properties,
// suitable for a scoped wrapper's `style` prop.
export function themeColorVars(colors: ThemeColors): Record<string, string> {
    const legible = ensureLegible(colors)
    const out: Record<string, string> = {}
    for (const key of Object.keys(THEME_VARS) as (keyof ThemeColors)[]) {
        out[THEME_VARS[key]] = legible[key]
    }
    return out
}

// resolveUserThemeColors returns a user theme's colours by ID, or null if the
// ID is not a known user theme (e.g. it was deleted, or it is a preset).
export function resolveUserThemeColors(themeId: string): ThemeColors | null {
    const theme = loadUserThemes().find((x) => x.id === themeId)
    return theme ? theme.colors : null
}

// Converts a browser-serialized colour (getComputedStyle always resolves
// `color` to `rgb(...)`/`rgba(...)`, regardless of how the source value was
// authored) into the #rrggbb form <input type="color"> requires.
function rgbToHex(rgb: string): string {
    const nums = rgb.match(/\d+(\.\d+)?/g)
    if (!nums || nums.length < 3) return '#000000'
    return (
        '#' +
        nums
            .slice(0, 3)
            .map((n) => Math.round(Number(n)).toString(16).padStart(2, '0'))
            .join('')
    )
}

// getComputedStyle().getPropertyValue on a *custom* property returns its
// specified value verbatim. Several presets alias a theme var to a Tailwind
// colour token (e.g. `--theme-highlight: var(--color-cyan-500)`), so reading
// it directly would yield the literal string "var(--color-cyan-500)" rather
// than a colour. Assigning it to a real property on a probe element and
// reading that back resolves nested var()s to the browser's used value.
function resolveThemeVar(probe: HTMLElement, varName: string): string {
    probe.style.setProperty('color', `var(${varName})`)
    return rgbToHex(getComputedStyle(probe).color)
}

// defaultColors returns a starting palette for a new user theme, cloned
// from the current theme's (preset or custom) resolved values so the editor
// opens with sensible defaults instead of blank/black swatches.
export function defaultColors(): ThemeColors {
    const probe = document.createElement('span')
    document.documentElement.appendChild(probe)
    const get = (key: keyof ThemeColors) => resolveThemeVar(probe, THEME_VARS[key])
    const colors: ThemeColors = {
        bg: get('bg'),
        'element-matte': get('element-matte'),
        'element-accent': get('element-accent'),
        'element-lighter': get('element-lighter'),
        'text-main': get('text-main'),
        'text-sub': get('text-sub'),
        plain: get('plain'),
        highlight: get('highlight'),
        'highlight-alt': get('highlight-alt'),
        'md-heading': get('md-heading'),
        'md-strong': get('md-strong'),
    }
    probe.remove()
    return colors
}

// Client-local user preferences for the PWA. These are cosmetic/UX settings
// that never touch the server: they live in localStorage under a single key
// (`athena-prefs`) so a Reset clears them without disturbing custom themes
// (`athena-themes`) or the active theme selection (`athena-active-theme`).
//
// Reactivity: a module-level Solid signal backs the prefs so the settings
// panel and feed update live as prefs change. Applying `uiScale` scales the
// root font size, which cascades to every rem-based measurement (Tailwind).

import { createSignal } from 'solid-js'
import type { TagColorPreset } from './tagColors'
import { syncKey } from './appearance'

// Rich-menu widgets (§ desktop Menu revamp). Order in MENU_WIDGETS is the
// default display order; `label`/`blurb` drive the Widgets settings category.
export type MenuWidgetId = 'chat' | 'users' | 'pinned' | 'stats' | 'tags'

export interface MenuWidget {
    id: MenuWidgetId
    enabled: boolean
}

export const MENU_WIDGET_META: { id: MenuWidgetId; label: string; blurb: string }[] = [
    { id: 'chat', label: 'Chat', blurb: 'A docked conversation panel' },
    { id: 'users', label: 'Members', blurb: 'A roster of everyone in this library' },
    { id: 'pinned', label: 'Pinned moments', blurb: 'Quick links to pinned entries' },
    { id: 'stats', label: 'Quick stats', blurb: 'Totals, entries this week, streak' },
    { id: 'tags', label: 'Top tags', blurb: 'Most-used tags as filter shortcuts' },
]

// Default widget set: enough to fill the column without clutter. Tags are off
// by default (the feed already exposes tag filtering).
const DEFAULT_MENU_WIDGETS: MenuWidget[] = [
    { id: 'chat', enabled: true },
    { id: 'users', enabled: true },
    { id: 'pinned', enabled: true },
    { id: 'stats', enabled: true },
    { id: 'tags', enabled: false },
]

// How wide a module window is allowed to grow. One scale shared by every
// module rather than a number per surface: the point of the setting is "give
// me more room", and a person who wants that wants it in the same terms
// everywhere. `full` stops only at the backdrop's own padding.
export type ModalWidth = 'narrow' | 'medium' | 'large' | 'wide' | 'full'

export const MODAL_WIDTH_META: { id: ModalWidth; label: string }[] = [
    { id: 'narrow', label: 'Narrow' },
    { id: 'medium', label: 'Medium' },
    { id: 'large', label: 'Large' },
    { id: 'wide', label: 'Wide' },
    { id: 'full', label: 'Full' },
]

// Written out rather than built from the pref: Tailwind reads class names out
// of the source, so a computed `max-w-[${n}rem]` compiles to no CSS at all.
export const MODAL_WIDTH_CLASS: Record<ModalWidth, string> = {
    narrow: 'max-w-[56rem]',
    medium: 'max-w-[68rem]',
    large: 'max-w-[80rem]',
    wide: 'max-w-[96rem]',
    full: 'max-w-none',
}

// The same scale at the desktop breakpoint, for a window that fills a phone
// screen edge to edge and only takes a width once there is room for one. The
// prefix is written into each value for the same reason as above: `lg:` glued
// on at runtime is a class Tailwind never sees.
export const MODAL_WIDTH_CLASS_LG: Record<ModalWidth, string> = {
    narrow: 'lg:max-w-[56rem]',
    medium: 'lg:max-w-[68rem]',
    large: 'lg:max-w-[80rem]',
    wide: 'lg:max-w-[96rem]',
    full: 'lg:max-w-none',
}

export interface Prefs {
    // Root font-size multiplier (0.8 to 1.4). 1 = default 16px.
    uiScale: number
    // When filtering by tags, also visually highlight those tags inside
    // moment cards in the feed.
    highlightSelectedTags: boolean
    // Let a tag drawn on a moment be clicked to add or remove it from the
    // filter, the same as clicking it in the tag bar. On by default.
    clickableMomentTags: boolean
    // Named HSL band used when suggesting a colour for a new tag.
    tagColorPreset: TagColorPreset
    // Clock format for all rendered times (chat, audit log, moment timestamps).
    // 'system' follows the OS locale; '12h'/'24h' pin it. Default 12h.
    timeFormat: '12h' | '24h' | 'system'
    // Feed layout: a single vertical list, or a summarized grid.
    feedView: 'list' | 'grid'
    // Main-UI layout preset: the standard 3-column, or Focus (a single
    // centred writing column with the side panels in floating drawers).
    layout: 'standard' | 'focus'
    // Max width (px) of the Feed/moments column in the Standard layout, set by
    // dragging the divider or the Settings slider. Clamped on use.
    feedWidth: number
    // Libraries switcher placement, desktop multi-server only. Ignored in a
    // browser / single-server context. 'left-rail' is the full-height shelf
    // on the far left; the two 'inline-*' modes stack it in the Archives
    // column (above or below the archives list).
    librariesPlacement: 'inline-above' | 'inline-below' | 'left-rail'
    // Width of each module window. Defaults differ because the surfaces do:
    // a card is a document, a board wants columns, and a canvas wants as much
    // room as the window will give it.
    todoWidth: ModalWidth
    projectCardWidth: ModalWidth
    canvasWidth: ModalWidth
    // Show the app logo beside the "Athena" title in the top bar. The bold
    // title + version render regardless; this only toggles the icon.
    showTopbarLogo: boolean
    // Size the libraries shelf to its contents (ending just below the last
    // library) instead of always stretching to fill the column. On by
    // default; turn off to keep the shelf pinned to the column's full height.
    librariesCompact: boolean
    // Desktop Menu-column layout. 'minimal' = the compact card of nav buttons
    // + identity (the original). 'rich' = a full-height panel with a sticky nav
    // hub and a scrollable stack of reorderable, toggleable widgets (below).
    menuLayout: 'minimal' | 'rich'
    // Rich-menu widget configuration: display order + enabled state. Unknown
    // ids are dropped and newly-shipped widgets are appended (disabled) at load
    // so the list stays forward-compatible. Only consulted when menuLayout is
    // 'rich'.
    menuWidgets: MenuWidget[]
    // Docked chat widget (rich menu): off by default, showing a compact
    // read-only preview of the latest messages. Click it to open the full
    // chat. Opt in to dock the full panel + composer instead. Off by default
    // so the menu column stays uncluttered; only meaningful when the 'chat'
    // widget is enabled.
    chatWidgetFull: boolean
    // Show the per-task "Add a subtask…" inputs on the To-Do board. Off by
    // default because a row under every task reads as clutter; toggle it on to
    // add subtasks (existing subtasks always render regardless).
    showSubtaskAdders: boolean
    // Render a link's preview card in place of the link itself, splitting the
    // content around it, instead of stacking every card after the body. Off by
    // default so turning it on is the only thing that moves anyone's previews.
    // A URL that cannot be replaced without breaking syntax (a `[label](url)`
    // destination) still gets its card in the stack below.
    inlineLinkPreviews: boolean
    // How many inline cards may share one row when links sit back to back.
    // Clamped to 1 through 4 on load: past four the cards are narrower than
    // their own titles in a feed column.
    inlineLinkPreviewsPerRow: number
    // How many video players may share one row when videos are attached back
    // to back. 1 is the full-width player this has always been, so the default
    // leaves every existing moment looking exactly as it did.
    videosPerRow: number
    // Draw a schematic thumbnail of the board inside a canvas reference card,
    // instead of only its title and node count.
    canvasEmbedPreview: boolean
    // Render a moment reference the way the main column renders it, rather than
    // as a title and a flattened excerpt. Off by default: the compact card is
    // what ADR-0015 chose, and ADR-0017 records why this is opt-in.
    momentEmbedPreview: boolean
    // How tall such a preview may get, as a percentage of the window height,
    // before it is cut off behind a fade. Clamped to 10 through 100 on load.
    momentEmbedPreviewHeight: number
    // Drift the login page's bookcase watermark behind a surface. While a
    // surface's texture is on, its panels render solid (data-solid-surfaces,
    // index.css) so translucent looks don't let the shelves bleed through the
    // foreground. On everywhere by default, matching the login page.
    bookcaseMain: boolean
    bookcaseProjects: boolean
    // Open Projects as a large panel over the library instead of filling the
    // screen. On by default; turn it off to have the module fill the window.
    projectsWindowed: boolean
    // How a board card says it carries a note. 'preview' draws a two-line
    // flattened excerpt of the note under the card's title; 'label' says only
    // "Contains notes" in the card's meta row, for a column read as a list of
    // titles. Defaults to the excerpt: a column you can read without opening
    // anything is the reason the hint exists.
    projectCardNoteHint: 'preview' | 'label'
    // Draw the portfolio overview's agenda as a timeline of individual days
    // rather than as a list grouped into overdue/today/this week. On by
    // default: a run of days is easier to read a deadline off than a heading
    // is, because the gaps are visible as gaps.
    projectsAgendaTimeline: boolean
    // Which way that timeline runs. Horizontal by default, a column per day;
    // vertical stacks the days down the page for a narrow window.
    projectsAgendaVertical: boolean
    // --- Desktop-client (Electron) only; stored here but surfaced in the
    // desktop client's settings, not the PWA. Defaults are harmless in-web. ---
    font: string // '' = theme default serif
    animationsEnabled: boolean
    animationSpeed: number // multiplier, 0.5 (fast) to 2 (slow)
}

export const DEFAULT_PREFS: Prefs = {
    uiScale: 1,
    highlightSelectedTags: false,
    clickableMomentTags: true,
    tagColorPreset: 'vibrant',
    timeFormat: '12h',
    feedView: 'list',
    layout: 'standard',
    feedWidth: 896, // = Tailwind max-w-4xl (56rem)
    librariesPlacement: 'inline-above',
    showTopbarLogo: true,
    librariesCompact: true,
    menuLayout: 'rich',
    menuWidgets: DEFAULT_MENU_WIDGETS,
    chatWidgetFull: false,
    showSubtaskAdders: false,
    inlineLinkPreviews: false,
    inlineLinkPreviewsPerRow: 2,
    videosPerRow: 1,
    canvasEmbedPreview: false,
    momentEmbedPreview: false,
    momentEmbedPreviewHeight: 40,
    bookcaseMain: true,
    bookcaseProjects: true,
    projectsWindowed: true,
    projectCardNoteHint: 'preview',
    projectsAgendaTimeline: true,
    projectsAgendaVertical: false,
    todoWidth: 'large',
    projectCardWidth: 'medium',
    canvasWidth: 'wide',
    font: '',
    animationsEnabled: true,
    animationSpeed: 1,
}

const STORAGE_KEY = 'athena-prefs'

// Keys cleared by "Reset all settings". Everything under athena-prefs plus
// the keybindings, but NOT athena-themes / athena-active-theme.
const RESET_KEYS = [STORAGE_KEY, 'athena-keybinds']

// Reconcile a stored widget list with the shipped set: keep known ids in their
// saved order + enabled state, drop unknown ids, and append any newly-shipped
// widgets (disabled) so upgrades surface them without resetting the user's
// arrangement. Falls back to the default list if the stored value is unusable.
function normalizeMenuWidgets(stored: unknown): MenuWidget[] {
    if (!Array.isArray(stored)) return DEFAULT_MENU_WIDGETS.map((w) => ({ ...w }))
    const known = new Set(MENU_WIDGET_META.map((m) => m.id))
    const seen = new Set<MenuWidgetId>()
    const out: MenuWidget[] = []
    for (const w of stored) {
        if (w && known.has(w.id) && !seen.has(w.id)) {
            out.push({ id: w.id, enabled: !!w.enabled })
            seen.add(w.id)
        }
    }
    for (const m of MENU_WIDGET_META) {
        if (!seen.has(m.id)) out.push({ id: m.id, enabled: false })
    }
    return out
}

// Shared by every "how many of these sit side by side" pref. Four is the point
// where a feed column stops being able to give each one a useful width.
export const ROW_LIMITS = { min: 1, max: 4 } as const

function clampPerRow(value: unknown, fallback: number): number {
    const n = Math.round(Number(value))
    if (!Number.isFinite(n)) return fallback
    return Math.min(ROW_LIMITS.max, Math.max(ROW_LIMITS.min, n))
}

// Percent of the window height a moment preview may fill. The floor is where a
// preview stops showing enough to be worth the space; the ceiling is the whole
// window, at which point it is not truncated at all.
export const PREVIEW_HEIGHT_LIMITS = { min: 10, max: 100, step: 5 } as const

export function clampPreviewHeight(value: unknown): number {
    const n = Math.round(Number(value))
    if (!Number.isFinite(n)) return DEFAULT_PREFS.momentEmbedPreviewHeight
    return Math.min(PREVIEW_HEIGHT_LIMITS.max, Math.max(PREVIEW_HEIGHT_LIMITS.min, n))
}

function load(): Prefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return { ...DEFAULT_PREFS }
        const parsed = JSON.parse(raw)
        // Merge over defaults so a stored subset (older versions) stays valid.
        const merged = { ...DEFAULT_PREFS, ...parsed }
        // Guard the placement enum; unknown/retired values fall back to default.
        if (!['inline-above', 'inline-below', 'left-rail'].includes(merged.librariesPlacement)) {
            merged.librariesPlacement = DEFAULT_PREFS.librariesPlacement
        }
        if (!['minimal', 'rich'].includes(merged.menuLayout)) {
            merged.menuLayout = DEFAULT_PREFS.menuLayout
        }
        if (!['preview', 'label'].includes(merged.projectCardNoteHint)) {
            merged.projectCardNoteHint = DEFAULT_PREFS.projectCardNoteHint
        }
        merged.menuWidgets = normalizeMenuWidgets(merged.menuWidgets)
        merged.inlineLinkPreviewsPerRow = clampPerRow(
            merged.inlineLinkPreviewsPerRow,
            DEFAULT_PREFS.inlineLinkPreviewsPerRow,
        )
        merged.videosPerRow = clampPerRow(merged.videosPerRow, DEFAULT_PREFS.videosPerRow)
        merged.momentEmbedPreviewHeight = clampPreviewHeight(merged.momentEmbedPreviewHeight)
        return merged
    } catch {
        return { ...DEFAULT_PREFS }
    }
}

const [prefs, setPrefsSignal] = createSignal<Prefs>(load())

export { prefs }

// Re-read prefs from localStorage into the signal. Called after appearance
// hydration/reset (ADR-0016) rewrites the stored value out from under us.
export function reloadPrefs() {
    setPrefsSignal(load())
    applyPrefs()
}

function persist(p: Prefs) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
    syncKey(STORAGE_KEY)
}

// applyPrefs pushes prefs into the DOM. Call once at startup (before paint,
// like the theme) and again whenever a pref changes.
export function applyPrefs() {
    const current = prefs()
    document.documentElement.style.fontSize = `${Math.round(current.uiScale * 100)}%`
    document.documentElement.style.setProperty('--anim-speed', String(current.animationSpeed))
    document.documentElement.toggleAttribute('data-no-animations', !current.animationsEnabled)
    if (current.font) {
        document.documentElement.style.setProperty('--user-font', current.font)
    } else {
        document.documentElement.style.removeProperty('--user-font')
    }
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
    const next = { ...prefs(), [key]: value }
    setPrefsSignal(next)
    persist(next)
    applyPrefs()
}

export function resetPrefs() {
    for (const key of RESET_KEYS) localStorage.removeItem(key)
    setPrefsSignal({ ...DEFAULT_PREFS })
    applyPrefs()
}

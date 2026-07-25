import { describe, it, expect, beforeEach } from 'vitest'
import {
    type ThemeColors,
    type UserTheme,
    encodeTheme,
    decodeTheme,
    createUserTheme,
    loadUserThemes,
    updateUserTheme,
    deleteUserTheme,
    importTheme,
    getActiveTheme,
    setActiveTheme,
    applyTheme,
    PRESET_THEMES,
} from './themes'

const sampleColors: ThemeColors = {
    bg: '#101010',
    'element-matte': '#202020',
    'element-accent': '#303030',
    'element-lighter': '#404040',
    'text-main': '#f0f0f0',
    'text-sub': '#a0a0a0',
    plain: '#ffffff',
    highlight: '#ff00ff',
    'highlight-alt': '#00ffff',
    'md-heading': '#ffcc00',
    'md-strong': '#ff8800',
}

beforeEach(() => {
    localStorage.clear()
})

describe('encode/decode round trip', () => {
    it('round-trips a theme through the shareable string', () => {
        const theme: UserTheme = { id: 'user-1', name: 'Neon', colors: sampleColors }
        const encoded = encodeTheme(theme)
        expect(encoded.startsWith('athena-theme:')).toBe(true)

        const decoded = decodeTheme(encoded)
        expect(decoded).not.toBeNull()
        expect(decoded!.name).toBe('Neon')
        expect(decoded!.colors).toEqual(sampleColors)
    })

    it('rejects strings without the athena-theme prefix', () => {
        expect(decodeTheme('not a theme')).toBeNull()
        expect(decodeTheme('')).toBeNull()
    })

    it('rejects malformed base64 / json', () => {
        expect(decodeTheme('athena-theme:@@@not-base64@@@')).toBeNull()
        expect(decodeTheme('athena-theme:' + btoa('{"nope":true}'))).toBeNull()
    })
})

describe('user theme persistence', () => {
    it('creates and loads user themes from localStorage', () => {
        expect(loadUserThemes()).toHaveLength(0)
        const created = createUserTheme('Mine', sampleColors)
        const loaded = loadUserThemes()
        expect(loaded).toHaveLength(1)
        expect(loaded[0].id).toBe(created.id)
        expect(loaded[0].name).toBe('Mine')
    })

    it('updates an existing theme', () => {
        const created = createUserTheme('Old', sampleColors)
        updateUserTheme(created.id, 'New', { ...sampleColors, bg: '#000000' })
        const loaded = loadUserThemes()
        expect(loaded[0].name).toBe('New')
        expect(loaded[0].colors.bg).toBe('#000000')
    })

    it('deletes a theme and resets the active theme if it was active', () => {
        const created = createUserTheme('Doomed', sampleColors)
        setActiveTheme(created.id)
        expect(getActiveTheme()).toBe(created.id)

        deleteUserTheme(created.id)
        expect(loadUserThemes()).toHaveLength(0)
        expect(getActiveTheme()).toBe('legacy')
    })

    it('regenerates the id when importing to avoid collisions', () => {
        const original: UserTheme = { id: 'user-1', name: 'Shared', colors: sampleColors }
        const imported = importTheme(original)
        expect(imported.id).not.toBe('user-1')
        expect(imported.name).toBe('Shared')
        expect(loadUserThemes()).toHaveLength(1)
    })

    it('returns an empty list when storage is corrupt', () => {
        localStorage.setItem('athena-themes', 'not json')
        expect(loadUserThemes()).toEqual([])
    })
})

describe('applyTheme', () => {
    it('sets data-theme for a preset theme', () => {
        applyTheme('ocean')
        expect(document.documentElement.getAttribute('data-theme')).toBe('ocean')
        expect(PRESET_THEMES).toContain('ocean')
    })

    it('applies inline CSS variables for a user theme', () => {
        const created = createUserTheme('Inline', sampleColors)
        applyTheme(created.id)
        const root = document.documentElement
        expect(root.style.getPropertyValue('--theme-bg')).toBe('#101010')
        expect(root.style.getPropertyValue('--theme-highlight')).toBe('#ff00ff')
    })
})

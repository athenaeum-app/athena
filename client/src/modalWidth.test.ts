import { describe, it, expect } from 'vitest'
import { MODAL_WIDTH_META, MODAL_WIDTH_CLASS, MODAL_WIDTH_CLASS_LG, DEFAULT_PREFS } from './prefs'

// Tailwind reads class names out of the source text, so these maps only work
// while every value is a literal that appears here as written. A class built
// at runtime compiles to no CSS and the window silently takes no width at all,
// which is why the sizes are spelled out rather than generated.

describe('modal width scale', () => {
    it('has a class for every step the settings panel offers', () => {
        for (const step of MODAL_WIDTH_META) {
            expect(MODAL_WIDTH_CLASS[step.id]).toBeTruthy()
            expect(MODAL_WIDTH_CLASS_LG[step.id]).toBeTruthy()
        }
        expect(Object.keys(MODAL_WIDTH_CLASS)).toHaveLength(MODAL_WIDTH_META.length)
        expect(Object.keys(MODAL_WIDTH_CLASS_LG)).toHaveLength(MODAL_WIDTH_META.length)
    })

    it('spells every class out as a literal Tailwind can find', () => {
        for (const value of Object.values(MODAL_WIDTH_CLASS)) {
            expect(value).toMatch(/^max-w-(\[\d+rem\]|none)$/)
        }
    })

    it('is the same scale at the desktop breakpoint, only prefixed', () => {
        for (const step of MODAL_WIDTH_META) {
            expect(MODAL_WIDTH_CLASS_LG[step.id]).toBe(`lg:${MODAL_WIDTH_CLASS[step.id]}`)
        }
    })

    it('orders the steps from narrowest to widest', () => {
        const rem = (id: (typeof MODAL_WIDTH_META)[number]['id']) => {
            const match = MODAL_WIDTH_CLASS[id].match(/\[(\d+)rem\]/)
            return match ? parseInt(match[1], 10) : Infinity
        }
        const widths = MODAL_WIDTH_META.map((s) => rem(s.id))
        expect(widths).toEqual([...widths].sort((a, b) => a - b))
    })

    it('ships each window at the size that suits it', () => {
        // A canvas is pan-and-zoom and wants the room; a card is a document.
        expect(rank(DEFAULT_PREFS.canvasWidth)).toBeGreaterThan(rank(DEFAULT_PREFS.todoWidth))
        expect(rank(DEFAULT_PREFS.todoWidth)).toBeGreaterThan(rank(DEFAULT_PREFS.projectCardWidth))
    })
})

const rank = (id: (typeof MODAL_WIDTH_META)[number]['id']) => MODAL_WIDTH_META.findIndex((s) => s.id === id)

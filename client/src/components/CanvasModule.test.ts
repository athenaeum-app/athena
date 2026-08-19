import { describe, expect, it } from 'vitest'
import { MAX_NODE_TEXT, readableInk } from './CanvasModule'

// Text nodes pick their colour off the palette at random now, so nothing stops
// a note landing on the dark end of it. The ink has to follow the fill or the
// note is unreadable on arrival, which a fixed dark ink made it.
describe('readableInk', () => {
    it('puts dark ink on the light half of the node palette', () => {
        for (const light of ['#f6e58d', '#ffbe76', '#badc58', '#7ed6df', '#dff9fb', '#dfe6e9', '#95a5a6', '#ff7979']) {
            expect(readableInk(light)).toBe('#1c1c1c')
        }
    })

    it('puts light ink on the dark half of the node palette', () => {
        for (const dark of ['#2d3436', '#e056fd', '#000000', '#4a148c']) {
            expect(readableInk(dark)).toBe('#f4f4f4')
        }
    })

    it('reads a colour with or without its hash, and either case', () => {
        expect(readableInk('2D3436')).toBe(readableInk('#2d3436'))
        expect(readableInk('  #F6E58D  ')).toBe(readableInk('#f6e58d'))
    })

    it('falls back to dark ink for anything it cannot read', () => {
        // Styles are user-editable JSON, so the colour is not guaranteed to be
        // a hex triplet at all; the old fixed ink is the safe answer.
        for (const junk of ['', 'rebeccapurple', '#abc', 'var(--theme-bg)']) {
            expect(readableInk(junk)).toBe('#1c1c1c')
        }
    })
})

describe('MAX_NODE_TEXT', () => {
    // The cap is the whole of the "a node is a card, not a document" rule, and
    // it is enforced in two places (the textarea's maxlength and the save), so
    // it being one number matters more than its exact value.
    it('is the 4000 characters the editor and the save both cap at', () => {
        expect(MAX_NODE_TEXT).toBe(4000)
    })
})

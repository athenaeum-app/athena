import { describe, it, expect } from 'vitest'
import { boardBounds } from './CanvasThumbnail'
import type { CanvasNode } from '../api'

const node = (x: number, y: number, w = 100, h = 80): CanvasNode => ({
    id: `${x}-${y}`,
    canvas_id: 'c',
    kind: 'sticky',
    x,
    y,
    w,
    h,
    z_order: 0,
    content: '',
    created_at: '',
    updated_at: '',
})

// The box the thumbnail's viewBox is built from. Getting it wrong shows either
// an empty picture or a board floating off in a corner, so it is worth pinning
// down away from the SVG.
describe('boardBounds', () => {
    it('has nothing to draw for an empty board', () => {
        expect(boardBounds([])).toBeNull()
    })

    it('covers a single node exactly', () => {
        expect(boardBounds([node(10, 20)])).toEqual({ x: 10, y: 20, w: 100, h: 80 })
    })

    it('spans from the leftmost/topmost edge to the furthest opposite edge', () => {
        expect(boardBounds([node(0, 0), node(300, 200)])).toEqual({ x: 0, y: 0, w: 400, h: 280 })
    })

    it('follows nodes into negative space, which the board allows', () => {
        expect(boardBounds([node(-500, -400), node(0, 0)])).toEqual({ x: -500, y: -400, w: 600, h: 480 })
    })

    it('is not decided by node order', () => {
        const scattered = [node(300, 200), node(-500, -400), node(0, 0)]
        expect(boardBounds(scattered)).toEqual(boardBounds([...scattered].reverse()))
    })

    it('keeps an extent for a zero-sized node, which would otherwise draw nothing', () => {
        expect(boardBounds([node(5, 5, 0, 0)])).toEqual({ x: 5, y: 5, w: 1, h: 1 })
    })
})

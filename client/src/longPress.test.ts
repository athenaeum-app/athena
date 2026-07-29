import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLongPress } from './longPress'

// jsdom has no PointerEvent, and nothing here reads a pointer-only field.
const pointer = (type: string, x = 0, y = 0) =>
    new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }) as unknown as PointerEvent

const press = (lp: ReturnType<typeof createLongPress>, x = 100, y = 100) =>
    lp.handlers.onPointerDown(pointer('pointerdown', x, y))

describe('createLongPress', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('fires after the hold when the pointer stays put', () => {
        const handler = vi.fn()
        press(createLongPress(handler))
        vi.advanceTimersByTime(500)
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('ignores secondary mouse buttons', () => {
        const handler = vi.fn()
        const lp = createLongPress(handler)
        lp.handlers.onPointerDown(
            new MouseEvent('pointerdown', { clientX: 0, clientY: 0, button: 2 }) as unknown as PointerEvent,
        )
        vi.advanceTimersByTime(500)
        expect(handler).not.toHaveBeenCalled()
    })

    it('survives a wobble inside the tolerance', () => {
        const handler = vi.fn()
        press(createLongPress(handler))
        window.dispatchEvent(pointer('pointermove', 104, 103))
        vi.advanceTimersByTime(500)
        expect(handler).toHaveBeenCalledTimes(1)
    })

    // The scrollbar bug. Moves only reach the pressed element while the pointer
    // is still over it, so a drag that leaves it used to go unnoticed and the
    // hold fired anyway: aim for the chat scrollbar, land on the message beside
    // it, drag, and an action sheet opened over the page.
    it('is cancelled by a drag that never touches the pressed element again', () => {
        const handler = vi.fn()
        press(createLongPress(handler))
        window.dispatchEvent(pointer('pointermove', 100, 400))
        vi.advanceTimersByTime(500)
        expect(handler).not.toHaveBeenCalled()
    })

    it('is cancelled by a release anywhere', () => {
        const handler = vi.fn()
        press(createLongPress(handler))
        window.dispatchEvent(pointer('pointerup', 900, 900))
        vi.advanceTimersByTime(500)
        expect(handler).not.toHaveBeenCalled()
    })

    it('is cancelled by content scrolling under the pointer', () => {
        const handler = vi.fn()
        press(createLongPress(handler))
        // Dispatched on an element, as a real scroll is: the listener is
        // capturing, and scroll does not bubble.
        document.body.dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(500)
        expect(handler).not.toHaveBeenCalled()
    })

    it('stops listening once it has fired, so a later gesture cannot re-enter it', () => {
        const handler = vi.fn()
        const lp = createLongPress(handler)
        press(lp)
        vi.advanceTimersByTime(500)
        expect(lp.consumed()).toBe(true)

        window.dispatchEvent(pointer('pointermove', 900, 900))
        window.dispatchEvent(pointer('pointerup', 900, 900))
        vi.advanceTimersByTime(500)
        expect(handler).toHaveBeenCalledTimes(1)
        expect(lp.consumed()).toBe(true)
    })

    it('starts clean on the next press', () => {
        const handler = vi.fn()
        const lp = createLongPress(handler)
        press(lp)
        vi.advanceTimersByTime(500)

        press(lp)
        expect(lp.consumed()).toBe(false)
        window.dispatchEvent(pointer('pointermove', 100, 400))
        vi.advanceTimersByTime(500)
        expect(handler).toHaveBeenCalledTimes(1)
    })
})

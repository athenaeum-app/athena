import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { copyText } from './clipboard'

// The fallback is the whole point of this module, and the context that needs it
// (Athena over plain http on a LAN) is the one a test runner never runs in:
// localhost is a secure context, so navigator.clipboard is always there. Both
// halves are therefore driven by hand.

const setClipboard = (value: unknown) =>
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true })

let execCommand: ReturnType<typeof vi.fn>

beforeEach(() => {
    execCommand = vi.fn(() => true)
    // jsdom has no execCommand at all, so there is nothing to spy on.
    ;(document as unknown as { execCommand: unknown }).execCommand = execCommand
})

afterEach(() => {
    setClipboard(undefined)
    vi.restoreAllMocks()
})

describe('copyText', () => {
    it('uses the async clipboard when the page is allowed one', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        setClipboard({ writeText })

        expect(await copyText('the words')).toBe(true)
        expect(writeText).toHaveBeenCalledWith('the words')
        expect(execCommand).not.toHaveBeenCalled()
    })

    it('falls back when there is no clipboard object at all', async () => {
        // http on a LAN address: not refused, absent. Reading .writeText off it
        // is what used to throw a TypeError past every .catch() in the app.
        setClipboard(undefined)

        expect(await copyText('the words')).toBe(true)
        expect(execCommand).toHaveBeenCalledWith('copy')
    })

    it('falls back when the async clipboard is there and refuses', async () => {
        setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })

        expect(await copyText('the words')).toBe(true)
        expect(execCommand).toHaveBeenCalledWith('copy')
    })

    it('says so when neither way works, rather than reporting a copy that did not happen', async () => {
        setClipboard(undefined)
        execCommand.mockReturnValue(false)

        expect(await copyText('the words')).toBe(false)
    })

    it('leaves nothing of its own behind in the document', async () => {
        setClipboard(undefined)
        const before = document.body.childElementCount

        await copyText('the words')

        expect(document.body.childElementCount).toBe(before)
        expect(document.querySelector('textarea')).toBeNull()
    })

    it('hands the text over intact, newlines and tokens and all', async () => {
        let copied = ''
        setClipboard(undefined)
        execCommand.mockImplementation(() => {
            copied = (document.querySelector('textarea') as HTMLTextAreaElement).value
            return true
        })

        await copyText('one\ntwo ::todo:abc123::')

        expect(copied).toBe('one\ntwo ::todo:abc123::')
    })
})

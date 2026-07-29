import { describe, it, expect } from 'vitest'
import { looksLikeVideo, planVideoSlots } from './AttachmentList'

// Whether an attachment renders as a player or a download chip. The recorded
// MIME type decides it when there is one, and the file name is the fallback for
// rows written before the server stopped depending on the host's MIME database.
describe('looksLikeVideo', () => {
    it('trusts a video MIME type', () => {
        expect(looksLikeVideo('video/mp4', 'clip.mp4')).toBe(true)
        expect(looksLikeVideo('video/quicktime', 'anything')).toBe(true)
    })

    it('falls back to the file name when the type is unknown', () => {
        // What a .mov uploaded before the server-side fix looks like.
        expect(looksLikeVideo('application/octet-stream', 'holiday.mov')).toBe(true)
        expect(looksLikeVideo('', 'holiday.mkv')).toBe(true)
        expect(looksLikeVideo('application/octet-stream', 'SHOUTING.MOV')).toBe(true)
    })

    it('does not second-guess a type that is not a video', () => {
        // A .mov extension on something the server positively identified as a
        // PDF is a mislabelled file, not a video, so believe the type.
        expect(looksLikeVideo('application/pdf', 'weird.mov')).toBe(false)
        expect(looksLikeVideo('audio/mpeg', 'song.mp3')).toBe(false)
        expect(looksLikeVideo('image/png', 'shot.png')).toBe(false)
    })

    it('leaves genuinely unknown files alone', () => {
        expect(looksLikeVideo('application/octet-stream', 'archive.zip')).toBe(false)
        expect(looksLikeVideo('application/octet-stream', 'no-extension')).toBe(false)
        // A name that merely mentions a video extension mid-string is not one.
        expect(looksLikeVideo('application/octet-stream', 'notes.mov.txt')).toBe(false)
    })
})

// How many players share a row, once the user has raised the limit above one.
// Read the expectations as widths: `perRow` 1 is a full-width player.
describe('planVideoSlots', () => {
    const widths = (isVideo: boolean[], limit: number) => planVideoSlots(isVideo, limit).map((s) => s.perRow)

    it('leaves everything full width at a limit of one', () => {
        expect(widths([true, true, true], 1)).toEqual([1, 1, 1])
    })

    it('pairs videos that were attached back to back', () => {
        expect(widths([true, true], 2)).toEqual([2, 2])
        expect(widths([true, true, true, true], 2)).toEqual([2, 2, 2, 2])
    })

    it('widens a lone leftover instead of leaving a stub', () => {
        expect(widths([true, true, true], 2)).toEqual([2, 2, 1])
        expect(widths([true, true, true, true], 3)).toEqual([3, 3, 3, 1])
    })

    it('keeps a short last row that is not down to one', () => {
        // Five at three across: three, then a pair. Both of the pair grow to
        // half, which is what flex-basis does with two items on a line.
        expect(widths([true, true, true, true, true], 3)).toEqual([3, 3, 3, 3, 3])
    })

    it('never asks for more than the run holds', () => {
        expect(widths([true, true], 4)).toEqual([2, 2])
        expect(widths([true], 4)).toEqual([1])
    })

    it('does not group across a non-video, and never reorders to fill a row', () => {
        // Clip, PDF, clip: the PDF breaks the run, so neither clip has anyone
        // to share with.
        expect(widths([true, false, true], 2)).toEqual([1, 1, 1])
        // Two runs of two, with a file between them, stay two separate rows.
        expect(widths([true, true, false, true, true], 2)).toEqual([2, 2, 1, 2, 2])
    })

    it('marks the tiles, and only the tiles', () => {
        expect(planVideoSlots([true, true, true], 2).map((s) => s.tile)).toEqual([true, true, false])
        expect(planVideoSlots([false, true], 2).map((s) => s.tile)).toEqual([false, false])
    })
})

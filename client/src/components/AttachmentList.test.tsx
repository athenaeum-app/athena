import { describe, it, expect } from 'vitest'
import { looksLikeVideo } from './AttachmentList'

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

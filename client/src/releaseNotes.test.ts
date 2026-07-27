import { describe, it, expect } from 'vitest'
import { notesFor } from './releaseNotes'

const NOTES = {
    '2.8.0': ['Something changed.'],
    '2.9.0': ['Something else changed.'],
}

describe('notesFor', () => {
    it('shows the new version notes after an update', () => {
        expect(notesFor('2.8.0', '2.7.6', NOTES)).toEqual(['Something changed.'])
    })

    it('says nothing when the build has not moved', () => {
        expect(notesFor('2.8.0', '2.8.0', NOTES)).toBeNull()
    })

    it('says nothing to a browser that has never run Athena', () => {
        // A first-time user was not here for the release being described, so
        // the changelog is noise rather than an explanation.
        expect(notesFor('2.8.0', null, NOTES)).toBeNull()
    })

    it('says nothing for a version with no entry written', () => {
        // Entries are optional by design: a chore release explains itself by
        // having nothing to explain.
        expect(notesFor('2.8.1', '2.8.0', NOTES)).toBeNull()
    })

    it('shows the arrival version, not every version skipped along the way', () => {
        // Someone who was away for 2.8.0 and comes back on 2.9.0 gets the notes
        // for what they are now running.
        expect(notesFor('2.9.0', '2.7.6', NOTES)).toEqual(['Something else changed.'])
    })

    it('still explains itself after a downgrade', () => {
        // A rollback is a build change the reader did not ask for either, and
        // the notice exists to account for the refresh, not to celebrate news.
        expect(notesFor('2.8.0', '2.9.0', NOTES)).toEqual(['Something changed.'])
    })
})

import { describe, it, expect } from 'vitest'
import { compareVersions, notesFor, releaseHistory } from './releaseNotes'

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

describe('compareVersions', () => {
    it('orders by numeric part, not by character', () => {
        // The case a plain string sort gets backwards, and the reason this
        // function exists at all.
        expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0)
        expect(compareVersions('2.9.0', '2.10.0')).toBeLessThan(0)
    })

    it('compares major before minor before patch', () => {
        expect(compareVersions('3.0.0', '2.99.99')).toBeGreaterThan(0)
        expect(compareVersions('2.10.1', '2.10.0')).toBeGreaterThan(0)
    })

    it('treats equal versions as equal', () => {
        expect(compareVersions('2.10.1', '2.10.1')).toBe(0)
    })

    it('treats a missing component as zero', () => {
        expect(compareVersions('2.10', '2.10.0')).toBe(0)
        expect(compareVersions('2.10', '2.10.1')).toBeLessThan(0)
    })
})

describe('releaseHistory', () => {
    const MANY = {
        '2.8.0': ['Eight.'],
        '2.9.0': ['Nine.'],
        '2.10.0': ['Ten.'],
        '2.10.1': ['Ten one.'],
    }

    it('lists older releases newest first', () => {
        expect(releaseHistory('2.10.1', MANY).map((r) => r.version)).toEqual([
            '2.10.0',
            '2.9.0',
            '2.8.0',
        ])
    })

    it('leaves the running version out, since it is shown on its own', () => {
        expect(releaseHistory('2.10.1', MANY).some((r) => r.version === '2.10.1')).toBe(false)
    })

    it('never lists a release newer than the one running', () => {
        // The table ships inside the build, so this should not arise; if it
        // ever does, "earlier releases" must not start listing the future.
        expect(releaseHistory('2.9.0', MANY).map((r) => r.version)).toEqual(['2.8.0'])
    })

    it('leads with the last written entry when this build has none of its own', () => {
        // A chore release explains itself by having nothing to explain, and
        // the reader still wants the last thing they were told.
        expect(releaseHistory('2.10.2', MANY)[0]).toEqual({ version: '2.10.1', notes: ['Ten one.'] })
    })

    it('carries each release its own notes', () => {
        expect(releaseHistory('2.10.0', MANY)).toEqual([
            { version: '2.9.0', notes: ['Nine.'] },
            { version: '2.8.0', notes: ['Eight.'] },
        ])
    })

    it('is empty for the oldest release on record', () => {
        expect(releaseHistory('2.8.0', MANY)).toEqual([])
    })
})

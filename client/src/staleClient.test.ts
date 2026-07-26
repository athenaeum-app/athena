import { describe, it, expect } from 'vitest'
import { shouldReload } from './staleClient'

describe('shouldReload', () => {
    it('reloads when the server has moved on', () => {
        expect(shouldReload('v2.5.0', '2.4.3', null)).toBe(true)
    })

    it('treats a tag and a package version as the same build', () => {
        expect(shouldReload('v2.4.3', '2.4.3', null)).toBe(false)
        expect(shouldReload('2.4.3', '2.4.3', null)).toBe(false)
        expect(shouldReload(' v2.4.3 ', '2.4.3', null)).toBe(false)
    })

    it('never fires against a development server', () => {
        // Built without ldflags, which is every local build. A mismatch there
        // is the normal state, not a stale client.
        expect(shouldReload('dev', '2.4.3', null)).toBe(false)
        expect(shouldReload('', '2.4.3', null)).toBe(false)
    })

    it('does not try the same server version twice', () => {
        // The guard against a boot loop: if the reload did not change what the
        // client reports, trying again on the next tick is the loop.
        expect(shouldReload('v2.5.0', '2.4.3', '2.5.0')).toBe(false)
    })

    it('tries again once the server moves past the version that failed', () => {
        expect(shouldReload('v2.5.1', '2.4.3', '2.5.0')).toBe(true)
    })

    it('reloads when the client is ahead, which is still a mismatch', () => {
        // A rollback leaves the cached client newer than the server it talks
        // to, and the two disagreeing is the problem, not which way round.
        expect(shouldReload('v2.4.0', '2.4.3', null)).toBe(true)
    })
})

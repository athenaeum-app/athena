import { describe, it, expect } from 'vitest'
import { APIError } from './api'
import { isTransportError } from './reachability'

// The whole classification rests on one fact: request() constructs APIError
// only after an HTTP response arrived. So APIError of any status, including
// the ones that mean "go log in", proves a server was there to say so.
describe('isTransportError', () => {
    it('a 401 is the server answering, not the server missing', () => {
        expect(isTransportError(new APIError(401, 'unauthorized'))).toBe(false)
    })

    it('a 500 is still an answer', () => {
        expect(isTransportError(new APIError(500, 'boom'))).toBe(false)
    })

    it('what fetch throws when nothing is listening is transport', () => {
        // Chromium: "TypeError: Failed to fetch". The message is browser
        // prose and must not be part of the contract; the type check is.
        expect(isTransportError(new TypeError('Failed to fetch'))).toBe(true)
    })

    it('an aborted request is transport, not an answer', () => {
        expect(isTransportError(new DOMException('aborted', 'AbortError'))).toBe(true)
    })
})

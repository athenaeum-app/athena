import { createSignal } from 'solid-js'
import { APIError } from './api'

// Telling "the server said no" apart from "there was no server".
//
// request() in api.ts throws APIError only after an HTTP response arrived, so
// an APIError of any status, 401 included, proves the server is reachable.
// Everything else out of fetch is transport: connection refused, DNS, the
// machine being offline. The two used to be conflated into one nullable user,
// which is how a stopped container ended up rendering a login form that could
// only ever answer "Failed to fetch".
export const isTransportError = (err: unknown): boolean => !(err instanceof APIError)

// Whether the session check (or a login attempt) failed to reach the server at
// all. Module-level, like desktop.ts's shellRailOpen, so the pre-auth pages
// can set it and the root gate in index.tsx can read it without threading it
// through the auth context. Deliberately NOT set by mid-session failures: a
// flaky moment must degrade to a banner, never to a screen swap that unmounts
// a composer holding unsaved text (the precedent staleClient.ts set).
const [serverUnreachable, setServerUnreachable] = createSignal(false)
export { serverUnreachable, setServerUnreachable }

import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@solidjs/testing-library'

// jsdom implements no layout, so it ships no scrollIntoView. Any list that
// keeps its highlight in view (the tag suggestions, the embed pickers) calls it
// from a reactive effect, where the resulting TypeError escapes into Solid's
// update loop and abandons the render half-done.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

// Unmount any components and reset localStorage between tests so state does
// not leak across cases.
afterEach(() => {
    cleanup()
    localStorage.clear()
})

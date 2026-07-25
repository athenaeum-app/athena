import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@solidjs/testing-library'

// Unmount any components and reset localStorage between tests so state does
// not leak across cases.
afterEach(() => {
    cleanup()
    localStorage.clear()
})

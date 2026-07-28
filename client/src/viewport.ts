import { createSignal } from 'solid-js'

// The window's width, as a signal, with one listener for everything that cares
// rather than one per component. The default only matters where there is no
// window at all, which is unit tests.
const [viewportWidth, setViewportWidth] = createSignal(
    typeof window === 'undefined' ? 1440 : window.innerWidth,
)

if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => setViewportWidth(window.innerWidth))
}

export { viewportWidth }

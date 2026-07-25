import { createSignal, onCleanup, onMount } from 'solid-js'

// Reactive match for Tailwind's `lg` breakpoint (64rem / 1024px). Below it we
// render the mobile app-shell (bottom nav + swiper + sheets); at or above it the
// desktop 3-column / focus layouts. Extracted so App and Feed agree on the exact
// same boundary and switch together on resize / rotation.
export function useIsDesktop() {
    // Seed synchronously from the current viewport so desktop doesn't flash the
    // mobile shell for a frame on load (this SPA always runs in the browser).
    const initial = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
    const [isDesktop, setIsDesktop] = createSignal(initial)
    onMount(() => {
        const mediaQuery = window.matchMedia('(min-width: 1024px)')
        setIsDesktop(mediaQuery.matches)
        const onChange = () => setIsDesktop(mediaQuery.matches)
        mediaQuery.addEventListener('change', onChange)
        onCleanup(() => mediaQuery.removeEventListener('change', onChange))
    })
    return isDesktop
}

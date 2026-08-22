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

// Whether the primary pointer can start a drag. Permission and capability are
// different questions and the planner used to ask only the first, so a phone
// was told to drag a task onto a day (issue #87). HTML5 drag and drop is a
// mouse gesture: no dragstart fires for a finger, whatever the element says.
//
// Asked of the pointer rather than the width, because the two disagree in both
// directions: a narrow window still has a mouse, and a tablet at 1024px still
// has none. A laptop with a touchscreen reports its mouse as the primary
// pointer and is answered yes, which is right.
export function useCanDrag() {
    const query = '(pointer: fine)'
    // A browser too old to answer is told yes, leaving the hints as they were
    // rather than hiding a gesture that probably works.
    const initial = typeof window === 'undefined' || !window.matchMedia || window.matchMedia(query).matches
    const [canDrag, setCanDrag] = createSignal(initial)
    onMount(() => {
        if (!window.matchMedia) return
        const mediaQuery = window.matchMedia(query)
        setCanDrag(mediaQuery.matches)
        const onChange = () => setCanDrag(mediaQuery.matches)
        mediaQuery.addEventListener('change', onChange)
        onCleanup(() => mediaQuery.removeEventListener('change', onChange))
    })
    return canDrag
}

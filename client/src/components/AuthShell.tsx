import { createSignal, type Component, type JSX } from 'solid-js'
import { BookcaseDrift } from './BookcaseDrift'

// AuthShell is the shared chrome for every unauthenticated entry surface
// (setup / login / register). It owns the three things those pages must all
// have in common so they read as one product: the frameless-window drag bar
// up top, the drifting bookcase watermark behind the content (BookcaseDrift,
// shared with the Projects module), and a centered slot for the page's card.
// Extracted from Setup.tsx (which was the only page that had this treatment)
// so login/register stop looking like a different app.

export const AuthShell: Component<{ children: JSX.Element }> = (props) => {
    const [motionEnabled, setMotionEnabled] = createSignal(true)

    return (
        <div class="bg-background relative isolate flex min-h-screen flex-col overflow-hidden">
            {/* Page-level texture: a sparse, low-opacity tiling of book spines,
                instead of the card itself carrying decoration. Drifts slowly;
                motionEnabled lets users kill the motion. */}
            <BookcaseDrift animate={motionEnabled()} class="opacity-[0.09]" />

            {/* Topbar: solid bg-background (not the translucent bg-element) so it
                pixel-matches Electron's titleBarOverlay.color exactly, extended
                full-width so it reads as one continuous bar with the OS's
                minimize/maximize/close controls instead of a hard edge butting
                up against them. No bottom border: it shares bg-background with
                the page, so it melts into the surface rather than drawing a hard
                line across it. Also the frameless-window drag handle. */}
            <div class="app-drag-region bg-background relative z-10 h-9 w-full shrink-0" />

            {/* Sits below the topbar (and the native window controls, which
                occupy the same top strip) so it's never covered. */}
            <button
                type="button"
                onClick={() => setMotionEnabled((v) => !v)}
                title={motionEnabled() ? 'Pause background motion' : 'Resume background motion'}
                aria-label={motionEnabled() ? 'Pause background motion' : 'Resume background motion'}
                class="border-element-accent bg-element-matte/70 text-sub hover:text-main fixed top-12 right-4 z-10 flex h-9 w-9 items-center justify-center border backdrop-blur-sm"
            >
                <span class="material-symbols-outlined text-lg">
                    {motionEnabled() ? 'pause' : 'play_arrow'}
                </span>
            </button>

            <div class="relative z-10 flex flex-1 items-center justify-center p-4">
                {props.children}
            </div>
        </div>
    )
}

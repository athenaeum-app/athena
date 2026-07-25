import { createSignal, type Component, type JSX } from 'solid-js'

// AuthShell is the shared chrome for every unauthenticated entry surface
// (setup / login / register). It owns the three things those pages must all
// have in common so they read as one product: the frameless-window drag bar
// up top, the drifting bookcase watermark behind the content, and a centered
// slot for the page's card. Extracted from Setup.tsx (which was the only page
// that had this treatment) so login/register stop looking like a different app.

// --- Bookcase watermark ------------------------------------------------
// A seamless, square-ish tile drawing a bookcase carcass: full-height
// uprights + full-width shelf boards forming a 2x3 grid of compartments, each
// packed with its own run of book spines. The uprights sit ON the tile's left
// edge and midline and the boards span the full width, so every tile seam
// falls *inside* a piece of the furniture - which makes the repeat invisible
// (the trick a plain strip of spines can't do). Each compact spine is a stored
// "memory"; tonal variation plus the odd leaning book and flat-stacked pair
// keep it feeling like a real, used library rather than a diagram. Fully
// deterministic (no Math.random) so it renders identically every load, and
// built once at module load since it never varies. Emitted as an SVG data URI
// (encodeURIComponent, not hand-escaped) so it tiles and drifts like any
// normal background-image.
const TILE_W = 180
const TILE_H = 174

function buildBookcaseTile(): string {
    const BAYS = 2
    const ROWS = 3
    const BAY_W = TILE_W / BAYS // 90
    const ROW_H = TILE_H / ROWS // 58
    const FRAME = 3 // upright / shelf-board thickness
    // The tile is consumed as an alpha MASK (see watermarkStyle), so this fill
    // colour is never actually seen - only each spine's fill-opacity, which
    // becomes the mask's alpha and thus the tonal variation. The visible ink is
    // the themed --theme-shelf-ink background painted behind the mask.
    const INK = '#000' // opaque; only the alpha channel matters

    // Fixed walks; a single rolling counter indexes them across every
    // compartment, so no two compartments come out the same.
    const WIDTHS = [12, 9, 15, 10, 13, 8, 14, 11]
    const HEIGHTS = [46, 34, 50, 30, 42, 38, 48, 32, 44, 36]
    const GAPS = [3, 4, 2, 4, 3, 5, 3]
    const ALPHAS = [0.55, 0.75, 0.9, 0.65, 1, 0.8]
    const spine = (x: number, y: number, w: number, h: number, a: number, lean = 0): string =>
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${INK}" fill-opacity="${a}"` +
        (lean ? ` transform="rotate(${lean} ${x} ${y + h})"` : '') +
        '/>'

    let g = 0
    const compartment = (bx: number, row: number, idx: number): string => {
        const left = bx * BAY_W + FRAME + 2
        const baseline = (row + 1) * ROW_H - FRAME // top surface of this shelf board
        const leanAt = 1 + (idx % 3) // which spine in the run leans
        const flat = idx % 3 === 2 // this compartment ends in a flat stack
        const right = (bx + 1) * BAY_W - 2 - (flat ? 20 : 0)
        const parts: string[] = []
        let x = left
        let n = 0
        while (x + WIDTHS[g % WIDTHS.length] <= right) {
            const w = WIDTHS[g % WIDTHS.length]
            const h = HEIGHTS[g % HEIGHTS.length]
            const a = ALPHAS[g % ALPHAS.length]
            parts.push(spine(x, baseline - h, w, h, a, n === leanAt ? 7 : 0))
            x += w + GAPS[g % GAPS.length]
            g++
            n++
        }
        // A few books lying flat, as on a real shelf - short stacked planks.
        if (flat) {
            const sx = x + 2
            const sw = (bx + 1) * BAY_W - 3 - sx
            if (sw > 8) {
                for (let s = 0; s < 3; s++)
                    parts.push(spine(sx, baseline - 5 - s * 5, sw, 4, ALPHAS[(g + s) % ALPHAS.length]))
                g++
            }
        }
        return parts.join('')
    }

    const frame: string[] = []
    // Full-height uprights (left edge + midline) and full-width shelf boards.
    for (let b = 0; b < BAYS; b++) frame.push(spine(b * BAY_W, 0, FRAME, TILE_H, 1))
    for (let r = 0; r < ROWS; r++) frame.push(spine(0, (r + 1) * ROW_H - FRAME, TILE_W, FRAME, 1))
    const compartments: string[] = []
    let idx = 0
    for (let b = 0; b < BAYS; b++) for (let r = 0; r < ROWS; r++) compartments.push(compartment(b, r, idx++))

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}">${frame.join('')}${compartments.join('')}</svg>`
}

const TILE_URI = `url("data:image/svg+xml,${encodeURIComponent(buildBookcaseTile())}")`

const watermarkStyle: JSX.CSSProperties = {
    // Paint the tile as an alpha MASK over a themed fill rather than as a fixed
    // background-image. That makes the shelf ink a live theme colour
    // (--theme-shelf-ink, falling back to the theme's sub-text tone) so the
    // watermark keeps good contrast in *both* directions - a dark ink on light
    // themes, a light ink on dark ones - which one baked-in grey never could.
    'background-color': 'var(--theme-shelf-ink, var(--theme-text-sub))',
    'mask-image': TILE_URI,
    'mask-size': `${TILE_W}px ${TILE_H}px`,
    'mask-repeat': 'repeat',
    '-webkit-mask-image': TILE_URI,
    '-webkit-mask-size': `${TILE_W}px ${TILE_H}px`,
    '-webkit-mask-repeat': 'repeat',
    // Oversized by one tile in the drift direction (origin top-left,
    // translating up-left) so the transform never exposes a bare edge.
    width: `calc(100% + ${TILE_W}px)`,
    height: `calc(100% + ${TILE_H}px)`,
}

export const AuthShell: Component<{ children: JSX.Element }> = (props) => {
    const [motionEnabled, setMotionEnabled] = createSignal(true)

    return (
        <div class="bg-background relative flex min-h-screen flex-col overflow-hidden">
            {/* Page-level texture: a sparse, low-opacity tiling of book spines,
                instead of the card itself carrying decoration. Drifts slowly;
                motionEnabled lets users kill the motion. */}
            <div
                class="pointer-events-none absolute top-0 left-0 z-0 opacity-[0.09]"
                classList={{ 'animate-bg-drift': motionEnabled() }}
                style={watermarkStyle}
            />

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

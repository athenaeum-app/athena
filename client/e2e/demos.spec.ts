import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { mkdirSync, rmSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

// Demo GIF harness, sibling to screenshots.spec.ts. It drives the real server,
// seeds a small library, captures PNG frames, and hands them to ffmpeg to
// encode into docs/demos/*.gif for the README. Run standalone against a fresh
// server:
//
//   cd client && npm run build
//   cd ../server && go build -o athena-server.exe ./cmd/athena-server
//   cd ../client && npm run demos
//
// Requires ffmpeg on PATH. Without it the frames are left on disk and the test
// fails with a clear message rather than silently producing nothing.
//
// GIF is a poor video codec and a fine animation format, which shapes what is
// captured here: short, low-frame-rate, mostly-static clips. Anything with
// continuous motion (panning the canvas, scrolling the feed) repaints every
// pixel of every frame and balloons the file, so the demos stick to discrete
// state changes with still moments between them.

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEMO_DIR = resolve(__dirname, '..', '..', 'docs', 'demos')
const FRAME_DIR = resolve(__dirname, '.frames')

// Output width in the README. The capture viewport is larger; downscaling on
// encode is what keeps text crisp rather than capturing small and upscaling.
const GIF_WIDTH = 860

// A due date at local midnight, `days` from today, as an RFC3339 string.
function dueIn(days: number): string {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() + days)
    return d.toISOString()
}

async function post<T>(req: APIRequestContext, url: string, data: unknown): Promise<T> {
    const res = await req.post(url, { data })
    if (!res.ok()) throw new Error(`POST ${url} -> ${res.status()} ${await res.text()}`)
    return (await res.json()) as T
}

async function patch(req: APIRequestContext, url: string, data: unknown): Promise<void> {
    const res = await req.patch(url, { data })
    if (!res.ok()) throw new Error(`PATCH ${url} -> ${res.status()} ${await res.text()}`)
}

function hasFfmpeg(): boolean {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
}

// Two-pass palette encode. GIF is capped at 256 colours, and ffmpeg's default
// (a fixed web palette) turns every theme in this app into mud; generating a
// palette from the clip itself is what keeps the colours true. stats_mode=diff
// weights the palette toward the pixels that actually change between frames,
// which is most of the point when the backdrop is a flat colour.
function encodeGif(name: string, fps: number): string {
    const frames = resolve(FRAME_DIR, name, 'frame-%04d.png')
    const palette = resolve(FRAME_DIR, name, 'palette.png')
    const out = resolve(DEMO_DIR, `${name}.gif`)
    const scale = `scale=${GIF_WIDTH}:-1:flags=lanczos`

    const run = (args: string[]) => {
        const res = spawnSync('ffmpeg', args, { stdio: 'ignore' })
        if (res.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`)
    }
    run(['-y', '-framerate', String(fps), '-start_number', '0', '-i', frames, '-vf', `${scale},palettegen=stats_mode=diff`, palette])
    run([
        '-y', '-framerate', String(fps), '-start_number', '0', '-i', frames, '-i', palette,
        '-lavfi', `${scale} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`,
        '-loop', '0', out,
    ])
    return out
}

// A frame sink that numbers shots in capture order for one demo.
function frames(name: string) {
    const dir = resolve(FRAME_DIR, name)
    mkdirSync(dir, { recursive: true })
    let n = 0
    return {
        shot: (page: Page) => page.screenshot({ path: resolve(dir, `frame-${String(n++).padStart(4, '0')}.png`) }),
        // Capture continuously (as fast as the protocol allows, ~10fps) while
        // `action` runs, so an interaction reads as motion rather than a jump
        // cut between before and after.
        //
        // The pause between shots is a plain timer rather than
        // page.waitForTimeout: Playwright serialises calls per page, so the
        // capture loop and the interaction share one channel, and a loop that
        // never yields off-protocol starves the clicks it is supposed to be
        // filming until they time out.
        // Returns the rate it actually achieved, which is what the clip has to
        // be encoded at. A screenshot costs ~150ms, so the real rate lands
        // nearer 6fps than the 10 you might assume; encoding at a guessed
        // number plays the whole demo back at the wrong speed.
        during: async (page: Page, action: () => Promise<void>): Promise<number> => {
            const first = n
            const started = Date.now()
            let running = true
            const loop = (async () => {
                while (running) {
                    await page.screenshot({ path: resolve(dir, `frame-${String(n++).padStart(4, '0')}.png`) })
                    await new Promise((r) => setTimeout(r, 25))
                }
            })()
            await action()
            running = false
            await loop
            return (n - first) / ((Date.now() - started) / 1000)
        },
        count: () => n,
    }
}

test('capture README demo GIFs', async ({ page }) => {
    // Hundreds of screenshots plus two ffmpeg passes; the suite default of 30s
    // is for assertions, not for filming.
    test.setTimeout(240_000)
    test.skip(!hasFfmpeg(), 'ffmpeg is not on PATH; install it to regenerate the demo GIFs')

    const req = page.request
    const setup = (await (await req.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    test.skip(!setup.needs_setup, 'run standalone against a fresh server: npm run demos')

    mkdirSync(DEMO_DIR, { recursive: true })
    rmSync(FRAME_DIR, { recursive: true, force: true })

    // --- Seed: deliberately smaller than the screenshot harness. These clips
    //     only need enough content that the surfaces do not look empty. ---
    await post(req, '/api/v1/auth/register', { username: 'athena', password: 'password123', invite_id: '', stay_logged_in: true })
    const journal = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Journal' })
    const tRead = await post<{ id: string }>(req, '/api/v1/tags', { name: 'reading', color: '#7ed6df' })
    const tLife = await post<{ id: string }>(req, '/api/v1/tags', { name: 'life', color: '#ff7979' })

    await post(req, '/api/v1/moments', {
        archive_id: journal.id,
        title: 'On keeping a commonplace book',
        content:
            'A place to collect what is worth keeping: quotations, half-formed ideas, the odd diagram.\n\n> "We are what we repeatedly read."\n\nThe **athenaeum** is that book, made searchable.',
        tag_ids: [tRead.id, tLife.id],
    })
    await post(req, '/api/v1/moments', {
        archive_id: journal.id,
        title: 'Field notes: the coast path',
        content: 'Grey light off the water, gorse in flower. Walked the whole northern stretch and barely saw a soul.',
        tag_ids: [tLife.id],
    })

    // Due dates are not decoration here: the clip ends on the agenda view, and
    // the agenda lists tasks by when they are due, so without them the demo
    // finishes on "Nothing scheduled".
    const project = await post<{ id: string }>(req, '/api/v1/todos', { kind: 'general', title: 'Project Athena' })
    const ship = await post<{ id: string }>(req, `/api/v1/todos/${project.id}/items`, { text: 'Ship the refinement pass' })
    await patch(req, `/api/v1/todo-items/${ship.id}`, { priority: 3, due_at: dueIn(1) })
    const notes = await post<{ id: string }>(req, `/api/v1/todos/${project.id}/items`, { text: 'Write the release notes' })
    await patch(req, `/api/v1/todo-items/${notes.id}`, { priority: 2, due_at: dueIn(3) })
    const plants = await post<{ id: string }>(req, `/api/v1/todos/${project.id}/items`, { text: 'Water the office plants' })
    await patch(req, `/api/v1/todo-items/${plants.id}`, { priority: 1, recurrence: 'weekly', due_at: dueIn(5) })

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')

    const appearance = async (theme: string, look: string) => {
        await page.evaluate(
            ([t, l]) => {
                localStorage.setItem('athena-active-theme', t)
                localStorage.setItem('athena-active-look', l)
            },
            [theme, look],
        )
        await page.goto('/')
        await expect(page.getByText('On keeping a commonplace book').first()).toBeVisible()
    }

    // ---------- Demo 1: the appearance system ----------
    //
    // One still frame per theme, encoded at a low frame rate so each holds long
    // enough to read. A theme change is an instant repaint with nothing to
    // animate, so capturing the transition would only add frames that look like
    // a flicker, and multiply the file size for it.
    const themes = frames('themes')
    for (const [theme, look] of [
        ['legacy', 'legacy'],
        ['ocean', 'slate-soft'],
        ['rosewood', 'legacy'],
        ['arctic', 'slate-soft'],
        ['royal blue', 'ink'],
        ['sunset', 'aurora'],
        ['light', 'editorial'],
    ]) {
        await appearance(theme, look)
        await page.waitForTimeout(400) // let fonts and the look's shadows settle
        await themes.shot(page)
    }
    const themesGif = encodeGif('themes', 1.15)

    // ---------- Demo 2: the to-do board ----------
    //
    // Checking items off is the one interaction with visible motion (the
    // progress bar fills), so this one records continuously.
    const todos = frames('todos')
    await appearance('ocean', 'slate-soft')
    await page.getByRole('button', { name: 'Todos', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'To-Do Board' })).toBeVisible()
    await page.waitForTimeout(600)

    // The item's checkbox is a preceding sibling of the span holding its text,
    // which pins it to one row without depending on the card's class names.
    const checkbox = (text: string) =>
        page.getByText(text, { exact: true }).locator('xpath=preceding-sibling::input[@type="checkbox"]')

    const todosFps = await todos.during(page, async () => {
        await page.waitForTimeout(600)
        await checkbox('Write the release notes').check()
        await page.waitForTimeout(1100)
        await checkbox('Water the office plants').check()
        await page.waitForTimeout(1100)
        await page.getByTitle('Agenda view').click()
        await page.waitForTimeout(1600)
    })
    const todosGif = encodeGif('todos', Number(todosFps.toFixed(2)))

    rmSync(FRAME_DIR, { recursive: true, force: true })
    console.log(
        `demo GIFs written:\n` +
            `  ${themesGif} (${themes.count()} frames @ 1.15fps)\n` +
            `  ${todosGif} (${todos.count()} frames @ ${todosFps.toFixed(1)}fps)`,
    )
})

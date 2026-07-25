import { test, expect, type APIRequestContext } from '@playwright/test'
import { mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// Screenshot harness. Drives the real Go server (freshly wiped by
// playwright.config.ts), registers the owner, seeds representative content
// through the REST API, then captures each main surface into docs/screenshots/
// for the README. Run with:  npm run build && (build server) && npm run e2e
//
// This is intentionally separate from the critical-path spec: it never asserts
// UI behaviour beyond "the surface rendered", so a cosmetic UI change won't
// break it. It just re-shoots.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = resolve(__dirname, '..', '..', 'docs', 'screenshots')

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

test('capture README screenshots of the main surfaces', async ({ page }) => {
    mkdirSync(SHOT_DIR, { recursive: true })
    const req = page.request // shares the browser context's cookie jar

    // This harness owns the whole server: it registers the first user and
    // seeds from scratch. When run inside the full e2e suite (where another
    // spec has already claimed the owner), there's nothing to shoot, so skip.
    const setup = (await (await req.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    test.skip(!setup.needs_setup, 'run standalone against a fresh server: npm run screenshots')

    // --- Owner registration (first user, no invite) ---
    await post(req, '/api/v1/auth/register', {
        username: 'athena',
        password: 'password123',
        invite_id: '',
        stay_logged_in: true,
    })

    // --- Archives + tags ---
    const journal = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Journal' })
    const ideas = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Ideas' })
    const tRead = await post<{ id: string }>(req, '/api/v1/tags', { name: 'reading', color: '#7ed6df' })
    const tDeep = await post<{ id: string }>(req, '/api/v1/tags', { name: 'deep-work', color: '#ffbe76' })
    const tLife = await post<{ id: string }>(req, '/api/v1/tags', { name: 'life', color: '#ff7979' })

    // --- Moments (varied, with markdown + tags) ---
    const m1 = await post<{ id: string }>(req, '/api/v1/moments', {
        archive_id: journal.id,
        title: 'On keeping a commonplace book',
        content:
            'A place to collect what is worth keeping: quotations, half-formed ideas, the odd diagram.\n\n> "We are what we repeatedly read."\n\nThe **athenaeum** is that book, made searchable.',
        tag_ids: [tRead.id, tLife.id],
    })
    await post(req, '/api/v1/moments', {
        archive_id: ideas.id,
        title: 'Weekly review ritual',
        content:
            'Every Sunday:\n\n- Sweep the inbox to zero\n- Pull unfinished tasks into the new week\n- Write one paragraph on what mattered',
        tag_ids: [tDeep.id],
    })
    await post(req, '/api/v1/moments', {
        archive_id: journal.id,
        title: 'Field notes: the coast path',
        content: 'Grey light off the water, gorse in flower. Walked the whole northern stretch and barely saw a soul.',
        tag_ids: [tLife.id],
    })
    await post(req, '/api/v1/moments', {
        archive_id: ideas.id,
        title: 'Reading queue',
        content: 'Next up: *The Order of Time*, then something lighter. Note to self: finish what I start.',
        tag_ids: [tRead.id],
    })

    // --- Todos: a daily list + a project board with due dates, priority,
    //     a recurring task and a couple of subtasks (populates board + agenda) ---
    const daily = await post<{ id: string }>(req, '/api/v1/todos', { kind: 'daily', title: 'Today' })
    for (const text of ['Morning pages', 'Inbox to zero', 'Walk 30 minutes']) {
        await post(req, `/api/v1/todos/${daily.id}/items`, { text })
    }

    const project = await post<{ id: string }>(req, '/api/v1/todos', { kind: 'general', title: 'Project Athena' })
    const ship = await post<{ id: string }>(req, `/api/v1/todos/${project.id}/items`, { text: 'Ship the v2.3 refinement pass' })
    // Priority, a due date, and a linked moment (drives the focused reader shot).
    await patch(req, `/api/v1/todo-items/${ship.id}`, { priority: 3, due_at: dueIn(1), moment_id: m1.id })
    // Subtasks under "Ship…"
    const sub1 = await post<{ id: string }>(req, `/api/v1/todos/${project.id}/items`, { text: 'Tasks: subtasks + agenda', parent_id: ship.id })
    await patch(req, `/api/v1/todo-items/${sub1.id}`, { done: true })
    await post(req, `/api/v1/todos/${project.id}/items`, { text: 'Recurrence regeneration', parent_id: ship.id })

    const water = await post<{ id: string }>(req, `/api/v1/todos/${project.id}/items`, { text: 'Water the office plants' })
    await patch(req, `/api/v1/todo-items/${water.id}`, { priority: 1, recurrence: 'weekly', due_at: dueIn(3) })

    const review = await post<{ id: string }>(req, `/api/v1/todos/${project.id}/items`, { text: 'Overdue: reply to the archive request' })
    await patch(req, `/api/v1/todo-items/${review.id}`, { priority: 2, due_at: dueIn(-2) })

    // --- Canvas: a small board of notes + shapes ---
    const canvas = await post<{ id: string }>(req, '/api/v1/canvases', { title: 'Roadmap sketch' })
    const node = (kind: string, x: number, y: number, w: number, h: number, content: string, style: object) =>
        post(req, `/api/v1/canvases/${canvas.id}/nodes`, { kind, x, y, w, h, content, style: JSON.stringify(style) })
    await node('sticky', 60, 60, 180, 130, 'Foundation:\nsolid-query cache', { color: '#f6e58d', fontSize: 14 })
    await node('sticky', 300, 80, 180, 130, 'Tasks:\ndue • priority • agenda', { color: '#7bed9f', fontSize: 14 })
    await node('shape', 120, 260, 200, 120, 'Looks system', { color: '#dfe6e9', shape: 'rounded' })
    await node('shape', 380, 280, 160, 120, 'Canvas shapes', { color: '#c8d6ff', shape: 'ellipse' })
    await node('text', 60, 420, 320, 60, 'Everything composes into one athenaeum.', { color: '#ffffff', fontSize: 16 })

    // --- Chat: a short conversation ---
    for (const content of [
        'Kicking off the refinement pass on the editor.',
        'Optimistic mutations are in. The checkmark lag is gone.',
        'Todos now do subtasks, recurrence and an agenda view.',
    ]) {
        await post(req, '/api/v1/chat', { content })
    }

    // ---------- Capture ----------
    //
    // Every surface is shot under a different theme + look pairing, so the
    // README gallery doubles as a tour of the appearance system rather than
    // eleven pictures of the same palette. The active theme and look are plain
    // localStorage strings (themes.ts / looks.ts) read once on boot, so
    // switching means writing both keys and loading the page again.
    //
    // Reloading between surfaces also means no modal state carries over, which
    // is why nothing here presses Escape to unwind: each capture starts from a
    // clean feed. The README names the pairing under each shot; if you change a
    // pairing here, change the caption there too.
    await page.setViewportSize({ width: 1440, height: 900 })
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
        // The feed having rendered is the signal that the reload finished and
        // the new palette has been applied. .first() because the mobile swiper
        // renders neighbouring cards too.
        await expect(page.getByText('On keeping a commonplace book').first()).toBeVisible()
        await page.waitForTimeout(500)
    }

    // Open a menu module via its icon-only HubButton, matched by its
    // aria-label/title since the hub icons carry no visible text.
    const openModule = (label: string) => page.getByRole('button', { name: label, exact: true }).first().click()

    // Feed: the shipped defaults, so the hero shot stays the canonical one.
    await appearance('legacy', 'legacy')
    await page.screenshot({ path: resolve(SHOT_DIR, 'feed.png') })

    // To-Do board
    await appearance('ocean', 'slate-soft')
    await openModule('Todos')
    await expect(page.getByRole('heading', { name: 'To-Do Board' })).toBeVisible()
    await page.waitForTimeout(700)
    await page.screenshot({ path: resolve(SHOT_DIR, 'todos.png') })

    // Focused moment reader: open the moment linked to the "Ship…" task.
    // Editorial is the reading-oriented look, which is the point of this
    // surface. Paired with Neutral rather than Light because Light renders
    // blockquotes at very low contrast and this moment contains one.
    await appearance('neutral', 'editorial')
    await openModule('Todos')
    await page.getByTitle('Open linked moment').first().click()
    await expect(page.getByRole('heading', { name: 'On keeping a commonplace book' })).toBeVisible()
    await page.waitForTimeout(600)
    await page.screenshot({ path: resolve(SHOT_DIR, 'focused-moment.png') })

    // Agenda view (a toggle inside the board). Matched on its title rather than
    // its accessible name: the docked chat widget previews a seeded message
    // containing the word "agenda", which makes a name match ambiguous.
    await appearance('royal blue', 'ink')
    await openModule('Todos')
    await expect(page.getByRole('heading', { name: 'To-Do Board' })).toBeVisible()
    await page.getByTitle('Agenda view').click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: resolve(SHOT_DIR, 'agenda.png') })

    // Canvas: open the module, then select the seeded canvas so the board
    // (not the "select a canvas" placeholder) is what gets captured. The
    // context menu below shares this pairing because it is the same session.
    await appearance('sunset', 'aurora')
    await openModule('Canvas')
    await page.getByText('Roadmap sketch', { exact: true }).click()
    await expect(page.getByText('Foundation:')).toBeVisible()
    await page.waitForTimeout(700)
    await page.screenshot({ path: resolve(SHOT_DIR, 'canvas.png') })

    // Right-click empty canvas to prove the context menu lands under the cursor
    // (regression fix: it was thrown off-screen by the panel's backdrop-filter).
    await page.mouse.click(1050, 700, { button: 'right' })
    await expect(page.getByText('Add node', { exact: true })).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: resolve(SHOT_DIR, 'canvas-menu.png') })

    // Chat. Deliberately not Glass: the feed's inline composer sits directly
    // behind this overlay, and frosting it makes the shot look like a render
    // bug. Glass gets its showcase on the mobile filter sheet instead.
    await appearance('arctic', 'slate-soft')
    await openModule('Chat')
    // .first() because the docked menu chat widget previews the same messages.
    await expect(page.getByText('Optimistic mutations are in. The checkmark lag is gone.').first()).toBeVisible()
    await page.waitForTimeout(700)
    await page.screenshot({ path: resolve(SHOT_DIR, 'chat.png') })

    // Settings: land on the Appearance tab, where the Looks/theme system lives.
    await appearance('rosewood', 'legacy')
    await openModule('Settings')
    await page.getByRole('button', { name: 'Appearance' }).click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: resolve(SHOT_DIR, 'settings.png') })

    // --- Mobile app-shell: reuses the same seeded library, just at a phone
    //     viewport, to show the swiper feed + bottom nav + sheets. Themed
    //     separately again, to show the palettes are not desktop-only. ---
    await page.setViewportSize({ width: 390, height: 844 })

    // The feed as swipeable cards, with the bottom nav (Archives/Filter/New/Chat/More).
    await appearance('valentine', 'editorial')
    await page.screenshot({ path: resolve(SHOT_DIR, 'mobile-feed.png') })

    // Filter sheet: tags, date range, and media/link filters slide up from the
    // bottom nav instead of a tag bar stacked above the feed. A sheet over a
    // plain card feed is the cleanest place to show Glass's frosting.
    await appearance('dark', 'glass')
    await page.getByRole('button', { name: 'Filter' }).click()
    await expect(page.getByRole('button', { name: '#reading', exact: true })).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({ path: resolve(SHOT_DIR, 'mobile-filter.png') })

    // Chat, opened from the bottom nav.
    await appearance('light', 'ink')
    await page.getByRole('button', { name: 'Chat' }).click()
    await expect(page.getByText('Optimistic mutations are in. The checkmark lag is gone.').first()).toBeVisible()
    await page.waitForTimeout(600)
    await page.screenshot({ path: resolve(SHOT_DIR, 'mobile-chat.png') })
})

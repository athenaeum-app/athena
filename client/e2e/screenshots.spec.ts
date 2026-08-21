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

    // --- Canvas: a board of notes, shapes and live references. The reference
    //     nodes come further down, once the entities they point at exist. ---
    const canvas = await post<{ id: string }>(req, '/api/v1/canvases', { title: 'Roadmap sketch' })
    const node = (kind: string, x: number, y: number, w: number, h: number, content: string, style?: object) =>
        post(req, `/api/v1/canvases/${canvas.id}/nodes`, {
            kind,
            x,
            y,
            w,
            h,
            content,
            style: style ? JSON.stringify(style) : undefined,
        })
    await node('sticky', 60, 60, 200, 140, 'Foundation:\nsolid-query cache', { color: '#f6e58d', fontSize: 14 })
    await node('shape', 60, 240, 200, 120, 'Looks system', { color: '#dfe6e9', shape: 'rounded' })
    await node('shape', 60, 400, 200, 120, 'Canvas shapes', { color: '#c8d6ff', shape: 'ellipse' })
    // A text node carries moment content: markdown, and a live to-do embed.
    await node(
        'text',
        300,
        60,
        300,
        300,
        [
            '### Roadmap',
            '',
            'Everything composes into one **athenaeum**, and the board carries the',
            'same content a moment does:',
            '',
            `::todo:${daily.id}::`,
        ].join('\n'),
        { color: '#7ed6df', fontSize: 14 },
    )

    // --- Chat: a short conversation ---
    for (const content of [
        'Kicking off the refinement pass on the editor.',
        'Optimistic mutations are in. The checkmark lag is gone.',
        'Todos now do subtasks, recurrence and an agenda view.',
    ]) {
        await post(req, '/api/v1/chat', { content })
    }

    // --- Projects: a portfolio of three efforts, one of them filled in far
    //     enough to show a hub with real progress (milestones, finished and
    //     dismissed cards, priorities and due dates) ---
    const newProject = async (title: string, accent: string, icon: string, overview: string) => {
        const p = await post<{ id: string }>(req, '/api/v1/projects', { title })
        await patch(req, `/api/v1/projects/${p.id}`, { accent, icon, overview })
        return p
    }
    const milestone = (projectId: string, title: string, dueDays: number) =>
        post<{ id: string }>(req, `/api/v1/projects/${projectId}/milestones`, {
            title,
            due_at: dueIn(dueDays),
        })
    const cards = (projectId: string, milestoneId: string, titles: string[]) =>
        post<{ id: string }[]>(req, `/api/v1/projects/${projectId}/cards`, {
            milestone_id: milestoneId,
            titles,
        })

    const bindery = await newProject(
        'The Bindery',
        '#c9a35c',
        'menu_book',
        [
            'Rebinding the shelf of hardbacks that came out of the attic, a case at a time.',
            '',
            'The rule for this one: **nothing leaves the bench half-finished**. A case is done when the',
            'boards are on, the spine is lettered, and it stands up on its own.',
            '',
            'Sourcing notes and the cloth order:',
            '',
            `[[${m1.id}]]`,
        ].join('\n'),
    )

    const sourcing = await milestone(bindery.id, 'Sourcing', -14)
    const bench = await milestone(bindery.id, 'On the bench', 9)
    const lettering = await milestone(bindery.id, 'Lettering', 31)

    const sourced = await cards(bindery.id, sourcing.id, [
        'Order book cloth in three weights',
        'Cut boards for the first six',
        'Replace the bone folder',
        'Price a nipping press',
    ])
    for (const c of sourced.slice(0, 3)) await patch(req, `/api/v1/project-cards/${c.id}`, { done: true })
    // The fourth is dismissed rather than finished, which is what the graveyard
    // keeps: decided against, not lost.
    await patch(req, `/api/v1/project-cards/${sourced[3].id}`, { dismissed: true })

    const onBench = await cards(bindery.id, bench.id, [
        'Sew the octavo set',
        'Round and back the first three',
        'Case in the green cloth pair',
        'Repair the torn endpapers',
        'Trim the deckle edges',
    ])
    await patch(req, `/api/v1/project-cards/${onBench[0].id}`, { done: true })
    await patch(req, `/api/v1/project-cards/${onBench[1].id}`, {
        priority: 3,
        due_at: dueIn(2),
        body: 'The 1908 set has a cracked hinge, so this one gets a hollow back.',
    })
    await patch(req, `/api/v1/project-cards/${onBench[2].id}`, { priority: 2, due_at: dueIn(6) })

    const lettered = await cards(bindery.id, lettering.id, [
        'Test foils on offcuts',
        'Letter the spines',
        'Mark up the title pages',
        'Photograph the finished shelf',
    ])
    await patch(req, `/api/v1/project-cards/${lettered[0].id}`, { priority: 1 })

    const garden = await newProject(
        'Kitchen garden',
        '#8fbf8f',
        'science',
        'Four raised beds, and a running argument with the slugs.',
    )
    const beds = await milestone(garden.id, 'Beds', -3)
    const planting = await milestone(garden.id, 'Planting', 21)
    const built = await cards(garden.id, beds.id, ['Build the fourth bed', 'Top up the compost'])
    for (const c of built) await patch(req, `/api/v1/project-cards/${c.id}`, { done: true })
    await cards(garden.id, planting.id, ['Sow the brassicas', 'Net everything', 'Label the rows'])

    const darkroom = await newProject(
        'Darkroom',
        '#9d8fd6',
        'videocam',
        'Getting the spare room printing again: enlarger serviced, chemistry fresh, everything light-tight.',
    )
    const kit = await milestone(darkroom.id, 'Kit', 5)
    const firstPrints = await milestone(darkroom.id, 'First prints', 24)
    const kitCards = await cards(darkroom.id, kit.id, ['Service the enlarger', 'Blackout blind for the window', 'Mix fresh stop bath'])
    await patch(req, `/api/v1/project-cards/${kitCards[0].id}`, { done: true })
    await patch(req, `/api/v1/project-cards/${kitCards[1].id}`, { priority: 3, due_at: dueIn(4) })
    await cards(darkroom.id, firstPrints.id, ['Contact sheet the summer rolls', 'Print the coast path frames'])

    const atlas = await newProject(
        'Atlas rebuild',
        '#67b8c7',
        'flight',
        'Redrawing the wall map: one sheet per continent, hand-lettered.',
    )
    const draft = await milestone(atlas.id, 'Draft sheets', 12)
    const ink = await milestone(atlas.id, 'Inking', 40)
    const drafts = await cards(atlas.id, draft.id, ['Trace the coastlines', 'Set the projection', 'Mark the trade routes'])
    await patch(req, `/api/v1/project-cards/${drafts[0].id}`, { done: true })
    await patch(req, `/api/v1/project-cards/${drafts[1].id}`, { priority: 2, due_at: dueIn(8) })
    await cards(atlas.id, ink.id, ['Letter the continents', 'Ink the compass rose'])

    // --- Canvas reference nodes, now that their targets exist. A moment
    //     reference renders the moment, a to-do reference is checkable on the
    //     board itself, and a project reference carries its meter (ADR-0018). ---
    await node('moment-ref', 640, 60, 300, 300, m1.id)
    await node('todo-ref', 980, 60, 300, 200, project.id)
    await node('project-ref', 980, 300, 300, 180, bindery.id)

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

    // The planner (a toggle inside the board). Matched on its title rather than
    // its accessible name: the docked chat widget previews a seeded message
    // containing the word "agenda", which makes a name match ambiguous.
    await appearance('royal blue', 'ink')
    await openModule('Todos')
    await expect(page.getByRole('heading', { name: 'To-Do Board' })).toBeVisible()
    await page.getByTitle('Planner view').click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: resolve(SHOT_DIR, 'planner.png') })

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
    // (regression fix: it was thrown off-screen by the panel's backdrop-filter)
    // and that it fits the window whatever is on it.
    await page.mouse.click(620, 640, { button: 'right' })
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

    // Projects: the portfolio of covers, then a hub. The module opens as a
    // window over the library by default, which is what these shoot.
    await appearance('rose', 'slate-soft')
    await openModule('Projects')
    // The portfolio opens on the Overview; the covers are the Catalog.
    await page.getByTitle('Catalog view').click()
    await expect(page.getByText('The Bindery')).toBeVisible()
    await page.waitForTimeout(800)
    await page.screenshot({ path: resolve(SHOT_DIR, 'projects.png') })

    // Overview: the project's own document, with the progress signals beside it.
    await appearance('ocean', 'editorial')
    await openModule('Projects')
    await page.getByTitle('Catalog view').click()
    await page.getByText('The Bindery').click()
    await expect(page.getByTitle('Board view')).toBeVisible()
    await page.waitForTimeout(800)
    await page.screenshot({ path: resolve(SHOT_DIR, 'project-overview.png') })

    // Board: milestones as columns, with what is finished, due and dismissed.
    await appearance('dark', 'aurora')
    await openModule('Projects')
    await page.getByTitle('Catalog view').click()
    await page.getByText('The Bindery').click()
    await page.getByTitle('Board view').click()
    // Milestone titles are editable inputs on the board, so wait on a card.
    await expect(page.getByText('Sew the octavo set').first()).toBeVisible()
    await page.waitForTimeout(800)
    await page.screenshot({ path: resolve(SHOT_DIR, 'project-board.png') })

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

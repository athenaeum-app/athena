import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Canvas nodes used to be chips: a text node was a bare label, a moment
// reference was a title over three lines of flattened text, and a todo
// reference was a progress bar you could not touch. They render real content
// now. A text node runs through the moment pipeline (markdown and live
// embeds), a moment reference renders the moment itself, a todo reference is
// checkable in place, and projects and canvases are reference nodes of their
// own. See docs/adr/0018-canvas-nodes-render-the-moment-pipeline.md.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

async function post<T>(req: APIRequestContext, url: string, data: unknown): Promise<T> {
    const res = await req.post(url, { data })
    if (!res.ok()) throw new Error(`POST ${url} -> ${res.status()} ${await res.text()}`)
    return (await res.json()) as T
}

const BOARD = 'Rich node board'
const PROSE = 'Prose the flattened excerpt used to eat'
const CHECKABLE = 'Check me from the board'

interface Seeded {
    todoId: string
}

// Built through the API rather than the UI: what is under test is how the board
// draws what it is given, and driving eight creations through pickers to get
// there tests the pickers instead.
async function seed(req: APIRequestContext): Promise<Seeded> {
    // The suite shares one server, so a second run has to find what the first
    // one built rather than stack a second board with the same name on it.
    const existing = (await (await req.get('/api/v1/todos')).json()) as { id: string; title: string }[] | null
    const already = existing?.find((l) => l.title === 'Board checklist')
    if (already) return { todoId: already.id }

    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[] | null
    const archive =
        archives?.find((a) => a.name === 'BOARDS') ?? (await post<{ id: string }>(req, '/api/v1/archives', { name: 'BOARDS' }))

    const todo = await post<{ id: string }>(req, '/api/v1/todos', { kind: 'general', title: 'Board checklist' })
    await post(req, `/api/v1/todos/${todo.id}/items`, { text: CHECKABLE })

    const moment = await post<{ id: string }>(req, '/api/v1/moments', {
        archive_id: archive.id,
        title: 'Referenced moment',
        content: `## A real heading\n\n${PROSE}\n\n- one\n- two`,
    })

    const project = await post<{ id: string }>(req, '/api/v1/projects', { title: 'Referenced project' })
    const other = await post<{ id: string }>(req, '/api/v1/canvases', { title: 'Referenced canvas' })
    await post(req, `/api/v1/canvases/${other.id}/nodes`, { kind: 'sticky', x: 0, y: 0, w: 180, h: 160, content: 'a node' })

    const board = await post<{ id: string }>(req, '/api/v1/canvases', { title: BOARD })
    const node = (kind: string, x: number, y: number, content: string, style?: string) =>
        post(req, `/api/v1/canvases/${board.id}/nodes`, { kind, x, y, w: 300, h: 300, content, style })

    // Every node inside one screen at the framed zoom: a node that is off screen
    // deliberately does not render its body (see the deferral test below).
    await node('text', 0, 0, `**Bold** in a text node, and a live list:\n\n::todo:${todo.id}::`, JSON.stringify({ color: '#7ed6df', fontSize: 14 }))
    await node('moment-ref', 340, 0, moment.id)
    await node('todo-ref', 680, 0, todo.id)
    await node('project-ref', 0, 260, project.id)
    await node('canvas-ref', 340, 260, other.id)

    return { todoId: todo.id }
}

// Everything under test is on the board, and the feed behind the module holds
// the same moment and the same list, so assertions scope to the surface.
const board = (page: Page) => page.getByTestId('canvas-surface')

async function openBoard(page: Page, mobile: boolean): Promise<void> {
    await page.goto('/')
    if (mobile) await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('button', { name: 'Canvas' }).first().click()
    // The canvas list is a rail on desktop and a drawer on the phone.
    if (mobile) await page.getByRole('button', { name: 'Canvases' }).click()
    await page.getByText(BOARD, { exact: true }).click()
    await expect(board(page).getByTestId('canvas-rich-text').first()).toBeVisible()
}

for (const [label, size, mobile] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['mobile', { width: 390, height: 844 }, true],
] as const) {
    test(`every reference node renders its content (${label})`, async ({ page }) => {
        await signIn(page)
        await seed(page.request)
        await page.setViewportSize(size)
        await openBoard(page, mobile)

        // The moment reference renders the moment, headings and all, rather than
        // a title over a line of stripped-out text.
        await expect(board(page).getByRole('heading', { name: 'A real heading' })).toBeVisible()
        await expect(board(page).getByText(PROSE)).toBeVisible()

        // The project and canvas references are new node kinds; without the
        // server allowing the kind through they persist as text nodes holding a
        // bare uuid, which is what these two assertions would catch.
        await expect(board(page).getByText('Referenced project')).toBeVisible()
        await expect(board(page).getByTestId('canvas-thumbnail')).toBeVisible()
    })

    test(`a todo reference is checkable on the board (${label})`, async ({ page }) => {
        await signIn(page)
        const { todoId } = await seed(page.request)
        const doneNow = async () => {
            const lists = (await (await page.request.get('/api/v1/todos')).json()) as { id: string; items: { done: boolean }[] }[]
            return lists.find((l) => l.id === todoId)!.items[0].done
        }
        // The suite shares a server and this spec runs at two viewports, so the
        // assertion is that the box flipped, not that it ended up ticked.
        const before = await doneNow()

        await page.setViewportSize(size)
        await openBoard(page, mobile)

        // The same list is on the board twice: once as a todo-ref node, once
        // embedded in the text node. Checking the node has to reach the server,
        // and the other copy has to follow.
        const inTodoNode = board(page)
            .locator('[data-node-kind="todo-ref"]')
            .getByRole('button', { name: new RegExp(CHECKABLE) })
        await expect(inTodoNode).toBeVisible()
        await inTodoNode.click()

        await expect(async () => expect(await doneNow()).toBe(!before)).toPass()

        // The embedded copy follows without a reload, because the checklist
        // reports through todoBus the way the feed's embeds do.
        await expect(board(page).locator('[data-node-kind="text"]').locator('.line-through')).toHaveCount(before ? 0 : 1)
    })
}

test('a text node defers its body until it has been on screen', async ({ page }) => {
    await signIn(page)
    const req = page.request
    const tall = await post<{ id: string }>(req, '/api/v1/canvases', { title: 'Tall column' })
    const COUNT = 12
    for (let i = 0; i < COUNT; i++) {
        await post(req, `/api/v1/canvases/${tall.id}/nodes`, {
            kind: 'text',
            x: 0,
            y: i * 1200,
            w: 300,
            h: 220,
            content: `**Node ${i}** of a column too tall to fit on one screen`,
            style: JSON.stringify({ color: '#f6e58d', fontSize: 14 }),
        })
    }

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Canvas' }).first().click()
    await page.getByText('Tall column', { exact: true }).click()
    await expect(board(page).getByTestId('canvas-rich-text').first()).toBeVisible()

    // Framing this board bottoms out at the minimum zoom, so most of the column
    // is off screen. Those nodes are still in the DOM (they draw their colour
    // and their excerpt); what they have not done is lay out markdown or open a
    // connection per embed, which is the whole point of the deferral.
    await expect(board(page).locator('[data-node-kind="text"]')).toHaveCount(COUNT)
    const rendered = await board(page).getByTestId('canvas-rich-text').count()
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(COUNT)
})

test('the add-node menu fits the window wherever it is opened', async ({ page }) => {
    await signIn(page)
    await seed(page.request)
    await page.setViewportSize({ width: 1440, height: 900 })
    await openBoard(page, false)

    // The bottom-right of the board, which is the corner a menu clamped against
    // a hardcoded height fell out of the moment the menu grew an entry.
    const surface = (await board(page).boundingBox())!
    await page.mouse.click(surface.x + surface.width - 20, surface.y + surface.height - 20, { button: 'right' })
    const menu = page.getByTestId('canvas-context-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByText('Canvas reference')).toBeVisible()

    const box = (await menu.boundingBox())!
    const view = page.viewportSize()!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(view.width)
    expect(box.y + box.height).toBeLessThanOrEqual(view.height)
})

test('a connector can be drawn from a card node', async ({ page }) => {
    await signIn(page)
    await seed(page.request)
    await page.setViewportSize({ width: 1440, height: 900 })
    await openBoard(page, false)

    // The connector dots sit outside a node's box, and the card kinds clipped
    // their own overflow, so the dots were drawn nowhere and hit-tested
    // nowhere: a drag from one fell through to the surface and panned the
    // board. Only shapes and bare text nodes could be wired up.
    const surface = board(page)
    const from = surface.locator('[data-node-kind="todo-ref"]')
    const to = surface.locator('[data-node-kind="project-ref"]')
    const fromBox = (await from.boundingBox())!
    const toBox = (await to.boundingBox())!

    // Hover first: the dots are revealed on hover, and the one on the
    // underside is the third of the four (top, right, bottom, left).
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2)
    const dot = (await from.getByTitle('Drag to connect to another node').nth(2).boundingBox())!

    const before = await surface.locator('svg line[marker-end]').count()
    await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2)
    await page.mouse.down()
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 8 })
    await page.mouse.up()

    await expect(surface.locator('svg line[marker-end]')).toHaveCount(before + 1)
})

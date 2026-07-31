import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Clicking a `::canvas:<id>::` card used to open the Canvas module on its
// "select a canvas" placeholder: every call site passed the click along without
// the id, and the module had nothing to receive one with. It opens the
// referenced board now, and frames the camera on the nodes rather than resetting
// to the world origin, which for a board built away from the origin showed
// empty grid that reads exactly like an empty canvas.

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

const BOARD = 'Board built far from the origin'
const NODE = 'the node you came here for'
const MOMENT = 'A moment that references a canvas'

// Nodes deliberately nowhere near 0,0: at the old fixed origin camera this
// board opens on empty grid.
async function seed(page: Page) {
    const req = page.request
    const moments = (await (await req.get('/api/v1/moments')).json()) as { title: string }[] | null
    if (moments?.some((m) => m.title === MOMENT)) return

    const canvas = await post<{ id: string }>(req, '/api/v1/canvases', { title: BOARD })
    await post(req, `/api/v1/canvases/${canvas.id}/nodes`, {
        kind: 'sticky',
        x: 2600,
        y: 1900,
        w: 180,
        h: 160,
        content: NODE,
        style: JSON.stringify({ color: '#f6e58d', fontSize: 14 }),
    })
    await post(req, `/api/v1/canvases/${canvas.id}/nodes`, {
        kind: 'sticky',
        x: 3000,
        y: 2200,
        w: 180,
        h: 160,
        content: 'a second node, further out',
        style: JSON.stringify({ color: '#7ed6df', fontSize: 14 }),
    })

    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    const archive =
        archives?.find((a) => a.name === 'Refs') ?? (await post<{ id: string }>(req, '/api/v1/archives', { name: 'Refs' }))
    await post(req, '/api/v1/moments', {
        archive_id: archive.id,
        title: MOMENT,
        content: `Here is the board:\n\n::canvas:${canvas.id}::`,
        tag_ids: [],
    })
}

const card = (page: Page) => page.getByTestId('moment-card').filter({ hasText: MOMENT })
const surface = (page: Page) => page.getByTestId('canvas-surface')

test.describe('opening a canvas by reference', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('opens the referenced board, framed on its nodes', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        await card(page).getByText(BOARD).click()

        // The board itself, not the "select a canvas" placeholder.
        await expect(surface(page)).toBeVisible()
        await expect(page.getByText('Select or create a canvas to begin.')).toHaveCount(0)

        const node = page.getByText(NODE)
        await expect(node).toBeVisible()

        // Framed: both nodes are inside the surface, not off past its edge
        // where overflow-hidden makes them invisible to a reader but not to a
        // bounding-box check.
        const view = (await surface(page).boundingBox())!
        for (const text of [NODE, 'a second node, further out']) {
            const box = (await page.getByText(text).boundingBox())!
            expect(box.x).toBeGreaterThanOrEqual(view.x - 1)
            expect(box.y).toBeGreaterThanOrEqual(view.y - 1)
            expect(box.x + box.width).toBeLessThanOrEqual(view.x + view.width + 1)
            expect(box.y + box.height).toBeLessThanOrEqual(view.y + view.height + 1)
        }

        // And centred on them rather than merely somewhere on screen.
        const first = (await page.getByText(NODE).boundingBox())!
        const second = (await page.getByText('a second node, further out').boundingBox())!
        const midX = (first.x + second.x + second.width) / 2
        const midY = (first.y + second.y + second.height) / 2
        expect(Math.abs(midX - (view.x + view.width / 2))).toBeLessThan(view.width * 0.25)
        expect(Math.abs(midY - (view.y + view.height / 2))).toBeLessThan(view.height * 0.25)
    })

    test('the nav button still opens the plain list', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        // Opening by reference and then closing must not leave the module
        // pinned to that board the next time it is opened from the menu.
        await card(page).getByText(BOARD).click()
        await expect(surface(page)).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(surface(page)).toHaveCount(0)

        await page.getByRole('button', { name: 'Canvas' }).first().click()
        await expect(page.getByText('Select or create a canvas to begin.')).toBeVisible()
    })
})

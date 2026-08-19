import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Snapping only ever applied to what you were dragging, so a board arranged
// before the setting was turned on stayed off the grid however long you spent
// nudging it. The button beside the grid toggle brings the whole board on at
// once, and only appears while snapping is on: off the grid it would be an
// action with no visible rule behind it.

const GRID = 24

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

interface Board {
    id: string
    title: string
}

// Every node deliberately off the grid, in both origin and extent.
async function seedBoard(req: APIRequestContext, title: string): Promise<Board> {
    const board = await post<{ id: string }>(req, '/api/v1/canvases', { title })
    const offGrid = [
        { x: 7, y: 13, w: 191, h: 121 },
        { x: 233, y: 59, w: 187, h: 143 },
        { x: 61, y: 251, w: 205, h: 97 },
    ]
    for (const box of offGrid) {
        await post(req, `/api/v1/canvases/${board.id}/nodes`, {
            kind: 'sticky',
            ...box,
            content: 'off the grid',
            style: JSON.stringify({ color: '#f6e58d', fontSize: 14 }),
        })
    }
    return { id: board.id, title }
}

async function openBoard(page: Page, title: string): Promise<void> {
    await page.goto('/')
    await page.getByRole('button', { name: 'Canvas', exact: true }).first().click()
    await page.getByText(title, { exact: true }).click()
    await expect(page.getByTestId('canvas-surface')).toBeVisible()
}

const snapAll = (page: Page) => page.getByTitle('Snap everything to the grid')

test('the snap-everything button is only offered while snapping is on', async ({ page }) => {
    await signIn(page)
    await seedBoard(page.request, 'Toggle board')
    await page.setViewportSize({ width: 1440, height: 900 })
    await openBoard(page, 'Toggle board')

    await expect(snapAll(page)).toBeHidden()
    await page.getByTitle('Snap to grid: off').click()
    await expect(snapAll(page)).toBeVisible()
    await page.getByTitle('Snap to grid: on').click()
    await expect(snapAll(page)).toBeHidden()
})

test('it brings every node onto the grid, and persists that', async ({ page }) => {
    await signIn(page)
    const board = await seedBoard(page.request, 'Tidy board')
    await page.setViewportSize({ width: 1440, height: 900 })
    await openBoard(page, 'Tidy board')

    await page.getByTitle('Snap to grid: off').click()
    await snapAll(page).click()
    await expect(page.getByText(/Snapped 3 nodes to the grid/)).toBeVisible()

    // Read it back from the server: an optimistic local patch that never
    // reached it would look identical on screen and be gone on reload.
    const saved = (await (await page.request.get(`/api/v1/canvases/${board.id}`)).json()) as {
        nodes: { x: number; y: number; w: number; h: number }[]
    }
    expect(saved.nodes).toHaveLength(3)
    for (const node of saved.nodes) {
        // Both edges, not just the leading one: snapping an extent rather than
        // an edge is the thing that left nodes looking aligned on one side.
        expect(node.x % GRID).toBe(0)
        expect(node.y % GRID).toBe(0)
        expect((node.x + node.w) % GRID).toBe(0)
        expect((node.y + node.h) % GRID).toBe(0)
    }
})

test('it says so rather than writing when the board is already aligned', async ({ page }) => {
    await signIn(page)
    await seedBoard(page.request, 'Aligned board')
    await page.setViewportSize({ width: 1440, height: 900 })
    await openBoard(page, 'Aligned board')

    await page.getByTitle('Snap to grid: off').click()
    await snapAll(page).click()
    await expect(page.getByText(/Snapped 3 nodes to the grid/)).toBeVisible()

    await snapAll(page).click()
    await expect(page.getByText('Everything is already on the grid.')).toBeVisible()
})

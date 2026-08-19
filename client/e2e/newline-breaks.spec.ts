import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Everything in this app is typed into a textarea, where Shift+Enter ends a
// line. Markdown reads a single newline as a soft break and renders it as a
// space, so a message or a note came back with its lines joined into one.

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

const LINES = 'first line\nsecond line\nthird line'

test('a canvas text node keeps the lines it was given', async ({ page }) => {
    await signIn(page)
    const board = await post<{ id: string }>(page.request, '/api/v1/canvases', { title: 'Newline board' })
    await post(page.request, `/api/v1/canvases/${board.id}/nodes`, {
        kind: 'text',
        x: 0,
        y: 0,
        w: 400,
        h: 240,
        content: LINES,
        style: JSON.stringify({ color: '#f6e58d', fontSize: 14 }),
    })

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Canvas', exact: true }).first().click()
    await page.getByText('Newline board', { exact: true }).click()

    const paragraph = page.getByTestId('canvas-surface').locator('[data-node-kind="text"] p')
    await expect(paragraph).toBeVisible()
    // Two breaks for three lines. Counting the breaks rather than the line
    // boxes on screen: the board is zoomed to fit, so where the words wrap is
    // not something the test can pin down, and it is not what broke.
    await expect(paragraph.locator('br')).toHaveCount(2)
    await expect(paragraph).toContainText('third line')
})

test('a chat message keeps the lines it was given', async ({ page }) => {
    await signIn(page)
    await post(page.request, '/api/v1/chat', { content: LINES })

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Chat', exact: true }).first().click()

    const message = page.locator('p').filter({ hasText: 'first line' }).last()
    await expect(message).toBeVisible()
    await expect(message.locator('br')).toHaveCount(2)
})

test('a blank line is still a paragraph break, not a doubled one', async ({ page }) => {
    await signIn(page)
    await post(page.request, '/api/v1/chat', { content: 'above\n\nbelow' })

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Chat', exact: true }).first().click()

    const above = page.locator('p').filter({ hasText: /^above$/ }).last()
    await expect(above).toBeVisible()
    await expect(above.locator('br')).toHaveCount(0)
})

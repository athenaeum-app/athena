import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Escape belongs to exactly one layer: the last one opened. A module that
// hosts its own dialogs used to answer the key at the same time as the dialog
// on top of it, so dismissing a card also shut the whole module behind it.

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

const openModule = async (page: Page, name: string) => {
    const button = page.getByRole('button', { name, exact: true }).first()
    await button.waitFor({ state: 'visible' })
    await button.click()
}

test.describe('escape closes one layer at a time', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('a project card closes without taking the module with it', async ({ page }) => {
        await signIn(page)
        const req = page.request
        const project = await post<{ id: string }>(req, '/api/v1/projects', { title: 'Layered' })
        const ms = await post<{ id: string }>(req, `/api/v1/projects/${project.id}/milestones`, { title: 'Stage one' })
        await post(req, `/api/v1/projects/${project.id}/cards`, { milestone_id: ms.id, titles: ['A card'] })

        await page.goto('/')
        await openModule(page, 'Projects')
        await page.getByText('Layered').first().click()
        await page.getByTitle('Board view').click()
        await page.getByText('A card').first().click()

        const card = page.getByTestId('project-card-modal')
        const board = page.getByRole('button', { name: 'Graveyard' })
        await expect(card).toBeVisible()

        await page.keyboard.press('Escape')
        await expect(card).toBeHidden()
        await expect(board).toBeVisible()

        await page.keyboard.press('Escape')
        await expect(board).toBeHidden()
    })

    test('the canvas guide closes without taking the board with it', async ({ page }) => {
        await signIn(page)
        await post(page.request, '/api/v1/canvases', { title: 'Escape Layers Board' })

        await page.goto('/')
        await openModule(page, 'Canvas')
        await page.getByText('Escape Layers Board').first().click()
        await page.getByTitle('Help').click()

        const guide = page.getByRole('heading', { name: 'Canvas controls' })
        const module = page.getByRole('heading', { name: 'CANVAS' })
        await expect(guide).toBeVisible()

        await page.keyboard.press('Escape')
        await expect(guide).toBeHidden()
        await expect(module).toBeVisible()

        await page.keyboard.press('Escape')
        await expect(module).toBeHidden()
    })
})

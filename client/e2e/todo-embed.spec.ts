import { test, expect, type Locator, type Page, type APIRequestContext } from '@playwright/test'

// A `::todo:<id>::` embed used to render every item of the list at one level,
// so a subtask sat next to its parent as if it were a task of its own. The Todo
// board has nested one level all along; the embed now draws the same shape.

async function post<T>(req: APIRequestContext, url: string, data: unknown): Promise<T> {
    const res = await req.post(url, { data })
    if (!res.ok()) throw new Error(`POST ${url} -> ${res.status()} ${await res.text()}`)
    return (await res.json()) as T
}

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

const PARENT = 'Ship the thing'
const SUB_A = 'Write the release note'
const SUB_B = 'Tag the build'
const LONE = 'Unrelated errand'

// Idempotent: the throwaway database is wiped once per run, not per test.
async function seed(page: Page) {
    const req = page.request
    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    if (archives?.some((a) => a.name === 'TODOEMBED')) return

    const arch = await post<{ id: string }>(req, '/api/v1/archives', { name: 'TODOEMBED' })
    const list = await post<{ id: string }>(req, '/api/v1/todos', { title: 'Embedded list', kind: 'general' })
    const parent = await post<{ id: string }>(req, `/api/v1/todos/${list.id}/items`, { text: PARENT })
    await post(req, `/api/v1/todos/${list.id}/items`, { text: SUB_A, parent_id: parent.id })
    await post(req, `/api/v1/todos/${list.id}/items`, { text: SUB_B, parent_id: parent.id })
    await post(req, `/api/v1/todos/${list.id}/items`, { text: LONE })

    await post(req, '/api/v1/moments', {
        archive_id: arch.id,
        title: 'Moment with a list',
        content: `Here is the plan:\n\n::todo:${list.id}::`,
        tag_ids: [],
    })
}

// A real <button>, which is what an item row is. The card around it carries
// role="button" too, and its accessible name swallows every row's text, so
// getByRole would match the whole card as well as the row inside it.
const row = (scope: Page | Locator, text: string) => scope.locator('button').filter({ hasText: text })

async function openFeed(page: Page) {
    await page.goto('/')
    await expect(row(page, PARENT)).toBeVisible()
}

test.describe('todo list embedded in a moment', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('nests subtasks under their parent', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await openFeed(page)

        const nested = page.getByTestId('todo-embed-subtasks')
        await expect(nested).toHaveCount(1)
        await expect(row(nested, SUB_A)).toBeVisible()
        await expect(row(nested, SUB_B)).toBeVisible()

        // The parent and the unrelated task belong outside it, or the nesting
        // would be decoration rather than structure.
        await expect(row(nested, PARENT)).toHaveCount(0)
        await expect(row(nested, LONE)).toHaveCount(0)
    })

    test('a nested subtask can still be checked inline', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await openFeed(page)

        const sub = row(page.getByTestId('todo-embed-subtasks'), SUB_A)
        await expect(sub.locator('span').last()).not.toHaveClass(/line-through/)
        await sub.click()
        await expect(sub.locator('span').last()).toHaveClass(/line-through/)

        // Survives a reload, so the click reached the server rather than only
        // flipping the optimistic local copy.
        await page.reload()
        const again = row(page.getByTestId('todo-embed-subtasks'), SUB_A)
        await expect(again.locator('span').last()).toHaveClass(/line-through/)
    })
})

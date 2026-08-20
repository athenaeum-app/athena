import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// `[[` as the one door (ADR-0019): one search across every kind, grouped and
// badged, narrowed by a `kind:` prefix, inserting each kind's canonical token.
//
// Checked at both viewports the suite standardizes on, because the menu is a
// portal positioned against the textarea's rect and the phone shell puts that
// textarea somewhere else entirely.

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

// One moment and one to-do list sharing a word, so a bare query has to return
// both kinds and a prefixed one has to return exactly one. Idempotent: the
// throwaway database is wiped once per run, not per test.
async function seed(page: Page): Promise<{ momentId: string; todoId: string }> {
    const req = page.request
    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    const archive =
        archives.find((a) => a.name === 'Pickers') ?? (await post<{ id: string }>(req, '/api/v1/archives', { name: 'Pickers' }))

    const moments = (await (await req.get('/api/v1/moments?q=Zanzibar')).json()) as { id: string; title: string }[]
    const moment =
        moments.find((m) => m.title === 'Zanzibar notes') ??
        (await post<{ id: string }>(req, '/api/v1/moments', {
            archive_id: archive.id,
            title: 'Zanzibar notes',
            content: 'where to eat',
            tag_ids: [],
        }))

    const todos = (await (await req.get('/api/v1/todos')).json()) as { id: string; title: string }[]
    const todo =
        todos.find((t) => t.title === 'Zanzibar packing') ??
        (await post<{ id: string }>(req, '/api/v1/todos', { kind: 'general', title: 'Zanzibar packing' }))

    return { momentId: moment.id, todoId: todo.id }
}

const composer = (page: Page) => page.getByPlaceholder('Write your thoughts', { exact: false })
const menu = (page: Page) => page.getByTestId('embed-menu')

// Desktop writes in the inline card at the top of the feed. The phone shell has
// no inline card, so its composer is the New Moment modal, and either way there
// is exactly one writing area on screen afterwards.
async function openComposer(page: Page, mobile: boolean): Promise<void> {
    if (mobile) await page.getByRole('button', { name: 'New Moment' }).first().click()
    await expect(composer(page)).toBeVisible()
}

for (const [name, viewport, hasTouch] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['mobile', { width: 390, height: 844 }, true],
] as const) {
    test.describe(`the one picker (${name})`, () => {
        test.use({ viewport, hasTouch })

        test('searches every kind, badges the hits, and inserts the right token', async ({ page }) => {
            await signIn(page)
            const { momentId, todoId } = await seed(page)
            await page.goto('/')

            await openComposer(page, hasTouch)
            await composer(page).click()
            await composer(page).type('[[Zanzibar')

            // Both kinds, each under its own heading.
            await expect(menu(page).getByText('Zanzibar notes')).toBeVisible()
            await expect(menu(page).getByText('Zanzibar packing')).toBeVisible()
            await expect(menu(page).getByText('Moment', { exact: true })).toBeVisible()
            await expect(menu(page).getByText('To-do list', { exact: true })).toBeVisible()

            // The menu must be fully on screen at this width, not hanging off it.
            const box = await menu(page).boundingBox()
            expect(box).not.toBeNull()
            expect(box!.x).toBeGreaterThanOrEqual(0)
            expect(box!.y).toBeGreaterThanOrEqual(0)
            expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
            expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1)

            // A moment stores as [[id]]. The query text is discarded.
            await menu(page).getByText('Zanzibar notes').click()
            await expect(composer(page)).toHaveValue(`[[${momentId}]]`)

            // A kind prefix narrows, and that kind stores as ::kind:id::.
            await composer(page).fill('')
            await composer(page).type('[[todo:Zanzibar')
            await expect(menu(page).getByText('Zanzibar packing')).toBeVisible()
            await expect(menu(page).getByText('Zanzibar notes')).toHaveCount(0)
            await page.keyboard.press('Enter')
            await expect(composer(page)).toHaveValue(`::todo:${todoId}::`)
        })
    })
}

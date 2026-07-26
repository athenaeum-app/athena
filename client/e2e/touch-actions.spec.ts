import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Actions that are only revealed on hover, checked on a touch device.
//
// Tailwind compiles `hover:` and `group-hover:` inside @media (hover: hover),
// so on a phone those rules never match and the control sits at opacity 0 for
// good. Where that control is the only route to an action, the action is not
// just fiddly on touch, it is unreachable. `no-hover:opacity-100` pins it
// visible exactly where hovering is impossible.
//
// `hasTouch: true` is what makes Chromium report (hover: none), so these tests
// fail against the un-fixed CSS. toBeVisible() would not catch this: Playwright
// treats an opacity-0 element as visible and will happily click it, so the
// assertions read computed opacity.

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

// One list, two items. Idempotent: the throwaway database is wiped once per
// run, not per test, so re-seeding would stack duplicate lists.
async function seedTodos(page: Page) {
    const req = page.request
    const existing = (await (await req.get('/api/v1/todos')).json()) as { title: string }[]
    if (existing?.some((l) => l.title === 'Touch')) return

    const list = await post<{ id: string }>(req, '/api/v1/todos', { kind: 'general', title: 'Touch' })
    await post(req, `/api/v1/todos/${list.id}/items`, { text: 'Delete me on a phone' })
    await post(req, `/api/v1/todos/${list.id}/items`, { text: 'Leave this one alone' })
}

async function seedCanvases(page: Page) {
    const req = page.request
    const existing = (await (await req.get('/api/v1/canvases')).json()) as { title: string }[]
    if (existing?.some((c) => c.title === 'Touch board')) return
    await post(req, '/api/v1/canvases', { title: 'Touch board' })
}

// Mobile route into a module: bottom nav "More" -> the module's row.
async function openModuleOnMobile(page: Page, name: 'Todos' | 'Canvas') {
    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('button', { name }).click()
}

const deleteItem = (page: Page, text: string) =>
    page.getByRole('button', { name: `Delete item ${text}`, exact: true })

test.describe('todo item delete on touch', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('the delete control is visible without hovering, and works', async ({ page }) => {
        await signIn(page)
        await seedTodos(page)
        await page.goto('/')
        await openModuleOnMobile(page, 'Todos')

        const target = deleteItem(page, 'Delete me on a phone')
        await expect(target).toHaveCSS('opacity', '1')

        await target.click()
        await expect(page.getByText('Delete me on a phone')).toHaveCount(0)
        // The rest of the list survives: this deleted one item, not the column.
        await expect(page.getByText('Leave this one alone')).toBeVisible()
    })
})

// The canvas list is a static rail on desktop and a slide-in drawer below lg,
// so its per-canvas controls are touch surfaces too. Unlike the nodes on the
// board, which have a long-press context menu, this list has no fallback.
test.describe('canvas list controls on touch', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('rename and delete are visible without hovering', async ({ page }) => {
        await signIn(page)
        await seedCanvases(page)
        await page.goto('/')
        await openModuleOnMobile(page, 'Canvas')

        // The rail starts off-screen on mobile; the header button slides it in.
        await page.getByRole('button', { name: 'Canvases' }).click()

        await expect(page.getByRole('button', { name: 'Rename canvas Touch board' })).toHaveCSS('opacity', '1')
        await expect(page.getByRole('button', { name: 'Delete canvas Touch board' })).toHaveCSS('opacity', '1')
    })
})

// The counterweight. Pinning the control visible on touch must not turn it into
// permanent clutter on a pointer, which is what the hover reveal is for.
test.describe('todo item delete on a pointer', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('the delete control stays hidden until the row is hovered', async ({ page }) => {
        await signIn(page)
        await seedTodos(page)
        await page.goto('/')
        await page.getByRole('button', { name: 'Todos' }).first().click()

        const target = deleteItem(page, 'Leave this one alone')
        await expect(target).toHaveCSS('opacity', '0')

        await target.hover()
        await expect(target).toHaveCSS('opacity', '1')
    })
})

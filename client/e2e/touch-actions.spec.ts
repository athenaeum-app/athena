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

    // Its own column, because the delete test above empties one of the rows in
    // the list and these assertions are about order.
    const order = await post<{ id: string }>(req, '/api/v1/todos', { kind: 'general', title: 'Touch order' })
    await post(req, `/api/v1/todos/${order.id}/items`, { text: 'Alpha task' })
    await post(req, `/api/v1/todos/${order.id}/items`, { text: 'Beta task' })
}

async function seedCanvases(page: Page) {
    const req = page.request
    const existing = (await (await req.get('/api/v1/canvases')).json()) as { title: string }[]
    if (existing?.some((c) => c.title === 'Touch board')) return
    await post(req, '/api/v1/canvases', { title: 'Touch board' })
}

// A moment whose body carries a fenced code block, so MarkdownText attaches its
// copy button to the rendered <pre>.
const CODE_MOMENT = 'Touch code block'
async function seedCodeMoment(page: Page) {
    const req = page.request
    const existing = (await (await req.get('/api/v1/archives')).json()) as { name: string }[]
    if (existing?.some((a) => a.name === 'TOUCH')) return

    const arch = await post<{ id: string }>(req, '/api/v1/archives', { name: 'TOUCH' })
    await post(req, '/api/v1/moments', {
        archive_id: arch.id,
        title: CODE_MOMENT,
        content: 'Here is some code:\n\n```js\nconst copied = true\n```\n',
        tag_ids: [],
    })
}

// This spec seeds the only fenced code block in the suite, but the mobile
// swiper card behind the reader renders the same body and attaches its own
// button, which .moment-preview hides with display: none. Excluding what isn't
// displayed leaves the one button under test; an opacity-0 button still counts
// as visible here, which is what the pointer tests below assert on.
const copyButton = (page: Page) => page.locator('.copy-btn:visible')

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

// Reordering is HTML5 drag-and-drop, which touch browsers never fire, so the
// board offered a grip that does nothing. The nudges are the same capability by
// a route a finger can take.
test.describe('todo reordering on touch', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('an item can be moved up from its detail panel', async ({ page }) => {
        await signIn(page)
        await seedTodos(page)
        await page.goto('/')
        await openModuleOnMobile(page, 'Todos')

        // Filtered by an item, not the column title: the title is an <input>
        // value, which hasText does not see.
        const column = page.getByTestId('todo-column').filter({ hasText: 'Alpha task' })
        const texts = () => column.getByTestId('todo-item-text').allInnerTexts()
        await expect.poll(texts).toEqual(['Alpha task', 'Beta task'])

        await page.getByRole('button', { name: 'Details Beta task' }).click()
        await page.getByRole('button', { name: 'Move Beta task up' }).click()

        await expect.poll(texts).toEqual(['Beta task', 'Alpha task'])
    })

    test('the drag grip is swapped for list nudges', async ({ page }) => {
        await signIn(page)
        await seedTodos(page)
        await page.goto('/')
        await openModuleOnMobile(page, 'Todos')

        await expect(page.getByTitle('Drag to reorder list').first()).toBeHidden()
        await expect(page.getByRole('button', { name: /^Move list .* right$/ }).first()).toBeVisible()
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

// The code-block COPY button used to be revealed by a mouseenter handler. Touch
// browsers do synthesise that event, but only after a tap on the code itself, so
// the affordance was invisible until you happened to prod it.
test.describe('code block copy button on touch', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('the copy button is visible without hovering the block', async ({ page }) => {
        await signIn(page)
        await seedCodeMoment(page)
        await page.goto('/')

        // The swiper card clips its render and hides the copy button, so the
        // one under test only appears once the reader is open. Filtering to
        // this spec's archive leaves one card to tap.
        await page.getByRole('button', { name: 'Archives' }).click()
        await page.getByRole('button', { name: 'TOUCH' }).click()
        await page.getByText(CODE_MOMENT).click()

        await expect(copyButton(page)).toHaveCSS('opacity', '1')
    })
})

// The counterweight. Pinning these visible on touch must not turn them into
// permanent clutter on a pointer, which is what the hover reveal is for.
test.describe('hover reveals survive on a pointer', () => {
    test.use({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })

    test('the copy button stays hidden until the code block is hovered', async ({ page }) => {
        await signIn(page)
        await seedCodeMoment(page)
        await page.goto('/')

        const btn = copyButton(page)
        await expect(btn).toHaveCSS('opacity', '0')

        await btn.hover()
        await expect(btn).toHaveCSS('opacity', '1')
    })

    // And it copies. The button reports through its own label, so it has to be
    // held by class rather than by text: matching on "COPY" stops matching the
    // moment the press works.
    test('pressing it puts the code on the clipboard, and says only that', async ({ page }) => {
        await signIn(page)
        await seedCodeMoment(page)
        await page.goto('/')

        const btn = copyButton(page)
        await btn.click()

        await expect(btn).toHaveText('COPIED!')
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const copied = true\n')
        // It goes back to offering the copy rather than staying on the report.
        await expect(btn).toHaveText('COPY', { timeout: 4000 })
    })

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

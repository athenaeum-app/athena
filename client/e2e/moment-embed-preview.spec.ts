import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// The moment reference preview (ADR-0017): off by default, and when on, the
// referenced moment rendered the way the main column renders it, clipped to a
// share of the window.
//
// The load-bearing rule is the depth cap. A preview never contains a preview,
// so two moments that reference each other terminate on the second hop with a
// compact card instead of rendering forever. That is what the seed builds and
// what the third test checks.

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

async function patch(req: APIRequestContext, url: string, data: unknown) {
    const res = await req.patch(url, { data })
    if (!res.ok()) throw new Error(`PATCH ${url} -> ${res.status()} ${await res.text()}`)
}

const HOST = 'The moment holding the reference'
const TARGET = 'The referenced moment'
// Markdown, so a real render is visibly not an excerpt, and long enough that
// 40% of a 900px window is a clip rather than a generous allowance.
const TARGET_BODY = [
    '## A heading the excerpt would flatten',
    '',
    ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of the referenced moment.`),
].join('\n\n')

// The host's id, so a test addresses its card rather than any card whose text
// mentions it: with previews on, the referenced moment's card holds this one's
// title too.
let hostId = ''

async function seed(page: Page) {
    const req = page.request
    const moments = (await (await req.get('/api/v1/moments')).json()) as { id: string; title: string }[] | null
    const found = moments?.find((m) => m.title === HOST)
    if (found) {
        hostId = found.id
        return
    }

    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    const archive =
        archives?.find((a) => a.name === 'RefCards')?.id ??
        (await post<{ id: string }>(req, '/api/v1/archives', { name: 'RefCards' })).id

    const target = await post<{ id: string }>(req, '/api/v1/moments', {
        archive_id: archive,
        title: TARGET,
        content: TARGET_BODY,
        tag_ids: [],
    })
    const host = await post<{ id: string }>(req, '/api/v1/moments', {
        archive_id: archive,
        title: HOST,
        content: `A moment:\n\n[[${target.id}]]`,
        tag_ids: [],
    })
    // The cycle: the referenced moment references the one referencing it.
    await patch(req, `/api/v1/moments/${target.id}`, { content: `${TARGET_BODY}\n\n[[${host.id}]]` })
    hostId = host.id
}

const card = (page: Page) => page.locator(`[data-moment-id="${hostId}"]`)
const preview = (page: Page) => card(page).getByTestId('moment-preview')

async function enablePreview(page: Page) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const box = page.locator('label').filter({ hasText: 'Moment Reference Previews' }).first().locator('input')
    if (!(await box.isChecked())) await box.click()
    // Escape rather than a Close button: several panels render one.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-tabs')).toHaveCount(0)
}

test.describe('moment reference preview', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('is off by default, showing the flattened excerpt', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        await expect(card(page).getByText(TARGET, { exact: true })).toBeVisible()
        await expect(preview(page)).toHaveCount(0)
        // The excerpt strips markdown, so the heading is text rather than an h2.
        await expect(card(page).locator('h2')).toHaveCount(0)
    })

    test('renders the moment, clipped to the configured height, without recursing', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        await enablePreview(page)

        await expect(preview(page)).toBeVisible()
        // A real render: the heading is a heading now.
        await expect(preview(page).locator('h2')).toHaveCount(1)

        // Clipped to the default 40% of a 900px window, and actually clipping
        // rather than merely permitted to.
        const box = (await preview(page).boundingBox())!
        expect(box.height).toBeLessThanOrEqual(900 * 0.4 + 1)
        const overflowing = await preview(page).evaluate(
            (el) => (el.firstElementChild as HTMLElement).offsetHeight > el.clientHeight,
        )
        expect(overflowing).toBe(true)

        // The cycle stops one hop in: the moment inside the preview references
        // this one back, and that reference is a card, not a second preview.
        // The feed holds both moments, so the other card has a preview of its
        // own; what matters is that this card holds exactly one.
        await expect(preview(page).getByText(HOST, { exact: true })).toBeVisible()
        await expect(card(page).getByTestId('moment-preview')).toHaveCount(1)
    })

    test('the height setting moves the clip', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        await enablePreview(page)
        const before = (await preview(page).boundingBox())!.height

        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page.getByLabel('Moment preview height').fill('80')
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('settings-tabs')).toHaveCount(0)

        const after = (await preview(page).boundingBox())!.height
        expect(after).toBeGreaterThan(before * 1.5)
        expect(after).toBeLessThanOrEqual(900 * 0.8 + 1)
    })
})

test.describe('moment reference preview, mobile', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('fits the reader and stays inside its share of the screen', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.addInitScript(() =>
            localStorage.setItem('athena-prefs', JSON.stringify({ momentEmbedPreview: true })),
        )
        await page.goto('/')

        const heading = page.getByRole('heading', { name: HOST })
        await expect(heading).toBeVisible()
        const box = (await heading.boundingBox())!
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await expect(page.getByTitle('Edit this moment')).toBeVisible()

        const shown = page.getByTestId('moment-preview')
        await expect(shown).toBeVisible()
        const rect = (await shown.boundingBox())!
        expect(rect.height).toBeLessThanOrEqual(844 * 0.4 + 1)
        expect(rect.x).toBeGreaterThanOrEqual(0)
        expect(rect.x + rect.width).toBeLessThanOrEqual(390)
    })
})

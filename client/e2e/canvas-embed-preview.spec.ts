import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// The canvas reference preview (ADR-0017): off by default, and when on, a
// wordless schematic of the board inside the reference card. Off by default is
// the first thing worth proving, because the compact card is what ADR-0015
// chose and this only offers to trade it away.

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

const BOARD = 'Board behind a reference'
const MOMENT = 'Moment with a canvas reference'
let momentId = ''

async function seed(page: Page) {
    const req = page.request
    const moments = (await (await req.get('/api/v1/moments')).json()) as { id: string; title: string }[] | null
    const found = moments?.find((m) => m.title === MOMENT)
    if (found) {
        momentId = found.id
        return
    }

    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    const archive =
        archives?.find((a) => a.name === 'RefCards')?.id ??
        (await post<{ id: string }>(req, '/api/v1/archives', { name: 'RefCards' })).id

    const canvas = await post<{ id: string }>(req, '/api/v1/canvases', { title: BOARD })
    const first = await post<{ id: string }>(req, `/api/v1/canvases/${canvas.id}/nodes`, {
        kind: 'sticky',
        x: 40,
        y: 40,
        w: 180,
        h: 160,
        content: 'one',
        style: JSON.stringify({ color: '#f6e58d' }),
    })
    const second = await post<{ id: string }>(req, `/api/v1/canvases/${canvas.id}/nodes`, {
        kind: 'sticky',
        x: 320,
        y: 200,
        w: 180,
        h: 160,
        content: 'two',
        style: JSON.stringify({ color: '#7ed6df' }),
    })
    await post(req, `/api/v1/canvases/${canvas.id}/edges`, { from_node: first.id, to_node: second.id })

    momentId = (
        await post<{ id: string }>(req, '/api/v1/moments', {
            archive_id: archive,
            title: MOMENT,
            content: `A board:\n\n::canvas:${canvas.id}::`,
            tag_ids: [],
        })
    ).id
}

const card = (page: Page) => page.locator(`[data-moment-id="${momentId}"]`)
const thumbnail = (page: Page) => card(page).getByTestId('canvas-thumbnail')

async function setPreview(page: Page, on: boolean) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const box = page.locator('label').filter({ hasText: 'Canvas Reference Previews' }).first().locator('input')
    if ((await box.isChecked()) !== on) await box.click()
    // Escape rather than a Close button: several panels render one.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-tabs')).toHaveCount(0)
}

test.describe('canvas reference preview', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('is off by default, and draws the board when turned on', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        await expect(card(page).getByText(BOARD)).toBeVisible()
        await expect(thumbnail(page)).toHaveCount(0)

        await setPreview(page, true)

        await expect(thumbnail(page)).toBeVisible()
        // One rectangle per node and one line per edge, and the node count the
        // card always showed is still there.
        await expect(thumbnail(page).locator('rect')).toHaveCount(2)
        await expect(thumbnail(page).locator('line')).toHaveCount(1)
        await expect(card(page).getByText('2 nodes')).toBeVisible()
    })
})

test.describe('canvas reference preview, mobile', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('fits inside the reader', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.addInitScript(() =>
            localStorage.setItem('athena-prefs', JSON.stringify({ canvasEmbedPreview: true })),
        )
        await page.goto('/')

        // The swiper card renders markdown only, so the reference lives in the
        // focused reader at this width (mobile-preview.spec.ts).
        const heading = page.getByRole('heading', { name: MOMENT })
        await expect(heading).toBeVisible()
        const box = (await heading.boundingBox())!
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await expect(page.getByTitle('Edit this moment')).toBeVisible()

        const shown = page.getByTestId('canvas-thumbnail').first()
        await expect(shown).toBeVisible()
        const rect = (await shown.boundingBox())!
        expect(rect.x).toBeGreaterThanOrEqual(0)
        expect(rect.x + rect.width).toBeLessThanOrEqual(390)
    })
})

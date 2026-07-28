import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Inline link previews: the card replaces the URL rather than stacking after the
// body. The parsing rules are unit-tested in src/linkPreviews.test.ts and
// src/components/MomentBody.test.ts; what only holds together end to end is that
// the pref reaches MomentBody, that the URL text really is gone from the
// rendered moment, and that a run of links lays out as one row of real boxes.

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

// The real endpoint scrapes the open internet, which is neither offline-safe nor
// deterministic. Every preview here resolves instantly from its own URL.
async function stubPreviews(page: Page): Promise<void> {
    await page.route('**/api/v1/previews*', async (route) => {
        const url = new URL(route.request().url()).searchParams.get('url') || ''
        const host = url.replace(/^https?:\/\//, '').split('/')[0]
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                url,
                title: `Title for ${host}`,
                description: `A description belonging to ${host}.`,
                image_url: '',
                scraped_at: new Date().toISOString(),
            }),
        })
    })
}

// addInitScript re-runs on every navigation, which is what we want: the pref has
// to be in place before the first paint of each load.
async function setInlinePref(page: Page, on: boolean, perRow = 3): Promise<void> {
    await page.addInitScript(
        ([enabled, n]) => {
            const raw = localStorage.getItem('athena-prefs')
            const prefs = raw ? JSON.parse(raw) : {}
            prefs.inlineLinkPreviews = enabled
            prefs.inlineLinkPreviewsPerRow = n
            localStorage.setItem('athena-prefs', JSON.stringify(prefs))
        },
        [on, perRow] as const,
    )
}

// Its own archive and titles: the e2e database is shared across spec files.
async function seed(page: Page, title: string, content: string): Promise<void> {
    const req = page.request
    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    const existing = archives?.find((a) => a.name === 'Linkage')
    const archive = existing ?? (await post<{ id: string }>(req, '/api/v1/archives', { name: 'Linkage' }))
    const moments = (await (await req.get('/api/v1/moments')).json()) as { title: string }[]
    if (moments.some((m) => m.title === title)) return
    await post(req, '/api/v1/moments', { archive_id: archive.id, title, content, tag_ids: [] })
}

const card = (page: Page) => page.getByTestId('link-preview')
const momentCard = (page: Page, title: string) =>
    page.getByTestId('moment-card').filter({ hasText: title })

test.describe('inline link previews', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('the card replaces the url and the text resumes below it', async ({ page }) => {
        await signIn(page)
        await stubPreviews(page)
        await setInlinePref(page, true)
        await seed(page, 'Split moment', 'before the link https://alpha.example after the link')
        await page.goto('/')

        const moment = momentCard(page, 'Split moment')
        await expect(moment.getByTestId('link-preview')).toHaveCount(1)

        // The whole point: the URL is gone from the rendered text.
        await expect(moment).not.toContainText('https://alpha.example')
        await expect(moment).toContainText('before the link')
        await expect(moment).toContainText('after the link')

        // A row of one gets the full-width treatment.
        await expect(moment.getByTestId('link-preview')).toHaveAttribute('data-layout', 'wide')

        // Preview sits between the two halves, not after both.
        const preview = await moment.getByTestId('link-preview').boundingBox()
        const trailing = await moment.getByText('after the link').boundingBox()
        expect(preview!.y).toBeLessThan(trailing!.y)
    })

    test('three links in a row become three cards on one line', async ({ page }) => {
        await signIn(page)
        await stubPreviews(page)
        await setInlinePref(page, true, 3)
        await seed(page, 'Row moment', 'https://one.example https://two.example https://three.example')
        await page.goto('/')

        const moment = momentCard(page, 'Row moment')
        const cards = moment.getByTestId('link-preview')
        await expect(cards).toHaveCount(3)
        await expect(cards.first()).toHaveAttribute('data-layout', 'tile')

        const boxes = await cards.all()
        const rects = await Promise.all(boxes.map((c) => c.boundingBox()))
        // Same line, left to right, and actually sharing the width rather than
        // three full-width cards stacked.
        expect(rects[0]!.y).toBeCloseTo(rects[1]!.y, 0)
        expect(rects[1]!.y).toBeCloseTo(rects[2]!.y, 0)
        expect(rects[0]!.x).toBeLessThan(rects[1]!.x)
        expect(rects[1]!.x).toBeLessThan(rects[2]!.x)

        const row = await moment.getByTestId('link-preview-row').boundingBox()
        expect(rects[0]!.width).toBeLessThan(row!.width * 0.5)
    })

    test('the per-row setting caps the line', async ({ page }) => {
        await signIn(page)
        await stubPreviews(page)
        await setInlinePref(page, true, 2)
        await seed(page, 'Capped moment', 'https://four.example https://five.example https://six.example')
        await page.goto('/')

        const cards = momentCard(page, 'Capped moment').getByTestId('link-preview')
        await expect(cards).toHaveCount(3)
        const rects = await Promise.all((await cards.all()).map((c) => c.boundingBox()))
        expect(rects[0]!.y).toBeCloseTo(rects[1]!.y, 0)
        // Third wrapped to its own line, and stretched to fill it.
        expect(rects[2]!.y).toBeGreaterThan(rects[0]!.y)
        expect(rects[2]!.width).toBeGreaterThan(rects[0]!.width * 1.5)
    })

    test('with the setting off, the url stays and the card goes to the bottom', async ({ page }) => {
        await signIn(page)
        await stubPreviews(page)
        await setInlinePref(page, false)
        await seed(page, 'Stacked moment', 'before the link https://seven.example after the link')
        await page.goto('/')

        const moment = momentCard(page, 'Stacked moment')
        await expect(moment.getByTestId('link-preview')).toHaveCount(1)
        await expect(moment).toContainText('https://seven.example')

        const preview = await moment.getByTestId('link-preview').boundingBox()
        const trailing = await moment.getByText('after the link').boundingBox()
        expect(preview!.y).toBeGreaterThan(trailing!.y)
    })

    test('a markdown link still gets its card in the stack below', async ({ page }) => {
        await signIn(page)
        await stubPreviews(page)
        await setInlinePref(page, true)
        await seed(page, 'Labelled moment', 'read [the manual](https://eight.example) when you can')
        await page.goto('/')

        const moment = momentCard(page, 'Labelled moment')
        await expect(moment.getByRole('link', { name: 'the manual' })).toBeVisible()
        // Not inlined, so it falls through to the stack rather than vanishing.
        await expect(moment.getByTestId('link-preview')).toHaveCount(1)
        await expect(moment.getByTestId('link-preview')).toHaveAttribute('data-layout', 'compact')
    })
})

// The mobile swiper card renders markdown only and is pointer-events: none by
// design (mobile-preview.spec.ts), so previews are a focused-reader surface
// here, not a feed one. Its own archive so the filtered swiper holds one card.
test.describe('inline link previews on mobile', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('a row of cards fits the reader without overflowing it', async ({ page }) => {
        await signIn(page)
        await stubPreviews(page)
        await setInlinePref(page, true, 3)
        await seed(page, 'Narrow moment', 'https://one.example https://two.example https://three.example')
        await page.goto('/')

        // Seeded inside this test, so it is the newest moment and the swiper
        // opens on it. The visibility check fails loudly if that stops holding.
        const heading = page.getByRole('heading', { name: 'Narrow moment' })
        await expect(heading).toBeVisible()
        const box = await heading.boundingBox()
        await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
        await expect(page.getByTitle('Edit this moment')).toBeVisible()

        const cards = page.getByTestId('link-preview')
        await expect(cards).toHaveCount(3)

        const row = await page.getByTestId('link-preview-row').first().boundingBox()
        const rects = await Promise.all((await cards.all()).map((c) => c.boundingBox()))
        for (const r of rects) {
            expect(r!.x).toBeGreaterThanOrEqual(row!.x - 1)
            expect(r!.x + r!.width).toBeLessThanOrEqual(row!.x + row!.width + 1)
        }

        // Three across a 390px screen is three columns of ellipsis, so the pref
        // gives way to the screen: one full-width card per line, stacked.
        await expect(cards.first()).toHaveAttribute('data-layout', 'wide')
        expect(rects[0]!.y).toBeLessThan(rects[1]!.y)
        expect(rects[1]!.y).toBeLessThan(rects[2]!.y)
        expect(rects[0]!.width).toBeCloseTo(row!.width, 0)
    })
})

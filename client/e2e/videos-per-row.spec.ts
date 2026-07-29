import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Videos Per Row: uploaded videos used to get a full-width player each, so
// three clips in one moment were three screens of scrolling. The pref lets a
// run of them share a row, the way a run of link previews does, and one is
// still the full-width player it always was.
//
// As in video-preview.spec.ts, the uploaded bytes are never decoded. The file
// name is what the server resolves a MIME type from, and the MIME type is what
// decides that these render as players at all.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

async function upload(req: APIRequestContext, name: string, mimeType: string): Promise<string> {
    const res = await req.post('/api/v1/assets', {
        multipart: { file: { name, mimeType, buffer: Buffer.from('not real media, and never decoded') } },
    })
    if (!res.ok()) throw new Error(`upload ${name} -> ${res.status()} ${await res.text()}`)
    return ((await res.json()) as { id: string }).id
}

const TITLE = 'Three clips and a file'

// One moment holding three videos back to back, then a non-video, so both the
// grouping and what breaks it are on screen at once.
async function seed(page: Page, title = TITLE) {
    const req = page.request
    const existing = (await (await req.get('/api/v1/moments')).json()) as { title: string }[] | null
    if (existing?.some((m) => m.title === title)) return

    // Archive names are unique, so the second moment reuses the first's rather
    // than trying to create it again.
    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    const archive =
        archives?.find((a) => a.name === 'Rows') ??
        ((await (await req.post('/api/v1/archives', { data: { name: 'Rows' } })).json()) as { id: string })
    const parts: string[] = []
    for (const name of ['one.mp4', 'two.mp4', 'three.mp4']) {
        parts.push(`[${name}](/api/v1/assets/${await upload(req, name, 'video/mp4')})`)
    }
    parts.push(`[notes.zzz](/api/v1/assets/${await upload(req, 'notes.zzz', 'application/octet-stream')})`)

    const res = await req.post('/api/v1/moments', {
        data: { archive_id: archive.id, title, content: parts.join('\n\n'), tag_ids: [] },
    })
    if (!res.ok()) throw new Error(`POST /api/v1/moments -> ${res.status()} ${await res.text()}`)
}

const card = (page: Page) => page.getByTestId('moment-card').filter({ hasText: TITLE })

async function setVideosPerRow(page: Page, n: number) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByTestId('videos-per-row').getByRole('button', { name: `${n} videos per row` }).click()
    // Escape, not the Close button: chat and every sheet render one too, so
    // which one is "first" depends on what else is on the page.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-tabs')).toHaveCount(0)
}

// The four attachment cards in this moment, in content order.
async function boxes(page: Page) {
    const items = card(page).getByTestId('attachment')
    await expect(items).toHaveCount(4)
    const out = []
    for (let i = 0; i < 4; i++) out.push((await items.nth(i).boundingBox())!)
    return out
}

test.describe('videos per row', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('defaults to one full-width player each', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        await expect(card(page).locator('video')).toHaveCount(3)

        const [one, two, three, file] = await boxes(page)
        // Every card starts at the same x and is the same width: a column.
        for (const box of [two, three, file]) {
            expect(box.x).toBeCloseTo(one.x, 0)
            expect(box.width).toBeCloseTo(one.width, 0)
        }
        // And each sits below the last.
        expect(two.y).toBeGreaterThan(one.y + one.height - 1)
    })

    test('two per row pairs the first two and widens the leftover', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        await expect(card(page).locator('video')).toHaveCount(3)
        await setVideosPerRow(page, 2)

        const [one, two, three, file] = await boxes(page)

        // Side by side, on the same line, splitting the width between them.
        expect(two.y).toBeCloseTo(one.y, 0)
        expect(two.x).toBeGreaterThan(one.x + one.width - 1)
        expect(one.width).toBeLessThan(three.width * 0.6)

        // The third has nobody to pair with, so it takes the full width rather
        // than sitting as a half-width stub.
        expect(three.y).toBeGreaterThan(one.y + one.height - 1)
        expect(three.x).toBeCloseTo(one.x, 0)

        // The non-video keeps its own line: a run of videos is what groups.
        expect(file.width).toBeCloseTo(three.width, 0)
        expect(file.y).toBeGreaterThan(three.y + three.height - 1)
    })

    test('three per row puts all three on one line', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        await expect(card(page).locator('video')).toHaveCount(3)
        await setVideosPerRow(page, 3)

        const [one, two, three, file] = await boxes(page)
        expect(two.y).toBeCloseTo(one.y, 0)
        expect(three.y).toBeCloseTo(one.y, 0)
        expect(one.width).toBeLessThan(file.width * 0.4)
    })
})

// The mobile swiper card renders markdown only and is pointer-events: none by
// design (mobile-preview.spec.ts), so the players live in the focused reader
// here rather than in the feed.
test.describe('videos per row, mobile', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    const PHONE_TITLE = 'Clips on a phone'

    test('a phone stays one across however high the pref is set', async ({ page }) => {
        await signIn(page)
        // Seeded here so it is the newest moment and the swiper opens on it.
        await seed(page, PHONE_TITLE)
        await page.addInitScript(() => localStorage.setItem('athena-prefs', JSON.stringify({ videosPerRow: 4 })))
        await page.goto('/')

        const heading = page.getByRole('heading', { name: PHONE_TITLE })
        await expect(heading).toBeVisible()
        const box = (await heading.boundingBox())!
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await expect(page.getByTitle('Edit this moment')).toBeVisible()

        const items = page.getByTestId('attachment')
        await expect(items.first()).toBeVisible()

        const first = (await items.first().boundingBox())!
        const second = (await items.nth(1).boundingBox())!
        // Three tiles across 390px would be thumbnails, so the row limit gives
        // way to the screen: still a column.
        expect(second.y).toBeGreaterThan(first.y + first.height - 1)
        expect(second.width).toBeCloseTo(first.width, 0)
    })
})

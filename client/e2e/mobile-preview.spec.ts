import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// The mobile swiper card renders the moment's body as markdown rather than as a
// flattened first paragraph (issue #15).
//
// Two things have to hold at once, and they pull against each other: the card
// has to show real formatting, and the whole card has to stay one swipe/tap
// target. MomentSwiper abandons its gesture the moment a press lands on a
// button/a/input, so a rendered link is exactly the shape that would break it.
// The card's pointer-events: none is what reconciles them, and the gesture tests
// below are aimed straight at rendered content for that reason.

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

const SHOWCASE = 'Preview showcase'
const TARGET = 'Preview embed target'

// Its own archive, so filtering to it leaves exactly these two cards and the
// swiper's index is predictable. Idempotent: the database is wiped once per
// run, not per test.
let embeddedId = ''
async function seed(page: Page) {
    const req = page.request
    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    const existing = archives?.find((a) => a.name === 'PREVIEW')
    if (existing) {
        const found = (await (await req.get(`/api/v1/moments?archive=${existing.id}`)).json()) as
            | { moments?: { id: string; title: string }[] }
            | { id: string; title: string }[]
        const list = Array.isArray(found) ? found : (found.moments ?? [])
        embeddedId = list.find((m) => m.title === TARGET)?.id ?? ''
        return
    }

    const arch = await post<{ id: string }>(req, '/api/v1/archives', { name: 'PREVIEW' })
    const target = await post<{ id: string }>(req, '/api/v1/moments', {
        archive_id: arch.id,
        title: TARGET,
        content: 'Nothing here should be fetched by a preview card.',
        tag_ids: [],
    })
    embeddedId = target.id

    // Deliberately spans everything the old plain-text snippet threw away: a
    // heading, emphasis, a link, a list, and a second paragraph past the blank
    // line where truncation used to stop.
    await post(req, '/api/v1/moments', {
        archive_id: arch.id,
        title: SHOWCASE,
        content: [
            '## Preview heading',
            '',
            'First paragraph with **bold text** and a [link to example](https://example.com).',
            '',
            'Second paragraph proves the cut-off is gone.',
            '',
            '- list item alpha',
            '- list item beta',
            '',
            `[[${target.id}]]`,
        ].join('\n'),
        tag_ids: [],
    })
}

// Filter to this spec's archive and settle on the newest card, which is the
// showcase moment.
async function openPreviewFeed(page: Page) {
    await page.goto('/')
    await page.getByRole('button', { name: 'Archives' }).click()
    await page.getByRole('button', { name: 'PREVIEW' }).click()
    await expect(page.getByRole('heading', { name: 'Preview heading' })).toBeVisible()
}

const card = (page: Page) => page.locator('.moment-preview')

test.describe('mobile preview card', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('renders markdown instead of a flattened first paragraph', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await openPreviewFeed(page)

        const active = card(page).first()
        // Real elements, not just the text: the old snippet stripped the syntax
        // characters, so asserting on text alone would have passed against it.
        await expect(active.locator('h2')).toHaveText('Preview heading')
        await expect(active.locator('strong')).toHaveText('bold text')
        await expect(active.locator('li').first()).toHaveText('list item alpha')

        // Past the first blank line, which is where the old preview stopped.
        await expect(active.getByText('Second paragraph proves the cut-off is gone.')).toBeVisible()
    })

    test('a tap on a rendered link opens the reader instead of following it', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await openPreviewFeed(page)

        const link = card(page).first().locator('a').first()
        await expect(link).toHaveAttribute('href', 'https://example.com')

        // Not link.click(): the card is pointer-events: none, so what matters is
        // what a finger landing on those coordinates does.
        const box = await link.boundingBox()
        expect(box).not.toBeNull()
        await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)

        await expect(page.getByTitle('Edit this moment')).toBeVisible()
        await expect(page).toHaveURL(/localhost/)
    })

    test('a swipe that starts on rendered text still changes card', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await openPreviewFeed(page)

        const counter = page.getByText('1 / 2')
        await expect(counter).toBeVisible()

        const box = await card(page).first().locator('h2').boundingBox()
        expect(box).not.toBeNull()
        const y = box!.y + box!.height / 2
        await page.mouse.move(box!.x + box!.width - 10, y)
        await page.mouse.down()
        await page.mouse.move(box!.x - 120, y, { steps: 12 })
        await page.mouse.up()

        await expect(page.getByText('2 / 2')).toBeVisible()
    })

    test('embedded moments are not fetched for the card', async ({ page }) => {
        await signIn(page)
        await seed(page)

        const hits: string[] = []
        page.on('request', (r) => {
            if (r.url().includes(`/api/v1/moments/${embeddedId}`)) hits.push(r.url())
        })

        await openPreviewFeed(page)
        // The swiper mounts a card per loaded moment, so one live embed per card
        // is a burst of requests, not one. The token is dropped instead.
        await expect(card(page).first().getByText('Moment unavailable')).toHaveCount(0)
        expect(hits).toEqual([])
    })
})

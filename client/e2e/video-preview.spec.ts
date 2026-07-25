import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Video attachments preview like images: the moment body shows a player rather
// than a download chip, and opening one hands the Lightbox every video in that
// block so you can move between them.
//
// The uploads here are not real media. The bytes are never decoded by anything
// under test. What matters is the file *name*, since that is what the server
// resolves a MIME type from, and the MIME type is what decides how the client
// renders it.

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

async function post<T>(req: APIRequestContext, url: string, data: unknown): Promise<T> {
    const res = await req.post(url, { data })
    if (!res.ok()) throw new Error(`POST ${url} -> ${res.status()} ${await res.text()}`)
    return (await res.json()) as T
}

test.describe('video previews', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('plays inline and opens in the lightbox, carrying its siblings', async ({ page }) => {
        await signIn(page)
        const req = page.request
        const archive = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Clips' })

        // .mov is the case the server used to record as application/octet-stream.
        // It is absent from Go's built-in table and the runtime image has no
        // MIME database to fall back on. It is also what phones record.
        const first = await upload(req, 'first.mov', 'video/quicktime')
        const second = await upload(req, 'second.mp4', 'video/mp4')

        // The server has to identify it as video without help from a host MIME
        // database, or nothing downstream renders a player.
        const meta = (await (await req.get(`/api/v1/assets/${first}/meta`)).json()) as { mime_type: string }
        expect(meta.mime_type, '.mov must resolve to a video type').toBe('video/quicktime')

        await post(req, '/api/v1/moments', {
            archive_id: archive.id,
            title: 'Two clips',
            content: `[first.mov](/api/v1/assets/${first})\n\n[second.mp4](/api/v1/assets/${second})`,
            tag_ids: [],
        })

        await page.goto('/')
        // Scope to this moment's own card: the suite shares one server, so the
        // feed also holds whatever the other specs created.
        const card = page.getByTestId('moment-card').filter({ hasText: 'Two clips' })
        await expect(card).toBeVisible()

        // Inline players, not download chips.
        const players = card.locator('video')
        await expect(players).toHaveCount(2)
        await expect(players.first()).toHaveAttribute('src', `/api/v1/assets/${first}`)

        // Opening one carries both, in the order they appear in the moment.
        await card.getByRole('button', { name: 'Expand' }).first().click()
        const lightbox = page.locator('video').last()
        await expect(lightbox).toBeVisible()
        await expect(page.getByText('first.mov').first()).toBeVisible()
        await expect(page.getByText('1 / 2')).toBeVisible()

        await page.getByRole('button', { name: 'Next', exact: true }).click()
        await expect(page.getByText('2 / 2')).toBeVisible()

        await page.keyboard.press('Escape')
        await expect(page.getByText('2 / 2')).toBeHidden()
    })

    test('leaves a non-video attachment as a download chip', async ({ page }) => {
        await signIn(page)
        const req = page.request
        const archive = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Files' })

        const id = await upload(req, 'notes.zzz', 'application/octet-stream')
        await post(req, '/api/v1/moments', {
            archive_id: archive.id,
            title: 'Just a file',
            content: `[notes.zzz](/api/v1/assets/${id})`,
            tag_ids: [],
        })

        await page.goto('/')
        const card = page.getByTestId('moment-card').filter({ hasText: 'Just a file' })
        await expect(card).toBeVisible()
        await expect(card.getByRole('link', { name: 'Download' }).first()).toBeVisible()
        await expect(card.locator('video')).toHaveCount(0)
        await expect(card.getByRole('button', { name: 'Expand' })).toHaveCount(0)
    })
})

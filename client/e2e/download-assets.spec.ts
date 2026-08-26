import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Every uploaded asset can be downloaded: the chip on a non-image attachment
// saves the original file, and an inline image carries a download button of
// its own (the full-screen viewer keeps its). The regression this guards is
// the router's anchor interceptor: an anchor without a download attribute is
// treated as a route change and the app re-renders in place, so the chip and
// the image button must carry one and the click must produce a download.

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
        multipart: { file: { name, mimeType, buffer: Buffer.from('download test bytes') } },
    })
    if (!res.ok()) throw new Error(`upload ${name} -> ${res.status()} ${await res.text()}`)
    return ((await res.json()) as { id: string }).id
}

async function post<T>(req: APIRequestContext, url: string, data: unknown): Promise<T> {
    const res = await req.post(url, { data })
    if (!res.ok()) throw new Error(`POST ${url} -> ${res.status()} ${await res.text()}`)
    return (await res.json()) as T
}

test.describe('asset downloads', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('a non-image attachment downloads from its chip', async ({ page }) => {
        await signIn(page)
        const req = page.request
        const archive = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Downloads' })
        const id = await upload(req, 'notes.zzz', 'application/octet-stream')
        await post(req, '/api/v1/moments', {
            archive_id: archive.id,
            title: 'Downloadable file',
            content: `[notes.zzz](/api/v1/assets/${id})`,
            tag_ids: [],
        })

        await page.goto('/')
        const card = page.getByTestId('moment-card').filter({ hasText: 'Downloadable file' })
        await expect(card).toBeVisible()
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            card.getByRole('link', { name: 'Download' }).click(),
        ])
        expect(download.suggestedFilename()).toBe('notes.zzz')
    })

    test('an image downloads from its inline button and the lightbox', async ({ page }) => {
        await signIn(page)
        const req = page.request
        const archive = await post<{ id: string }>(req, '/api/v1/archives', { name: 'ImageDownloads' })
        const id = await upload(req, 'pixel.png', 'image/png')
        await post(req, '/api/v1/moments', {
            archive_id: archive.id,
            title: 'Downloadable image',
            content: `![pixel.png](/api/v1/assets/${id})`,
            tag_ids: [],
        })

        await page.goto('/')
        const card = page.getByTestId('moment-card').filter({ hasText: 'Downloadable image' })
        await expect(card).toBeVisible()

        const [inline] = await Promise.all([
            page.waitForEvent('download'),
            card.getByLabel('Download image').click(),
        ])
        expect(inline.suggestedFilename()).toBe('pixel.png')

        // The full-screen viewer keeps its download too.
        await card.locator('img').click()
        const lightbox = page.getByTestId('lightbox')
        await expect(lightbox).toBeVisible()
        const [viaLightbox] = await Promise.all([
            page.waitForEvent('download'),
            lightbox.getByRole('link', { name: 'Download image' }).click(),
        ])
        expect(viaLightbox.suggestedFilename()).toBe('pixel.png')
    })
})

test.describe('asset downloads on a phone', () => {
    // The swiper card is one tap target and hides everything interactive in it
    // (pointer-events: none), so the download button lives in the reader a tap
    // opens: tap the card, then the button is reachable without a hover.
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('the image download button works in the reader', async ({ page }) => {
        await signIn(page)
        const req = page.request
        const archive = await post<{ id: string }>(req, '/api/v1/archives', { name: 'PhoneDownloads' })
        const id = await upload(req, 'pixel.png', 'image/png')
        await post(req, '/api/v1/moments', {
            archive_id: archive.id,
            title: 'Phone image',
            content: `![pixel.png](/api/v1/assets/${id})`,
            tag_ids: [],
        })

        // Scope the feed to this spec's archive so the first card is ours.
        await page.goto('/')
        await page.getByRole('button', { name: 'Archives' }).click()
        await page.getByRole('button', { name: 'PhoneDownloads' }).click()

        const preview = page.locator('.moment-preview').first()
        await expect(preview).toBeVisible()

        // A finger on the card opens the reader; the card is pointer-events:
        // none, so aim at its coordinates the way a tap would.
        const box = await preview.boundingBox()
        expect(box).not.toBeNull()
        await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
        await expect(page.getByTitle('Edit this moment')).toBeVisible()

        // The reader renders the full body with the live download button; the
        // preview card's copy is hidden by CSS, so :visible picks the reader's.
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('a[aria-label="Download image"]:visible').click(),
        ])
        expect(download.suggestedFilename()).toBe('pixel.png')
    })
})

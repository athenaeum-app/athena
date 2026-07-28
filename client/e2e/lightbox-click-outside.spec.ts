import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Clicking the dark background around an enlarged image closes it. The outer
// wrapper already had a "click on yourself, not a child" check, but the stage
// (the flex box that centers the image, with padding on every side) is a
// separate element the click can also land on, and it had no check of its
// own: a click anywhere in that padding silently did nothing.

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

// A 1x1 GIF: real bytes, so the browser actually decodes and lays out an
// <img>, which is what gives the stage real padding around it to click into.
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64')

test.describe('lightbox click outside', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('closes on a click in the stage padding around the image', async ({ page }) => {
        await signIn(page)
        const req = page.request
        const archive = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Pixels' })
        const asset = await req.post('/api/v1/assets', {
            multipart: { file: { name: 'dot.gif', mimeType: 'image/gif', buffer: PIXEL_GIF } },
        })
        const { id } = (await asset.json()) as { id: string }
        await post(req, '/api/v1/moments', {
            archive_id: archive.id,
            title: 'One tiny image',
            content: `![a dot](/api/v1/assets/${id})`,
            tag_ids: [],
        })

        await page.goto('/')
        const card = page.getByTestId('moment-card').filter({ hasText: 'One tiny image' })
        await card.locator('img').click()
        const lightbox = page.getByTestId('lightbox')
        await expect(lightbox.getByRole('button', { name: 'Close', exact: true })).toBeVisible()

        // Top-left corner of the stage: inside its padding, never inside the
        // small centered image itself.
        const box = await page.getByTestId('lightbox-stage').boundingBox()
        await page.mouse.click(box!.x + 10, box!.y + 10)

        await expect(lightbox.getByRole('button', { name: 'Close', exact: true })).toBeHidden()
    })

    test('a click on the image itself does not close it', async ({ page }) => {
        await signIn(page)
        const req = page.request
        const archive = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Pixels Two' })
        const asset = await req.post('/api/v1/assets', {
            multipart: { file: { name: 'dot2.gif', mimeType: 'image/gif', buffer: PIXEL_GIF } },
        })
        const { id } = (await asset.json()) as { id: string }
        await post(req, '/api/v1/moments', {
            archive_id: archive.id,
            title: 'Another tiny image',
            content: `![a dot](/api/v1/assets/${id})`,
            tag_ids: [],
        })

        await page.goto('/')
        const card = page.getByTestId('moment-card').filter({ hasText: 'Another tiny image' })
        await card.locator('img').click()
        const lightbox = page.getByTestId('lightbox')
        await expect(lightbox.getByRole('button', { name: 'Close', exact: true })).toBeVisible()

        await page.getByTestId('lightbox-stage').locator('img').click()
        await expect(lightbox.getByRole('button', { name: 'Close', exact: true })).toBeVisible()

        await page.keyboard.press('Escape')
    })
})

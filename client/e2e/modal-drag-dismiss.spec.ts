import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// A drag that starts inside a dialog and ends over the backdrop must not close
// it. The browser fires `click` on the nearest common ancestor of press and
// release, which for that gesture is the backdrop itself, so a dialog that
// only checks the click target reads a released text selection as a click on
// the backdrop and closes under the user's hand. Projects did exactly that,
// while every other dialog went through the shared guard.

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

// A 1x1 GIF: real bytes, so the browser decodes and lays out an <img>, which
// is what gives the stage real padding around it.
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64')

type Box = { x: number; y: number; width: number; height: number }

// Press in the middle of `from`, sweep out of it, release at `to`. The
// intermediate moves matter: without them the browser never treats the
// gesture as a drag.
async function dragOut(page: Page, from: Box, to: { x: number; y: number }): Promise<void> {
    const cx = from.x + from.width / 2
    const cy = from.y + from.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx, cy - 30, { steps: 5 })
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
}

test.describe('drag out of a dialog', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('a card modal in Projects survives a drag released on the backdrop', async ({ page }) => {
        await signIn(page)
        const req = page.request
        const project = await post<{ id: string }>(req, '/api/v1/projects', { title: 'Drag Harness' })
        const ms = await post<{ id: string }>(req, `/api/v1/projects/${project.id}/milestones`, {
            title: 'On the bench',
        })
        await post(req, `/api/v1/projects/${project.id}/cards`, {
            milestone_id: ms.id,
            titles: ['Sew the octavo set'],
        })

        await page.goto('/')
        await page.getByRole('button', { name: 'Projects', exact: true }).first().click()
        await page.getByText('Drag Harness').click()
        await page.getByTitle('Board view').click()

        const card = page.getByText('Sew the octavo set').first()
        await card.click()

        const panel = page.getByTestId('project-card-modal')
        await expect(panel).toBeVisible()

        await dragOut(page, (await panel.boundingBox())!, { x: 4, y: 4 })
        await expect(panel).toBeVisible()

        // A clean click on the backdrop still closes it.
        await page.mouse.click(4, 4)
        await expect(panel).toBeHidden()
    })

    test('the lightbox survives a drag released on the stage padding', async ({ page }) => {
        await signIn(page)
        const req = page.request
        const archive = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Drag Pixels' })
        const upload = async (name: string) => {
            const res = await req.post('/api/v1/assets', {
                multipart: { file: { name, mimeType: 'image/gif', buffer: PIXEL_GIF } },
            })
            return ((await res.json()) as { id: string }).id
        }
        const [a, b] = [await upload('one.gif'), await upload('two.gif')]
        await post(req, '/api/v1/moments', {
            archive_id: archive.id,
            title: 'A dot to drag off',
            content: `![one](/api/v1/assets/${a})

![two](/api/v1/assets/${b})`,
            tag_ids: [],
        })

        await page.goto('/')
        await page.getByTestId('moment-card').filter({ hasText: 'A dot to drag off' }).locator('img').first().click()
        const close = page.getByTestId('lightbox').getByRole('button', { name: 'Close', exact: true })
        await expect(close).toBeVisible()

        // Every pixel of the lightbox is covered by its bar, stage and dots, so
        // the backdrop here is the stage padding around the image. The drag
        // starts on the Next arrow rather than the image itself: an <img> is
        // natively draggable, so pressing on one starts a file drag and the
        // browser never fires the click this guard exists to filter.
        const stage = page.getByTestId('lightbox-stage')
        const stageBox = (await stage.boundingBox())!
        const next = stage.getByRole('button', { name: 'Next' })
        await dragOut(page, (await next.boundingBox())!, { x: stageBox.x + 10, y: stageBox.y + 10 })
        await expect(close).toBeVisible()

        // A clean click in that same padding still closes it.
        await page.mouse.click(stageBox.x + 10, stageBox.y + 10)
        await expect(close).toBeHidden()
    })
})

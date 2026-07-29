import { test, expect, type Page } from '@playwright/test'

// Reaching for the chat scrollbar used to open the long-press action sheet.
// The bar is an overlay on Windows, painted over the message beside it, so a
// press that misses by a few pixels lands on the message, and the drag that
// follows never sends another move to that message: nothing cancelled the
// hold, so 450ms later a full-screen sheet appeared. It could not even be
// dismissed by releasing, because backdropDismiss only closes on a press that
// began on the backdrop, and this one began before the sheet existed.
//
// The scrollbar itself cannot be driven here (a headless scrollbar swallows
// synthesized mouse input without scrolling), so this covers the gesture that
// actually broke: press on the message, drag away, keep holding.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

const MESSAGE = 'Message the scrollbar sits beside'

async function seed(page: Page) {
    const existing = (await (await page.request.get('/api/v1/chat')).json()) as { content: string }[] | null
    if (existing?.some((m) => m.content === MESSAGE)) return
    const res = await page.request.post('/api/v1/chat', { data: { content: MESSAGE } })
    if (!res.ok()) throw new Error(`POST /api/v1/chat -> ${res.status()} ${await res.text()}`)
}

const panel = (page: Page) => page.getByTestId('chat-panel')
const sheet = (page: Page) => page.getByTestId('action-sheet')

async function openChat(page: Page) {
    await page.goto('/')
    await page.getByRole('button', { name: 'Chat' }).first().click()
    await expect(panel(page).getByText(MESSAGE)).toBeVisible()
}

test.describe('chat message long press', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('a press dragged off the message does not open the action sheet', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await openChat(page)

        const box = (await panel(page).getByText(MESSAGE).boundingBox())!
        // Start at the far right of the row, where the scrollbar overlays it.
        await page.mouse.move(box.x + box.width - 2, box.y + 3)
        await page.mouse.down()
        // One jump, as a real drag's first move often is: the pointer lands
        // well clear of the message and never returns to it.
        await page.mouse.move(box.x + box.width - 2, box.y + 200)
        await page.waitForTimeout(800)

        await expect(sheet(page)).toHaveCount(0)
        await page.mouse.up()
        await expect(sheet(page)).toHaveCount(0)
    })

    test('a press held still on the message still opens it', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await openChat(page)

        const box = (await panel(page).getByText(MESSAGE).boundingBox())!
        await page.mouse.move(box.x + 5, box.y + 3)
        await page.mouse.down()
        await page.waitForTimeout(700)

        // The touch affordance is unchanged: this is the same gesture the
        // mobile shell relies on for reply/edit/delete.
        await expect(sheet(page)).toBeVisible()
        await page.mouse.up()
    })
})

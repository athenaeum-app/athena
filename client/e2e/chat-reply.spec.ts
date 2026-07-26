import { test, expect, type Page } from '@playwright/test'

// Reply puts the message into the composer as a blockquote. quoteFor's own
// shaping is covered by unit tests; what needs a browser is that the action is
// reachable, reaches the composer it belongs to, and does not clobber what is
// already typed there.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

const GREETING = 'Hello from the reply spec'

// Idempotent: the throwaway database is wiped once per run, not per test.
async function seed(page: Page) {
    const existing = (await (await page.request.get('/api/v1/chat')).json()) as { content: string }[] | null
    if (existing?.some((m) => m.content === GREETING)) return
    const res = await page.request.post('/api/v1/chat', { data: { content: GREETING } })
    if (!res.ok()) throw new Error(`POST /api/v1/chat -> ${res.status()} ${await res.text()}`)
}

// Scoped to the panel: the Menu column's chat preview widget shows the same
// message text, and the composer only exists inside the panel.
const panel = (page: Page) => page.getByTestId('chat-panel')
const composer = (page: Page) => panel(page).locator('textarea').first()
const replyButton = (page: Page) => panel(page).getByRole('button', { name: /^Reply to / }).first()

async function openChat(page: Page) {
    await page.goto('/')
    await page.getByRole('button', { name: 'Chat' }).first().click()
    await expect(panel(page).getByText(GREETING)).toBeVisible()
}

test.describe('replying to a chat message', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('quotes the message into the composer', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await openChat(page)

        await replyButton(page).click()

        await expect(composer(page)).toHaveValue(`> ${GREETING}\n\n`)
        // Ready to type: the caret is in the composer, past the quote.
        await page.keyboard.type('yes indeed')
        await expect(composer(page)).toHaveValue(`> ${GREETING}\n\nyes indeed`)
    })

    test('keeps what was already typed, and starts the quote on its own line', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await openChat(page)

        await composer(page).fill('half a thought')
        await replyButton(page).click()

        await expect(composer(page)).toHaveValue(`half a thought\n> ${GREETING}\n\n`)
    })
})

test.describe('replying on touch', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('is offered in the long-press sheet, where the hover actions are invisible', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        await page.getByRole('button', { name: 'Chat' }).first().click()

        const message = panel(page).getByText(GREETING)
        await expect(message).toBeVisible()
        const box = await message.boundingBox()
        expect(box).not.toBeNull()
        // Long press: 450ms in longPress.ts, held well past it.
        await page.touchscreen.tap(box!.x + 5, box!.y + 5)
        await page.mouse.move(box!.x + 5, box!.y + 5)
        await page.mouse.down()
        await page.waitForTimeout(700)
        await page.mouse.up()

        // Scoped: the message's own hover Reply is in the DOM too, just
        // invisible without a pointer, which is the reason the sheet exists.
        await page.getByTestId('action-sheet').getByRole('button', { name: 'Reply' }).click()
        await expect(composer(page)).toHaveValue(`> ${GREETING}\n\n`)
    })
})

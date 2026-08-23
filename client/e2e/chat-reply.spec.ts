import { test, expect, type Page } from '@playwright/test'

// A reply points at the message it answers rather than copying its text into
// the composer. What needs a browser is that the action is reachable, that it
// leaves the draft alone, that the sent message draws the line back, and that
// the line survives an edit of the message it names.

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
// Scoped to the message being answered rather than picked off the top of the
// list: the throwaway database outlives the test that wrote it, so the oldest
// message on screen belongs to whatever ran first.
const messageRow = (page: Page, text: string) => panel(page).locator(`[data-message-id]:has-text(${JSON.stringify(text)})`)
const replyButton = (page: Page, text: string) => messageRow(page, text).first().getByRole('button', { name: /^Reply to / })
const replyingBar = (page: Page) => panel(page).getByTestId('chat-replying-to')

// .first() throughout: once a reply to the greeting exists, its line says the
// greeting too, so the bare text matches the message and the line naming it.
const greeting = (page: Page) => panel(page).getByText(GREETING).first()

async function openChat(page: Page) {
    await page.goto('/')
    await page.getByRole('button', { name: 'Chat' }).first().click()
    await expect(greeting(page)).toBeVisible()
}

// Sent by hand rather than through the composer: Enter sends on a desktop
// width and is a newline on a phone, and this is about the reply, not the key.
async function send(page: Page, text: string) {
    await composer(page).fill(text)
    await panel(page).getByRole('button', { name: 'Send' }).first().click()
    await expect(panel(page).getByText(text).first()).toBeVisible()
}

for (const [name, viewport, touch] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['mobile', { width: 390, height: 844 }, true],
] as const) {
    test.describe(`replying to a chat message (${name})`, () => {
        test.use({ viewport, hasTouch: touch })

        test('names the message beside the composer without typing into it', async ({ page }) => {
            await signIn(page)
            await seed(page)
            await openChat(page)

            await composer(page).fill('half a thought')
            await replyButton(page, GREETING).click()

            // The draft is untouched, which is the whole point: nothing anyone
            // else wrote can be edited into your own message on the way out.
            await expect(composer(page)).toHaveValue('half a thought')
            await expect(replyingBar(page)).toContainText('Replying to')
            await expect(replyingBar(page)).toContainText(GREETING)

            await page.getByRole('button', { name: 'Stop replying' }).click()
            await expect(replyingBar(page)).toHaveCount(0)
            await expect(composer(page)).toHaveValue('half a thought')
        })

        test('sends a reply that draws the line back to what it answers', async ({ page }) => {
            await signIn(page)
            await seed(page)
            await openChat(page)

            const answer = `yes indeed (${name})`
            await replyButton(page, GREETING).click()
            await send(page, answer)

            // The bar goes with the message it belonged to, or the next one
            // would answer the same target by accident.
            await expect(replyingBar(page)).toHaveCount(0)

            const sent = messageRow(page, answer).last()
            const line = sent.getByTestId('chat-reply-line')
            await expect(line).toContainText(GREETING)
            // And it leads back: clicking flashes the message it names.
            await line.click()
            await expect(greeting(page)).toBeVisible()
        })
    })
}

test.describe('a reply follows what it answers', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    // The case a quote could never survive: the copy said the old thing
    // forever, and nothing marked it as out of date.
    test('shows the answered message as it stands after an edit', async ({ page }) => {
        await signIn(page)

        const original = await page.request.post('/api/v1/chat', { data: { content: 'thursday, I think' } })
        const { id } = (await original.json()) as { id: string }
        await page.request.post('/api/v1/chat', { data: { content: 'see you then', reply_to_id: id } })
        await page.request.patch(`/api/v1/chat/${id}`, { data: { content: 'friday, sorry' } })

        await page.goto('/')
        await page.getByRole('button', { name: 'Chat' }).first().click()

        const reply = messageRow(page, 'see you then').last()
        await expect(reply.getByTestId('chat-reply-line')).toContainText('friday, sorry')
        await expect(reply.getByTestId('chat-reply-line')).not.toContainText('thursday')
    })

    test('says so once the answered message is deleted', async ({ page }) => {
        await signIn(page)

        const original = await page.request.post('/api/v1/chat', { data: { content: 'something regrettable' } })
        const { id } = (await original.json()) as { id: string }
        await page.request.post('/api/v1/chat', { data: { content: 'quite so', reply_to_id: id } })
        await page.request.delete(`/api/v1/chat/${id}`)

        await page.goto('/')
        await page.getByRole('button', { name: 'Chat' }).first().click()

        const reply = messageRow(page, 'quite so').last()
        await expect(reply.getByTestId('chat-reply-gone')).toBeVisible()
        await expect(reply.getByTestId('chat-reply-line')).toHaveCount(0)
    })
})

test.describe('replying on touch', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('is offered in the long-press sheet, where the hover actions are invisible', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        await page.getByRole('button', { name: 'Chat' }).first().click()

        const message = greeting(page)
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
        await expect(replyingBar(page)).toContainText(GREETING)
        await expect(composer(page)).toHaveValue('')
    })
})

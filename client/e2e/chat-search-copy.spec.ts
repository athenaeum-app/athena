import { test, expect, type Page } from '@playwright/test'

// A chat search result you cannot jump to (issue #81). The server matches the
// whole history, the jump only walks back so far, and the result on screen used
// to be a button whose text could not even be selected. It carries a copy
// control now, and copying is independent of whether the jump could have
// reached it.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

// Deliberately multi-line and carrying an embed token: what is copied is the
// message as written, not the flattened line the result draws.
const NEEDLE = 'quarterhorse'
const MESSAGE = `The ${NEEDLE} manuscript is in the annex\nsecond shelf ::todo:abc123def::`

async function seed(page: Page) {
    const existing = (await (await page.request.get('/api/v1/chat')).json()) as { content: string }[] | null
    if (existing?.some((m) => m.content === MESSAGE)) return
    const res = await page.request.post('/api/v1/chat', { data: { content: MESSAGE } })
    if (!res.ok()) throw new Error(`POST /api/v1/chat -> ${res.status()} ${await res.text()}`)
}

const panel = (page: Page) => page.getByTestId('chat-panel')
const result = (page: Page) => page.getByTestId('chat-search-result').first()

async function search(page: Page) {
    await page.goto('/')
    await page.getByRole('button', { name: 'Chat' }).first().click()
    await panel(page).getByTestId('chat-search-open').click()
    await panel(page).getByTestId('chat-search').fill(NEEDLE)
    await expect(result(page)).toBeVisible()
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

for (const [name, viewport, hasTouch] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['mobile', { width: 390, height: 844 }, true],
] as const) {
    test.describe(`copying a chat search result (${name})`, () => {
        test.use({ viewport, hasTouch, permissions: ['clipboard-read', 'clipboard-write'] })

        test('takes the message as written, and says it did', async ({ page }) => {
            await signIn(page)
            await seed(page)
            await search(page)

            // The preview drops the token; the copy must not.
            await expect(result(page)).not.toContainText('::todo:')

            await result(page).getByTestId('chat-search-copy').click()
            await expect(page.getByText('Message copied.')).toBeVisible()
            expect(await clipboard(page)).toBe(MESSAGE)
        })

        test('copying does not jump, and the row still does', async ({ page }) => {
            await signIn(page)
            await seed(page)
            await search(page)

            // The copy control sits inside the row that jumps, so the press has
            // to stop there: a result list that vanishes under the button you
            // aimed at is the bug this is guarding.
            await result(page).getByTestId('chat-search-copy').click()
            await expect(page.getByTestId('chat-search-results')).toBeVisible()

            // The row itself still jumps, which closes the search and puts the
            // message in the scrollback.
            await result(page).click()
            await expect(page.getByTestId('chat-search-results')).toHaveCount(0)
            await expect(panel(page).getByText(NEEDLE, { exact: false })).toBeVisible()
        })
    })
}

test.describe('the result as a control', () => {
    test.use({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })

    test('is still reachable by keyboard, though it is no longer a button', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await search(page)

        // It has to hold a button, so it cannot be one, and Enter and Space are
        // given back by hand rather than inherited.
        await expect(result(page)).toHaveAttribute('role', 'button')
        await result(page).focus()
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('chat-search-results')).toHaveCount(0)
    })
})

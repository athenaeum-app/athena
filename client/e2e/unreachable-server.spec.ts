import { test, expect, type Page } from '@playwright/test'

// A server that is not answering used to produce a login form, and the only
// thing that form could ever say back was the browser's raw "Failed to
// fetch". Now a transport failure at boot renders a dedicated screen that
// names the library and keeps probing /api/v1/health until the server
// returns; a session rejection (the server *answering* 401) still goes to
// the login form, because those are different facts. Mid-session, a dead
// connection raises a banner and leaves the app tree, and anything being
// written in it, exactly where it was.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

// Simulates the server being gone: every API request fails at the transport
// layer, the way a stopped container or a wrong host fails, rather than with
// an HTTP status. Returns an un-kill function that brings the server "back".
async function killServer(page: Page): Promise<() => Promise<void>> {
    const route = '**/api/v1/**'
    await page.route(route, (r) => r.abort('connectionrefused'))
    return () => page.unroute(route)
}

const screen = (page: Page) => page.getByTestId('unreachable-screen')
const anyPassword = (page: Page) => page.locator('input[type="password"]').first()

test.describe('unreachable server at boot', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('renders the unreachable screen, not a login form', async ({ page }) => {
        await killServer(page)
        await page.goto('/')

        await expect(screen(page)).toBeVisible()
        await expect(screen(page)).toContainText("Can't reach")
        // The dead end this feature removes: no password box for a server
        // that cannot answer one.
        await expect(anyPassword(page)).toHaveCount(0)

        // Retry against a still-dead server keeps the screen up rather than
        // pretending anything changed.
        await page.getByRole('button', { name: /Retry now|Checking/ }).click()
        await expect(screen(page)).toBeVisible()
    })

    test('recovers on its own when the server returns', async ({ page }) => {
        const revive = await killServer(page)
        await page.goto('/')
        await expect(screen(page)).toBeVisible()

        await revive()

        // No clicks: the backoff probe (1s, 2s, 4s, 8s...) notices, re-runs
        // the session check, and with no session lands on an auth surface
        // (login, or the setup wizard when the database is fresh).
        await expect(screen(page)).toHaveCount(0, { timeout: 15000 })
        await expect(page).toHaveURL(/\/(login|setup)/, { timeout: 15000 })
    })

    test('a 401 still goes to the login form, because the server answered', async ({ page }) => {
        await page.route('**/api/v1/users/me', (r) =>
            r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }),
        )
        await page.goto('/')

        // An auth surface, not the unreachable screen: /login, or the setup
        // wizard when the database is fresh (its first step has no password
        // field yet, so the URL is the reliable fact).
        await expect(page).toHaveURL(/\/(login|setup)/)
        await expect(screen(page)).toHaveCount(0)
    })

    test('a login submit that never reaches the server swaps to the screen', async ({ page }) => {
        // Reach the real login form first, then kill the server under it.
        await signIn(page)
        await page.request.post('/api/v1/auth/logout')
        await page.goto('/login')
        await expect(anyPassword(page)).toBeVisible()

        await killServer(page)
        await page.getByLabel('Username').fill('owner')
        await page.getByLabel('Password').fill('password123')
        await page.getByRole('button', { name: 'Log In' }).click()

        // Not an inline "Failed to fetch" under the field: the screen, which
        // can actually do something about it.
        await expect(screen(page)).toBeVisible()
    })
})

test.describe('unreachable server at boot, mobile', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('the screen fits and offers the retry', async ({ page }) => {
        await killServer(page)
        await page.goto('/')

        await expect(screen(page)).toBeVisible()
        const retry = page.getByRole('button', { name: /Retry now|Checking/ })
        await expect(retry).toBeVisible()
        const box = await retry.boundingBox()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    })
})

test.describe('connection lost mid-session', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('raises a banner after sustained failures and leaves the composer alone', async ({ page }) => {
        await signIn(page)
        await page.goto('/')
        const composer = page.getByPlaceholder(/Write your thoughts/)
        await expect(composer).toBeVisible()
        await composer.fill('half a thought the outage must not eat')

        // Only the event poll dies; three consecutive misses (~9s at the 3s
        // cadence) is the threshold, so one blip never shows anything.
        await page.route('**/api/v1/events*', (r) => r.abort('connectionrefused'))

        const banner = page.getByTestId('connection-banner')
        await expect(banner).toBeVisible({ timeout: 20000 })

        // The point of it being a banner: the app is still there, and so is
        // the text.
        await expect(composer).toHaveValue('half a thought the outage must not eat')
        await expect(screen(page)).toHaveCount(0)

        // Server back: the next answered poll clears it, no interaction.
        await page.unroute('**/api/v1/events*')
        await expect(banner).toHaveCount(0, { timeout: 10000 })
        await expect(composer).toHaveValue('half a thought the outage must not eat')
    })
})

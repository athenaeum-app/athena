import { test, expect, type Page } from '@playwright/test'

// The version watch cannot be driven end to end here: the test server is built
// without ldflags, so it reports 'dev', and refusing to act on that is the
// point. What this covers is that the watch is wired up and running, and that
// it leaves a development server alone. shouldReload's own decision table is
// unit-tested in src/staleClient.test.ts.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

test.describe('new build watch', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('asks the server which build it is running', async ({ page }) => {
        await signIn(page)
        const asked = page.waitForRequest((r) => r.url().includes('/api/v1/version'))
        await page.goto('/')
        await asked
    })

    test('leaves a development server alone', async ({ page }) => {
        await signIn(page)
        await page.goto('/')
        await expect(page.getByText(/Athena v/).first()).toBeVisible()

        // Survives only if the page is never torn down. The server here reports
        // 'dev', which must not count as a mismatch, or every developer session
        // would reload itself on a loop.
        await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true))
        await page.waitForTimeout(3000)
        expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true)
        expect(await page.evaluate(() => sessionStorage.getItem('athena-reloaded-for'))).toBeNull()
    })
})

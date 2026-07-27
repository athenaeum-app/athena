import { test, expect, type Page } from '@playwright/test'
import { RELEASE_NOTES } from '../src/releaseNotes'

// The notice is driven by the build's own version, so the expectation is read
// from the same table the app renders from rather than hard-coded. A release
// with no entry is a supported state, not a skipped test: the contract is
// "notes if there are notes, silence if there are not", and both are asserted.

const STORAGE_KEY = 'athena-last-seen-version'

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

async function runningVersion(page: Page): Promise<string> {
    const heading = (await page.locator('header h1').first().textContent()) ?? ''
    const match = heading.match(/v(\d+\.\d+\.\d+)/)
    if (!match) throw new Error(`no version in header: ${heading}`)
    return match[1]
}

test.describe('release notes on update', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('says nothing to a browser seeing Athena for the first time', async ({ page }) => {
        await signIn(page)
        await page.goto('/')
        await expect(page.locator('header h1')).toBeVisible()

        await expect(page.getByTestId('update-notice')).toHaveCount(0)

        // Silent, but not inert: the version is recorded so the *next* update
        // has something to compare against.
        expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe(
            await runningVersion(page),
        )
    })

    test('explains the refresh when the build has moved', async ({ page }) => {
        await signIn(page)
        await page.goto('/')
        await expect(page.locator('header h1')).toBeVisible()
        const version = await runningVersion(page)

        // Rewind the stored version by hand rather than through addInitScript,
        // which re-runs on every navigation and would re-stale the browser on
        // the reload this test ends with.
        await page.evaluate(
            ([key, stale]) => localStorage.setItem(key, stale),
            [STORAGE_KEY, '0.0.1'] as const,
        )
        await page.reload()
        await expect(page.locator('header h1')).toBeVisible()

        const notice = page.getByTestId('update-notice')
        const expected = RELEASE_NOTES[version]

        if (!expected) {
            await expect(notice).toHaveCount(0)
            return
        }

        await expect(notice).toBeVisible()
        await expect(notice).toContainText(`Updated to v${version}`)
        for (const line of expected) await expect(notice).toContainText(line)

        // The whole reason this is not the shared toast(), which clears itself
        // after four seconds.
        await page.waitForTimeout(5000)
        await expect(notice).toBeVisible()

        await notice.getByRole('button', { name: 'Dismiss update notice' }).click()
        await expect(notice).toHaveCount(0)

        // Once, not once per load: the version was recorded on the boot that
        // showed it.
        await page.reload()
        await expect(page.locator('header h1')).toBeVisible()
        await expect(page.getByTestId('update-notice')).toHaveCount(0)
    })
})

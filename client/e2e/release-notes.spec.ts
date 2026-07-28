import { test, expect, type Page } from '@playwright/test'
import { RELEASE_NOTES, releaseHistory } from '../src/releaseNotes'

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

// Dismissing the notice is not the only chance to read it. About keeps the
// running build's notes, and folds every earlier release in behind a toggle.
test.describe('release notes in About', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    async function openAbout(page: Page): Promise<void> {
        await signIn(page)
        await page.goto('/')
        await expect(page.locator('header h1')).toBeVisible()
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page.getByRole('button', { name: 'About' }).click()
    }

    test("the running build's notes are still there after the notice is gone", async ({ page }) => {
        await openAbout(page)
        const version = await runningVersion(page)
        const expected = RELEASE_NOTES[version]

        const panel = page.getByTestId('current-release-notes')
        if (!expected) {
            // A release with no entry of its own renders no panel at all,
            // rather than an empty box under a promising heading.
            await expect(panel).toHaveCount(0)
            return
        }
        await expect(panel).toBeVisible()
        await expect(panel).toContainText(`New in v${version}`)
        for (const line of expected) await expect(panel).toContainText(line)
    })

    test('earlier releases are collapsed, and open in newest-first order', async ({ page }) => {
        await openAbout(page)
        const version = await runningVersion(page)
        const history = releaseHistory(version)

        const toggle = page.getByRole('button', { name: 'Earlier releases' })
        if (history.length === 0) {
            await expect(toggle).toHaveCount(0)
            return
        }

        // Collapsed by default: the list only grows, and About is not a
        // changelog page.
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await expect(page.getByTestId('release-history')).toHaveCount(0)

        await toggle.click()
        const list = page.getByTestId('release-history')
        await expect(list).toBeVisible()

        for (const release of history) {
            await expect(list).toContainText(`v${release.version}`)
            for (const line of release.notes) await expect(list).toContainText(line)
        }

        // Newest first. Asserted on rendered position, since this is exactly
        // what a plain string sort of the version keys would get backwards.
        const rendered = await list.locator('p').allInnerTexts()
        expect(rendered.map((t) => t.trim())).toEqual(history.map((r) => `v${r.version}`))

        // ...and it closes again.
        await toggle.click()
        await expect(page.getByTestId('release-history')).toHaveCount(0)
    })
})

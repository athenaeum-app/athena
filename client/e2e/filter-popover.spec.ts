import { test, expect, type Page } from '@playwright/test'

// The filter row has overflow-x-hidden (for the search bar's width-transition
// animation), which per the CSS overflow spec silently forces its unset
// overflow-y to auto too. That turned the row into its own clipping box, so
// the filter popover, absolutely positioned inside it, used to render but be
// entirely invisible below the row's own single-line height, indistinguishable
// from the button doing nothing. jsdom does no layout, so this can only be
// caught in a real browser.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

test.describe('filter popover', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('opens, is actually visible, updates the badge, and closes on an outside click', async ({ page }) => {
        await signIn(page)
        await page.goto('/')

        const filterButton = page.locator('button[title="Filter moments"]')
        await filterButton.click()

        const fromLabel = page.getByText('From', { exact: true })
        await expect(fromLabel).toBeVisible()

        await page.locator('input[type="date"]').first().fill('2026-01-01')
        await expect(filterButton.locator('span.rounded-full')).toHaveText('1')

        await page.mouse.click(50, 50)
        await expect(fromLabel).toBeHidden()
    })
})

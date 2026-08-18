import { test, expect, type Page } from '@playwright/test'

// Appearance is a dozen sections tall. Scrolled into the middle of it there
// was nothing on screen saying which one you were in, so the panel carries a
// table of contents that follows the scroll position.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

const openSettings = async (page: Page, tab: string) => {
    await page.goto('/')
    const button = page.getByRole('button', { name: 'Settings', exact: true }).first()
    await button.waitFor({ state: 'visible' })
    await button.click()
    // Scoped to the tab strip: an archive named "General" is a button too.
    await page.getByTestId('settings-tabs').getByRole('button', { name: tab }).click()
}

test.describe('settings section nav', () => {
    test.use({ viewport: { width: 1600, height: 900 } })

    test('lists the sections of a tab and marks the one you are reading', async ({ page }) => {
        await signIn(page)
        await openSettings(page, 'Appearance')

        const nav = page.getByTestId('settings-section-nav')
        await expect(nav).toBeVisible()
        await expect(nav.getByRole('button', { name: 'Theme', exact: true })).toBeVisible()
        await expect(nav.getByRole('button', { name: 'Reading', exact: true })).toBeVisible()

        // At the top, the first section is the current one.
        await expect(nav.locator('[aria-current="true"]')).toHaveText('Theme')

        // Scrolled to the end, the last one is.
        await page.getByTestId('settings-body').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
        await expect(nav.locator('[aria-current="true"]')).not.toHaveText('Theme')
    })

    test('clicking an entry scrolls that section into view', async ({ page }) => {
        await signIn(page)
        await openSettings(page, 'Appearance')

        const nav = page.getByTestId('settings-section-nav')
        await nav.getByRole('button', { name: 'Backgrounds', exact: true }).click()
        await expect(nav.locator('[aria-current="true"]')).toHaveText('Backgrounds')
        await expect(page.getByRole('heading', { name: 'Backgrounds' })).toBeInViewport()
    })

    // A tab short enough to need no scrolling is, by the arithmetic, always
    // scrolled to its own end. That had General reporting "Reset" from the
    // moment it opened, whatever was actually on screen.
    test('a tab that does not scroll starts at its first section', async ({ page }) => {
        await signIn(page)
        await openSettings(page, 'General')

        const nav = page.getByTestId('settings-section-nav')
        const body = page.getByTestId('settings-body')
        expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0)
        await expect(nav.locator('[aria-current="true"]')).toHaveText('Behaviour')
    })

    test('a tab with one section gets no table of contents', async ({ page }) => {
        await signIn(page)
        await openSettings(page, 'Account')
        await expect(page.getByTestId('settings-section-nav')).toBeHidden()
    })
})

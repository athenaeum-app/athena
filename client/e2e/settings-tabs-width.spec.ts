import { test, expect, type Page } from '@playwright/test'

// The Settings panel was a flat max-w-3xl (768px), and an owner sees eight
// tabs, which do not fit. The row turned into a horizontal scroller, so About
// and Backups sat off the edge behind a drag nobody expects in a dialog. The
// panel now widens to whatever the row needs, capped at 1024px, and only falls
// back to scrolling where there is genuinely no room: a phone.

const PANEL_MAX_WIDTH = 1024

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

const tabRow = (page: Page) => page.getByTestId('settings-tabs')
const overflowOf = (page: Page) => tabRow(page).evaluate((el) => el.scrollWidth - el.clientWidth)

test.describe('settings tab row, desktop', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('every tab fits without the row scrolling', async ({ page }) => {
        await signIn(page)
        await page.goto('/')
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await expect(tabRow(page)).toBeVisible()

        // The first user owns the server, so both admin tabs are present and
        // this is the widest the row ever gets.
        await expect(tabRow(page).getByRole('button', { name: 'Server' })).toBeVisible()
        await expect(tabRow(page).getByRole('button', { name: 'Backups' })).toBeVisible()

        expect(await overflowOf(page)).toBeLessThanOrEqual(0)

        const panel = tabRow(page).locator('..')
        const [panelBox, aboutBox] = await Promise.all([
            panel.boundingBox(),
            tabRow(page).getByRole('button', { name: 'About' }).boundingBox(),
        ])

        // Grown only as far as it had to: the cap keeps a settings dialog from
        // sprawling across a wide monitor.
        expect(panelBox!.width).toBeLessThanOrEqual(PANEL_MAX_WIDTH)
        // The last tab, the one that used to be off the edge, ends inside the
        // panel rather than under it.
        expect(aboutBox!.x + aboutBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width)
    })
})

test.describe('settings tab row, mobile', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('the panel still fits the phone, and the row scrolls there', async ({ page }) => {
        await signIn(page)
        await page.goto('/')
        await page.getByRole('button', { name: 'More' }).click()
        // The sheet's rows carry both ligatures in the accessible name, so this
        // one reads "settings Settings chevron_right", and a loose "Settings"
        // would also match the Admin row's "admin_panel_settings".
        await page.getByRole('button', { name: /^settings Settings/ }).click()
        await expect(tabRow(page)).toBeVisible()

        const panelBox = (await tabRow(page).locator('..').boundingBox())!
        expect(panelBox.width).toBeLessThanOrEqual(390)

        // Eight tabs cannot fit 390px by any arrangement, so the scroller is
        // still the answer here, and it still reaches the last tab.
        expect(await overflowOf(page)).toBeGreaterThan(0)
        const about = tabRow(page).getByRole('button', { name: 'About' })
        await about.scrollIntoViewIfNeeded()
        const aboutBox = (await about.boundingBox())!
        expect(aboutBox.x).toBeGreaterThanOrEqual(0)
        expect(aboutBox.x + aboutBox.width).toBeLessThanOrEqual(390)
    })
})

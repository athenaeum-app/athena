import { test, expect, type Page } from '@playwright/test'

// The Settings panel was a flat max-w-3xl (768px), and an owner sees eight
// tabs, which do not fit. The row turned into a horizontal scroller, so About
// and Backups sat off the edge behind a drag nobody expects in a dialog. The
// panel now sizes itself from the row, with no ceiling short of the window:
// the tabs are laid out in rem, so raising the UI Scale pref widens them, and
// a fixed cap just moved the same bug to a larger number. Scrolling is left
// only for where there is genuinely no room, which is a phone.

const GUTTER = 32

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

async function openSettings(page: Page): Promise<void> {
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(tabRow(page)).toBeVisible()
}

test.describe('settings tab row, desktop', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('every tab fits without the row scrolling', async ({ page }) => {
        await signIn(page)
        await openSettings(page)

        // The first user owns the server, so both admin tabs are present and
        // this is the widest the row gets at the default scale.
        await expect(tabRow(page).getByRole('button', { name: 'Server' })).toBeVisible()
        await expect(tabRow(page).getByRole('button', { name: 'Backups' })).toBeVisible()

        expect(await overflowOf(page)).toBeLessThanOrEqual(0)

        const panel = tabRow(page).locator('..')
        const [panelBox, aboutBox] = await Promise.all([
            panel.boundingBox(),
            tabRow(page).getByRole('button', { name: 'About' }).boundingBox(),
        ])

        // Grown only as far as it had to, and still clear of the window edges.
        expect(panelBox!.width).toBeGreaterThan(768)
        expect(panelBox!.width).toBeLessThanOrEqual(1440 - GUTTER)
        // The last tab, the one that used to be off the edge, ends inside the
        // panel rather than under it.
        expect(aboutBox!.x + aboutBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width)
    })

    test('a raised UI scale widens the panel with the tabs', async ({ page }) => {
        await signIn(page)
        // Every tab is rem-sized, so this makes the row about half again as
        // wide: the case a fixed cap of 1024px could not serve.
        await page.addInitScript(() => localStorage.setItem('athena-prefs', JSON.stringify({ uiScale: 1.5 })))
        await openSettings(page)

        expect(await overflowOf(page)).toBeLessThanOrEqual(0)

        const panelBox = (await tabRow(page).locator('..').boundingBox())!
        expect(panelBox.width).toBeGreaterThan(1024)
        expect(panelBox.width).toBeLessThanOrEqual(1440 - GUTTER)
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

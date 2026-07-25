import { test, expect, type Page } from '@playwright/test'

// A look used to bring its typography with it: choosing Editorial meant the
// serif, and there was no way to keep Editorial's surfaces with Legacy's face.
// The font picker now offers each look's font as a standalone choice.
//
// This has to run in a real browser. The stylesheet is where the look fonts
// actually live, and jsdom never loads it, so a unit test could only compare
// one copy of a string table against another.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

const bodyFont = (page: Page) =>
    page.evaluate(() => getComputedStyle(document.body).fontFamily)

async function useLook(page: Page, id: string): Promise<void> {
    await page.evaluate((look) => localStorage.setItem('athena-active-look', look), id)
    await page.reload()
}

test.describe('look fonts', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('each look still brings its own font by default', async ({ page }) => {
        await signIn(page)
        await page.goto('/')

        await useLook(page, 'editorial')
        expect(await bodyFont(page)).toContain('Lora')

        await useLook(page, 'legacy')
        expect(await bodyFont(page)).toContain('Inter')
    })

    test("a look's font can be used with a different look", async ({ page }) => {
        await signIn(page)
        await page.goto('/')
        await useLook(page, 'editorial')

        // The thing that was previously impossible: Editorial's surfaces,
        // Legacy's face.
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page.getByRole('button', { name: 'Appearance' }).click()
        await page.getByLabel('Interface Font').selectOption({ label: 'Legacy (Inter)' })

        expect(await bodyFont(page)).toContain('Inter')
        // ...and the look itself is untouched.
        expect(await page.evaluate(() => document.documentElement.getAttribute('data-look'))).toBe('editorial')

        // It outlives a reload, like every other appearance preference.
        await page.reload()
        expect(await bodyFont(page)).toContain('Inter')
    })

    test('"follow the look" hands typography back to the look', async ({ page }) => {
        await signIn(page)
        await page.goto('/')
        await useLook(page, 'editorial')

        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page.getByRole('button', { name: 'Appearance' }).click()
        const picker = page.getByLabel('Interface Font')
        await picker.selectOption({ label: 'Monospace' })
        expect(await bodyFont(page)).toMatch(/mono/i)

        await picker.selectOption({ label: 'Follow the look' })
        expect(await bodyFont(page)).toContain('Lora')
    })
})

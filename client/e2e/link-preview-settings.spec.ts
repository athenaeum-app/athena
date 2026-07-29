import { test, expect, type Page } from '@playwright/test'

// Two follow-up fixes to the Cards Per Row control (SettingsModal.tsx): it
// defaults to 2, and the button group sits on its own line, right-aligned,
// rather than running into the description text above it. The parsing/layout
// behaviour the pref drives is covered in inline-link-previews.spec.ts; this
// is just the control itself.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

// Scoped to this pref's own strip: Videos Per Row renders the same 1 to 4
// buttons further down the same tab.
const perRowButton = (page: Page, n: number) =>
    page.getByTestId('link-previews-per-row').getByRole('button', { name: `${n} cards per row` })

test.describe('inline link preview settings', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('defaults to 2 cards per row', async ({ page }) => {
        await signIn(page)
        await page.goto('/')
        await page.getByRole('button', { name: 'Settings', exact: true }).click()

        await page.getByText('Inline Link Previews').click()
        await expect(perRowButton(page, 2)).toHaveClass(/bg-highlight-strongest/)
        await expect(perRowButton(page, 3)).not.toHaveClass(/bg-highlight-strongest/)
    })

    test('the row of buttons sits clear of the description text, on the right', async ({ page }) => {
        await signIn(page)
        await page.goto('/')
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page.getByText('Inline Link Previews').click()

        const description = page.getByText('How many previews sit side by side')
        // The bordered button strip itself, not the justify-end wrapper around
        // it: its box is what visibly ends where the buttons end.
        const group = page.getByTestId('link-previews-per-row')
        // Cards Per Row's own container, unpadded, so its box is exactly the
        // width the button strip has to fill to read as right-aligned.
        const panel = page.getByText('Cards Per Row').locator('..')
        const [descBox, groupBox, panelBox] = await Promise.all([
            description.boundingBox(),
            group.boundingBox(),
            panel.boundingBox(),
        ])

        // Its own line: no vertical overlap with the sentence above it.
        expect(groupBox!.y).toBeGreaterThanOrEqual(descBox!.y + descBox!.height - 1)
        // Right-aligned within the settings row that holds it.
        expect(groupBox!.x + groupBox!.width).toBeCloseTo(panelBox!.x + panelBox!.width, 0)
    })
})

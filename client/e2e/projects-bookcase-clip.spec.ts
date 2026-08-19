import { test, expect, type Page } from '@playwright/test'

// The Projects panel wears the bookcase watermark, which is an absolutely
// positioned -z-10 layer. Its host was not a positioned element, so the layer
// resolved against the Modal's full-viewport overlay instead, escaped the
// panel's overflow-hidden (an abspos box is not clipped by an ancestor that is
// not its containing block) and painted the shelf texture across the whole
// screen at the modal's z-index: above the scrim, above the feed and the side
// panels, which read as every panel behind the module turning transparent.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

// Desktop reaches Projects from the Menu column; the phone shell hides that
// column and puts the modules behind the bottom nav's More sheet.
async function openProjects(page: Page, mobile: boolean): Promise<void> {
    await page.goto('/')
    if (mobile) await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('button', { name: 'Projects' }).click()
    await expect(page.getByTestId('projects-panel')).toBeVisible()
}

// The panel's own watermark must stay inside the panel. Measured rather than
// asserted on a class name: the containing block is the thing that broke.
async function driftEscapesPanel(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const panel = document.querySelector('[data-testid="projects-panel"]') as HTMLElement | null
        const drift = panel?.querySelector('.animate-bg-drift') as HTMLElement | null
        if (!panel || !drift) throw new Error('projects panel or its watermark is missing')
        const p = panel.getBoundingClientRect()
        const d = drift.getBoundingClientRect()
        // One pixel of slack for the drift animation's sub-pixel offset.
        return d.left < p.left - 1 || d.top < p.top - 1
    })
}

test('the Projects watermark stays inside the panel (desktop)', async ({ page }) => {
    await signIn(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await openProjects(page, false)
    expect(await driftEscapesPanel(page)).toBe(false)
})

test('the Projects watermark stays inside the panel (mobile)', async ({ page }) => {
    await signIn(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await openProjects(page, true)
    expect(await driftEscapesPanel(page)).toBe(false)
})

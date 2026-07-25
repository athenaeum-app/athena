import { test, expect } from '@playwright/test'

// The critical path from the build plan (Phase 3.2):
//   register (owner setup) → create archive → create moment → edit → delete
//
// This runs against a freshly-wiped server (see playwright.config.ts), so the
// first registration takes the first-user-becomes-owner path with no invite.
//
// The spec had rotted: it drove a single-form setup page that is now a
// four-step wizard, and accepted the browser's native confirm() for the delete,
// which the app replaced with its own dialog. Both are updated here.

test('owner setup → archive → moment → edit → delete', async ({ page }) => {
    // This one needs the server to still be in first-run state, and the suite
    // shares a server, so whichever spec runs first claims the owner. Skip rather
    // than fail when another already has, and run it on its own to exercise the
    // wizard: `npx playwright test critical-path`.
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    test.skip(!setup.needs_setup, 'run standalone against a fresh server')

    // --- Owner setup (first-run registration wizard) ---
    await page.goto('/setup')
    await expect(page.getByRole('heading', { name: 'Welcome to Athena' })).toBeVisible()
    await page.getByRole('button', { name: 'Get started' }).click()

    await page.getByLabel('Admin username').fill('owner')
    await page.getByRole('button', { name: 'Next' }).click()

    await page.getByLabel('Password', { exact: true }).fill('password123')
    await page.getByLabel('Confirm password').fill('password123')
    await page.getByRole('button', { name: 'Next' }).click()

    await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible()
    await page.getByRole('button', { name: 'Create admin account' }).click()

    // Landed in the app: the archive creator is visible.
    const archiveInput = page.getByPlaceholder('Create New Archive')
    await expect(archiveInput).toBeVisible()

    // --- Create an archive (names are upper-cased by the UI) ---
    await archiveInput.fill('journal')
    await archiveInput.press('Enter')
    await expect(page.getByRole('button', { name: 'JOURNAL', exact: true })).toBeVisible()

    // --- Create a moment, through the inline composer ---
    await page.getByPlaceholder('Untitled').fill('My first entry')
    await page.getByPlaceholder(/Write your thoughts/).fill('Hello **world**')
    await page.getByRole('button', { name: 'Post', exact: true }).click()

    const card = page.getByTestId('moment-card').filter({ hasText: 'My first entry' })
    await expect(card).toBeVisible()

    // --- Edit the moment (pencil icon opens the modal editor) ---
    await card.locator('i.fa-pencil').click()
    // Scope to the modal: the inline composer has an identical title field.
    const modal = page.locator('.fixed').filter({ hasText: 'Edit Moment' }).first()
    await expect(modal.getByRole('heading', { name: 'Edit Moment' })).toBeVisible()
    await modal.getByPlaceholder('Untitled').fill('My edited entry')
    await modal.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(page.getByTestId('moment-card').filter({ hasText: 'My edited entry' })).toBeVisible()
    await expect(page.getByTestId('moment-card').filter({ hasText: 'My first entry' })).toHaveCount(0)

    // --- Delete the moment (in-app confirm dialog, not window.confirm) ---
    await page.getByTestId('moment-card').filter({ hasText: 'My edited entry' }).locator('i.fa-trash').click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(page.getByTestId('moment-card').filter({ hasText: 'My edited entry' })).toHaveCount(0)
    await expect(page.getByText('No moments yet.')).toBeVisible()
})

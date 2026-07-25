import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Two things a read-only member and a half-written moment have in common: both
// are about the composer, and both were previously discovered the hard way,
// by being rejected on send, or by losing the text.

const OWNER = { username: 'owner', password: 'password123' }

async function signInAsOwner(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { ...OWNER, invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { ...OWNER, stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

async function post<T>(req: APIRequestContext, url: string, data: unknown): Promise<T> {
    const res = await req.post(url, { data })
    if (!res.ok()) throw new Error(`POST ${url} -> ${res.status()} ${await res.text()}`)
    return (await res.json()) as T
}

// Leaves the browser signed in as a brand-new member, who holds only the
// default role.
async function signInAsNewMember(page: Page, username: string): Promise<void> {
    await signInAsOwner(page)
    const invite = await post<{ id: string }>(page.request, '/api/v1/invites', { uses: 1 })
    await post(page.request, '/api/v1/auth/register', {
        username,
        password: 'password123',
        invite_id: invite.id,
        stay_logged_in: true,
    })
}

const composer = (page: Page) => page.getByPlaceholder(/Write your thoughts/)

test.describe('composer visibility', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('a member who cannot create moments is not shown the composer', async ({ page }) => {
        await signInAsNewMember(page, 'readonly-member')
        await page.goto('/')

        await expect(page.getByTestId('feed-column')).toBeVisible()
        await expect(composer(page)).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'New Moment' })).toHaveCount(0)
        // ...and the keybind does not get around it.
        await page.keyboard.press('Control+m')
        await expect(page.getByRole('heading', { name: 'New Moment' })).toHaveCount(0)
    })

    // Chat is deliberately not treated as writing to the library: the default
    // role can talk even though it cannot post. The composer is still gated on
    // the permission, because a custom role can withhold it.
    test('a member who cannot create moments can still chat', async ({ page }) => {
        await signInAsNewMember(page, 'chatty-member')
        await page.goto('/')

        await page.getByRole('button', { name: 'Chat', exact: true }).click()
        const box = page.getByPlaceholder(/Message…/)
        await expect(box).toBeVisible()
        await box.fill('can someone point me at the trip photos?')
        await box.press('Enter')
        await expect(page.getByText('can someone point me at the trip photos?')).toBeVisible()
    })

    test('the chat composer is withheld from a role that cannot post to it', async ({ page }) => {
        await signInAsOwner(page)
        // A role with viewing but no SEND_CHAT_MESSAGE, applied to the default
        // so it reaches a fresh member: VIEW_MOMENTS | VIEW_CHAT = 257.
        await page.request.patch('/api/v1/roles/role_viewer', { data: { permissions: 257 } })
        await signInAsNewMember(page, 'quiet-member')
        await page.goto('/')

        await page.getByRole('button', { name: 'Chat', exact: true }).click()
        await expect(page.getByText('You can read this conversation but not post to it.')).toBeVisible()
        await expect(page.getByPlaceholder(/Message…/)).toHaveCount(0)

        // Put the default back for the specs that follow.
        await signInAsOwner(page)
        await page.request.patch('/api/v1/roles/role_viewer', { data: { permissions: 769 } })
    })

    test('the owner still gets the composer', async ({ page }) => {
        await signInAsOwner(page)
        await post(page.request, '/api/v1/archives', { name: 'Composer' }).catch(() => {})
        await page.goto('/')
        await expect(composer(page)).toBeVisible()
    })
})

test.describe('moment drafts', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('survive a reload, and are cleared by posting', async ({ page }) => {
        await signInAsOwner(page)
        await post(page.request, '/api/v1/archives', { name: 'Drafts' }).catch(() => {})
        await page.goto('/')

        await composer(page).fill('a thought I have not finished')
        await page.getByPlaceholder('Untitled').fill('Half written')

        await page.reload()
        await expect(composer(page)).toHaveValue('a thought I have not finished')
        await expect(page.getByPlaceholder('Untitled')).toHaveValue('Half written')
        await expect(page.getByText('Restored an unsaved draft.')).toBeVisible()

        await page.getByRole('button', { name: 'Post' }).click()
        await expect(page.getByTestId('moment-card').filter({ hasText: 'Half written' })).toBeVisible()

        // Posting is what a draft is *for*, so nothing should be left behind.
        await page.reload()
        await expect(composer(page)).toHaveValue('')
        await expect(page.getByText('Restored an unsaved draft.')).toHaveCount(0)
    })

    test('survive changing the archive filter', async ({ page }) => {
        await signInAsOwner(page)
        const a = await post<{ id: string; name: string }>(page.request, '/api/v1/archives', { name: 'Alpha' })
        await post(page.request, '/api/v1/archives', { name: 'Beta' })
        await page.goto('/')

        await composer(page).fill('still here?')
        await page.getByRole('button', { name: a.name, exact: true }).click()

        await expect(composer(page)).toHaveValue('still here?')
    })

    test('can be discarded on purpose', async ({ page }) => {
        await signInAsOwner(page)
        await page.goto('/')

        await composer(page).fill('never mind')
        await page.reload()
        await expect(page.getByText('Restored an unsaved draft.')).toBeVisible()

        await page.getByRole('button', { name: 'Discard' }).click()
        await expect(composer(page)).toHaveValue('')

        await page.reload()
        await expect(composer(page)).toHaveValue('')
    })
})

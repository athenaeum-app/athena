import { test, expect, type Page } from '@playwright/test'

// Self-service account editing, driven through the UI it actually ships behind:
// Settings → Account. The server side is covered by Go tests; what this adds is
// that the form reaches the endpoint, that the app picks up the new identity
// without a reload, and that the new credentials really are the ones that work.
//
// The suite shares one server, and these tests change the credentials they run
// under, so each signs in as its own freshly-invited member rather than as the
// owner, and they cannot tread on each other.

const OWNER = { username: 'owner', password: 'password123' }

async function signInAsOwner(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { ...OWNER, invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { ...OWNER, stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

// Leaves the browser signed in as a brand-new member with the given name.
async function signInAsNewMember(page: Page, username: string): Promise<void> {
    await signInAsOwner(page)
    const inviteRes = await page.request.post('/api/v1/invites', { data: { uses: 1 } })
    if (!inviteRes.ok()) throw new Error(`create invite -> ${inviteRes.status()}`)
    const invite = (await inviteRes.json()) as { id: string }

    const res = await page.request.post('/api/v1/auth/register', {
        data: { username, password: 'password123', invite_id: invite.id, stay_logged_in: true },
    })
    if (!res.ok()) throw new Error(`register ${username} -> ${res.status()} ${await res.text()}`)
}

async function openAccountTab(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Account' }).click()
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
}

async function login(page: Page, username: string, password: string): Promise<number> {
    const res = await page.request.post('/api/v1/auth/login', {
        data: { username, password, stay_logged_in: true },
    })
    return res.status()
}

test.describe('account settings', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('changes the username, and the new one is what signs in', async ({ page }) => {
        await signInAsNewMember(page, 'rename-me')
        await page.goto('/')
        await openAccountTab(page)

        await page.getByLabel('Username').fill('renamed-ok')
        await page.getByLabel('Current password').fill('password123')
        await page.getByRole('button', { name: 'Save changes' }).click()
        await expect(page.getByText(/Account updated/)).toBeVisible()

        // The app picks the new name up without a reload.
        await expect(page.getByText('renamed-ok').first()).toBeVisible()

        expect(await login(page, 'renamed-ok', 'password123'), 'new username signs in').toBe(200)
        expect(await login(page, 'rename-me', 'password123'), 'old username does not').toBe(401)
    })

    test('changes the password and rejects a mismatched confirmation', async ({ page }) => {
        await signInAsNewMember(page, 'repassword-me')
        await page.goto('/')
        await openAccountTab(page)

        // The mismatch is caught in the form, before anything is sent.
        await page.getByLabel('New password', { exact: true }).fill('a-longer-secret')
        await page.getByLabel('Confirm new password').fill('a-different-secret')
        await page.getByLabel('Current password').fill('password123')
        await page.getByRole('button', { name: 'Save changes' }).click()
        await expect(page.getByText('The new passwords do not match.')).toBeVisible()
        expect(await login(page, 'repassword-me', 'password123'), 'nothing saved yet').toBe(200)

        await page.getByLabel('Confirm new password').fill('a-longer-secret')
        await page.getByRole('button', { name: 'Save changes' }).click()
        await expect(page.getByText(/Account updated/)).toBeVisible()

        expect(await login(page, 'repassword-me', 'a-longer-secret'), 'new password signs in').toBe(200)
        expect(await login(page, 'repassword-me', 'password123'), 'old password does not').toBe(401)
    })

    test('reports a wrong current password without changing anything', async ({ page }) => {
        await signInAsNewMember(page, 'careful-me')
        await page.goto('/')
        await openAccountTab(page)

        await page.getByLabel('Username').fill('hijacked')
        await page.getByLabel('Current password').fill('not-my-password')
        await page.getByRole('button', { name: 'Save changes' }).click()

        await expect(page.getByText(/current password is incorrect/i)).toBeVisible()

        const me = (await (await page.request.get('/api/v1/users/me')).json()) as { username: string }
        expect(me.username).toBe('careful-me')
    })
})

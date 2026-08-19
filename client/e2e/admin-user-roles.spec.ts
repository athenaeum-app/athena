import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// The role editor opened on an empty selection, because the admin user listing
// carried no roles and the client had nothing to preselect from. Save writes
// the selection as the whole set, so opening the editor and saving stripped a
// user back to the default role, whatever they held a moment earlier.

async function post<T>(req: APIRequestContext, url: string, data: unknown): Promise<T> {
    const res = await req.post(url, { data })
    if (!res.ok()) throw new Error(`POST ${url} -> ${res.status()} ${await res.text()}`)
    return (await res.json()) as T
}

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

const ROLE = 'Archivist'
const MEMBER = 'rolinda'

// One archivist holding a custom role, so there is something for the editor to
// lose. Idempotent: the suite shares a server.
async function seed(req: APIRequestContext): Promise<void> {
    const users = (await (await req.get('/api/v1/users/all')).json()) as { username: string; id: string }[]
    if (users.some((u) => u.username === MEMBER)) return

    const roles = (await (await req.get('/api/v1/roles')).json()) as { id: string; name: string }[]
    const role =
        roles.find((r) => r.name === ROLE) ??
        (await post<{ id: string }>(req, '/api/v1/roles', { name: ROLE, color: '#7ed6df', position: 5, permissions: 3 }))

    const invite = await post<{ id: string }>(req, '/api/v1/invites', { uses: 1 })
    // Registering signs the shared cookie jar in as the new user, so the owner
    // has to take the session back before doing anything admin again.
    await post(req, '/api/v1/auth/register', { username: MEMBER, password: 'password123', invite_id: invite.id })
    await post(req, '/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true })

    const after = (await (await req.get('/api/v1/users/all')).json()) as { username: string; id: string }[]
    const member = after.find((u) => u.username === MEMBER)!
    const assigned = await req.patch(`/api/v1/users/${member.id}/roles`, { data: { role_ids: [role.id] } })
    if (!assigned.ok()) throw new Error(`assign roles -> ${assigned.status()} ${await assigned.text()}`)
}

async function openUsers(page: Page): Promise<void> {
    await page.goto('/')
    await page.getByRole('button', { name: 'Admin' }).first().click()
    await page.getByRole('button', { name: 'Users & Invites' }).click()
}

const memberRow = (page: Page) => page.locator(`[data-testid="admin-user-row"][data-username="${MEMBER}"]`)

test('a user row names the roles they hold', async ({ page }) => {
    await signIn(page)
    await seed(page.request)
    await page.setViewportSize({ width: 1440, height: 900 })
    await openUsers(page)

    const chips = memberRow(page).getByTestId('user-role-chip')
    await expect(chips.filter({ hasText: ROLE })).toBeVisible()
    // The default role is assigned by the server rather than chosen, and it has
    // to show, or saving looks like it removed one.
    await expect(chips).toHaveCount(2)
})

test('the role editor opens on what the user already holds', async ({ page }) => {
    await signIn(page)
    await seed(page.request)
    await page.setViewportSize({ width: 1440, height: 900 })
    await openUsers(page)

    await memberRow(page).getByRole('button', { name: 'Edit Roles' }).click()
    const editor = page.getByTestId('admin-role-editor')
    await expect(editor).toBeVisible()

    // Saving without touching anything must be a no-op. It used to hand the
    // user back the default role and nothing else.
    await editor.getByRole('button', { name: 'Save Roles' }).click()
    await expect(page.getByText('Roles updated.')).toBeVisible()

    await expect(memberRow(page).getByTestId('user-role-chip').filter({ hasText: ROLE })).toBeVisible()
})

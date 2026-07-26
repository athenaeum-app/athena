import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// A pinned moment is lifted out of the main feed list (filteredMoments drops
// anything whose id is in pinnedMoments) and rendered from the separate
// pinnedMoments signal instead. That signal is a second copy of moment state,
// so every path that maintains `moments` has to maintain it too. Editing a
// moment used to refresh only the feed list, leaving the pinned card showing
// the content it was pinned with until the whole app was reloaded.

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

const TITLE = 'Pinned refresh probe'

// Pins are library-shared and the pinned section ignores the archive filter, so
// a moment left pinned here would sit on top of every other spec's feed. Each
// test deletes its moment in a finally, and creates a fresh one, so a previous
// run's edited content can never be mistaken for this one's.
async function seedPinned(page: Page, content: string): Promise<string> {
    const req = page.request
    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    const existing = archives?.find((a) => a.name === 'PINS')
    const arch = existing ?? (await post<{ id: string }>(req, '/api/v1/archives', { name: 'PINS' }))
    const moment = await post<{ id: string }>(req, '/api/v1/moments', {
        archive_id: arch.id,
        title: TITLE,
        content,
        tag_ids: [],
    })
    const res = await req.patch(`/api/v1/moments/${moment.id}/pin`, { data: { pinned: true } })
    if (!res.ok()) throw new Error(`pin -> ${res.status()} ${await res.text()}`)
    return moment.id
}

// Load the feed and let the first delta-sync poll drain the backlog. Without
// this the seed's own MOMENT_PINNED event is still queued, and the loadPinned()
// it triggers would refresh the pinned card for reasons that have nothing to do
// with what these tests are checking. A pin made in an earlier session (the real
// case) leaves no such event behind.
async function openSettledFeed(page: Page, body: string) {
    // An empty batch is the only reliable "nothing queued" signal: the seed's
    // events may be split across polls, and a partially drained backlog would
    // leave a MOMENT_PINNED still to come.
    const drained = page.waitForResponse(async (r) => {
        if (!r.url().includes('/api/v1/events')) return false
        const batch = (await r.json()) as { events?: unknown[] }
        return (batch.events?.length ?? 0) === 0
    })
    await page.goto('/')
    await expect(page.getByText(body)).toBeVisible()
    await drained
}

test.describe('pinned moments stay current', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('editing a pinned moment updates its card without a reload', async ({ page }) => {
        await signIn(page)
        const id = await seedPinned(page, 'pinned body before the edit')
        try {
            await openSettledFeed(page, 'pinned body before the edit')

            await page.locator('.fa-pencil').first().click()
            // The modal editor's textarea, not the inline composer's, which is
            // also on the page and comes first in DOM order.
            const body = page.locator('textarea').last()
            await expect(body).toBeVisible()
            await body.fill('pinned body after the edit')
            await page.getByRole('button', { name: 'Save', exact: true }).click()

            await expect(page.getByText('pinned body after the edit')).toBeVisible()
            await expect(page.getByText('pinned body before the edit')).toHaveCount(0)
        } finally {
            await page.request.delete(`/api/v1/moments/${id}`)
        }
    })

    test('an edit made elsewhere reaches the pinned card through the poll', async ({ page }) => {
        await signIn(page)
        const id = await seedPinned(page, 'pinned body from another client')
        try {
            await openSettledFeed(page, 'pinned body from another client')

            // Straight to the API, so nothing in this tab knows about the edit
            // until the delta-sync poll delivers MOMENT_UPDATED.
            const res = await page.request.patch(`/api/v1/moments/${id}`, {
                data: { title: TITLE, content: 'pinned body edited by the other client', tag_ids: [] },
            })
            expect(res.ok()).toBeTruthy()

            await expect(page.getByText('pinned body edited by the other client')).toBeVisible()
            await expect(page.getByText('pinned body from another client')).toHaveCount(0)
        } finally {
            await page.request.delete(`/api/v1/moments/${id}`)
        }
    })

    test('deleting a pinned moment removes its card', async ({ page }) => {
        await signIn(page)
        const id = await seedPinned(page, 'pinned body about to be deleted')
        try {
            await openSettledFeed(page, 'pinned body about to be deleted')

            await page.locator('.fa-trash').first().click()
            await page.getByRole('button', { name: 'Delete', exact: true }).click()

            // Tight: the delta poll would eventually clear it anyway, so a
            // generous wait here would pass against the local path doing
            // nothing at all.
            await expect(page.getByText('pinned body about to be deleted')).toHaveCount(0, { timeout: 2000 })
        } finally {
            await page.request.delete(`/api/v1/moments/${id}`)
        }
    })
})

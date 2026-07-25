import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// The composer's tag suggestion list: a ranked, clickable set of the tags you
// are most likely to want next, so tagging a moment is one typed tag followed
// by clicks rather than typing every name out.
//
// Ranking itself is unit-tested in src/tagRank.test.ts. What can only be
// checked here is *when* the list is on screen, which is the part that broke:
// committing a tag clears the input, so a gate that only watched the input and
// the title/body hid the list at the first tag, precisely when it should have
// taken over.

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

// gaming/studio/coding share three moments; baking has six of its own, so it is
// the most-used tag but never co-occurs with gaming.
//
// Deliberately its own vocabulary. The e2e database is shared across spec
// files, and tag-facets.spec.ts asserts on an exact tag set, so reusing its
// names here would break it from a different file.
async function seed(page: Page) {
    const req = page.request
    const existing = (await (await req.get('/api/v1/archives')).json()) as { name: string }[]
    if (existing?.some((a) => a.name === 'Composer')) return

    const arch = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Composer' })
    const mk = async (n: string) => (await post<{ id: string }>(req, '/api/v1/tags', { name: n, color: '#8899aa' })).id
    const gaming = await mk('gaming')
    const studio = await mk('studio')
    const coding = await mk('coding')
    const baking = await mk('baking')
    for (let i = 0; i < 3; i++) {
        await post(req, '/api/v1/moments', { archive_id: arch.id, title: `g${i}`, content: 'x', tag_ids: [gaming, studio, coding] })
    }
    for (let i = 0; i < 6; i++) {
        await post(req, '/api/v1/moments', { archive_id: arch.id, title: `c${i}`, content: 'x', tag_ids: [baking] })
    }
}

const tagField = (page: Page) => page.getByPlaceholder(/Add tags/)
const suggestionList = (page: Page) => page.getByTestId('tag-suggestions').locator('button')

async function suggested(page: Page): Promise<string[]> {
    const names = await suggestionList(page).allInnerTexts()
    return names.map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
}

test.describe('composer tag suggestions', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    // The reported workflow: type one tag, then click the rest. Nothing else in
    // the composer is filled in, which is what used to leave the list hidden.
    test('adding one tag by hand reveals the rest as a clickable list', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        await tagField(page).fill('gaming')
        await tagField(page).press(',')

        await expect.poll(() => suggested(page)).not.toHaveLength(0)

        // The tags that share every gaming moment are the ones being offered.
        // Exact ordering is left to src/tagRank.test.ts: the list is ranked
        // across the whole library, so asserting positions here would depend on
        // tags other spec files happen to have created.
        const names = await suggested(page)
        expect(names).toContain('coding')
        expect(names).toContain('studio')
    })

    test('clicking a suggestion adds it without typing', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        await tagField(page).fill('gaming')
        await tagField(page).press(',')
        await expect.poll(() => suggested(page)).toContain('studio')

        await suggestionList(page).filter({ hasText: '#studio' }).first().click()

        // Picked tags leave the suggestion list and show as selected chips, so
        // studio disappearing from the offer is the proof it was taken.
        await expect.poll(() => suggested(page)).not.toContain('studio')
        await expect(page.getByRole('button', { name: 'Remove tag studio' })).toBeVisible()
    })

    // The counterweight to the fix: an untouched composer must not sit under a
    // permanent tag menu.
    test('an untouched composer shows no list', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        await tagField(page).click()
        await page.waitForTimeout(400)
        expect(await suggested(page)).toHaveLength(0)
    })
})

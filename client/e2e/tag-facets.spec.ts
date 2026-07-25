import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Tag filtering is AND, so a combination like #games + #cooking can match
// nothing at all. The tag surfaces only offer tags that still lead somewhere
// (GET /api/v1/tags/facets), which is what these tests pin: the offered set
// has to shrink as the selection narrows, and it must never offer a click that
// empties the feed.
//
// Geometry-free on purpose. It asserts which chips exist, not how they look,
// so restyling the bar doesn't break it.

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

// Journal: two moments games+roblox, one games+dev. Ideas: three cooking.
// So cooking is the most-used tag but shares no moment with games, and
// "unused" is on nothing at all.
//
// Idempotent: the throwaway database is wiped once per run, not per test, so a
// second seed would collide on the unique archive name and (worse) double the
// moment counts the assertions depend on.
async function seed(page: Page) {
    const req = page.request
    const existing = (await (await req.get('/api/v1/archives')).json()) as { name: string }[]
    if (existing?.some((a) => a.name === 'Journal')) return

    const journal = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Journal' })
    const ideas = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Ideas' })
    const tag = async (name: string) => (await post<{ id: string }>(req, '/api/v1/tags', { name, color: '#8899aa' })).id
    const games = await tag('games')
    const roblox = await tag('roblox')
    const dev = await tag('dev')
    const cooking = await tag('cooking')
    await tag('unused')

    await post(req, '/api/v1/moments', { archive_id: journal.id, title: 'g1', content: 'body', tag_ids: [games, roblox] })
    await post(req, '/api/v1/moments', { archive_id: journal.id, title: 'g2', content: 'body', tag_ids: [games, roblox] })
    await post(req, '/api/v1/moments', { archive_id: journal.id, title: 'g3', content: 'body', tag_ids: [games, dev] })
    for (let i = 0; i < 3; i++) {
        await post(req, '/api/v1/moments', { archive_id: ideas.id, title: `c${i}`, content: 'body', tag_ids: [cooking] })
    }
}

// The tag names currently offered in the desktop tag bar, sorted so the
// assertion doesn't depend on server ordering.
async function offered(page: Page): Promise<string[]> {
    const bar = page.getByTestId('tag-bar')
    await expect(bar).toBeVisible()
    const names = await bar.locator('button').allInnerTexts()
    return names
        .map((t) => t.trim())
        .filter((t) => t.startsWith('#'))
        .map((t) => t.slice(1).toLowerCase())
        .sort()
}

const chip = (page: Page, name: string) =>
    page.getByTestId('tag-bar').getByRole('button', { name: `#${name}`, exact: true })

test.describe('tag facets', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('a tag on no moments is never offered', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        await expect.poll(() => offered(page)).toEqual(['cooking', 'dev', 'games', 'roblox'])
    })

    test('selecting a tag narrows the offer to tags that still match something', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        await expect.poll(() => offered(page)).toContain('cooking')

        await chip(page, 'games').click()

        // cooking is the most-used tag in the library, but no moment carries it
        // alongside games, so offering it would strand the reader on an empty
        // feed. games itself stays, or there would be no way to undo the filter.
        await expect.poll(() => offered(page)).toEqual(['dev', 'games', 'roblox'])

        // Narrow again: dev is on g3, which has no roblox, so the pair rules it out.
        await chip(page, 'roblox').click()
        await expect.poll(() => offered(page)).toEqual(['games', 'roblox'])

        // The feed still has something in it at the end of that drill-down,
        // which is the entire promise of the feature.
        await expect(page.getByText('g1').first()).toBeVisible()
    })

    test('deselecting widens the offer again', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        await chip(page, 'games').click()
        await expect.poll(() => offered(page)).not.toContain('cooking')

        await chip(page, 'games').click()
        await expect.poll(() => offered(page)).toContain('cooking')
    })

    test('the offer follows the selected archive', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        await expect.poll(() => offered(page)).toContain('games')

        await page.getByRole('button', { name: 'Ideas', exact: true }).first().click()

        // Nothing in Ideas carries games, so filtering by it there would show
        // an empty feed.
        await expect.poll(() => offered(page)).toEqual(['cooking'])
    })
})

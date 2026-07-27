import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Ranking the composer's tag suggestions for the archive being filed into.
// The ordering rules themselves are unit-tested in src/tagRank.test.ts; what
// only works end to end is that the composer's archive dropdown is the thing
// feeding the ranking, and that changing it re-ranks without a refetch.

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

// Two archives with no vocabulary in common, and the busiest tag in the library
// deliberately living in only one of them: mulching is used more than
// invoicing and payroll put together, so plain usage ranking would put it first
// for a moment being filed in Ledger. That is the ordering this feature changes.
//
// Its own tag names on purpose. The e2e database is shared across spec files
// and the other tag specs assert on their own vocabulary.
async function seed(page: Page) {
    const req = page.request
    const existing = (await (await req.get('/api/v1/archives')).json()) as { name: string }[]
    if (existing?.some((a) => a.name === 'Ledger')) return

    const ledger = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Ledger' })
    const greenhouse = await post<{ id: string }>(req, '/api/v1/archives', { name: 'Greenhouse' })
    const mk = async (n: string) => (await post<{ id: string }>(req, '/api/v1/tags', { name: n, color: '#7788aa' })).id
    const invoicing = await mk('invoicing')
    const payroll = await mk('payroll')
    const mulching = await mk('mulching')
    const seedlings = await mk('seedlings')

    const fill = async (archive: string, tag: string, times: number, prefix: string) => {
        for (let i = 0; i < times; i++) {
            await post(req, '/api/v1/moments', { archive_id: archive, title: `${prefix}${i}`, content: 'x', tag_ids: [tag] })
        }
    }
    await fill(ledger.id, invoicing, 3, 'inv')
    await fill(ledger.id, payroll, 2, 'pay')
    await fill(greenhouse.id, mulching, 8, 'mulch')
    await fill(greenhouse.id, seedlings, 1, 'seed')
}

const archiveSelect = (page: Page) => page.locator('select').first()
const suggestionList = (page: Page) => page.getByTestId('tag-suggestions').locator('button')

// The list is capped at 40 and the shared database holds other specs' tags, so
// these read the leading entries rather than the whole set.
async function topSuggestions(page: Page, n: number): Promise<string[]> {
    const names = await suggestionList(page).allInnerTexts()
    return names.map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean).slice(0, n)
}

test.describe('composer tag suggestions follow the selected archive', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('each archive leads with its own tags, and switching re-ranks', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        // Suggestions are gated on the composer holding something, and writing
        // the body is the one way in that does not also pick a tag.
        await page.getByPlaceholder(/Write your thoughts/).fill('filing this somewhere')

        await archiveSelect(page).selectOption({ label: 'Ledger' })
        await expect.poll(() => topSuggestions(page, 2)).toEqual(['invoicing', 'payroll'])

        // mulching is the most-used tag in the library and it is still behind
        // both of Ledger's, which is the whole point.
        const ledgerOrder = await topSuggestions(page, 40)
        expect(ledgerOrder.indexOf('invoicing')).toBeLessThan(ledgerOrder.indexOf('mulching'))

        await archiveSelect(page).selectOption({ label: 'Greenhouse' })
        await expect.poll(() => topSuggestions(page, 2)).toEqual(['mulching', 'seedlings'])

        // Same list, reordered by the dropdown alone: nothing else was touched.
        const greenhouseOrder = await topSuggestions(page, 40)
        expect(greenhouseOrder.indexOf('mulching')).toBeLessThan(greenhouseOrder.indexOf('invoicing'))
    })
})

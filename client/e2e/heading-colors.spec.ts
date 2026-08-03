import { test, expect, type Page } from '@playwright/test'

// Every markdown heading level takes the theme's heading colour.
//
// The class list on MarkdownText named h1, h2 and h3 only, so h4 and below fell
// through to the typography plugin's default, a near-black that is unreadable
// on every dark theme the app ships. The fix binds --tw-prose-headings once, so
// this walks all six levels rather than only the three that regressed.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

const TITLE = 'Every heading level'
const BODY = [1, 2, 3, 4, 5, 6].map((n) => `${'#'.repeat(n)} Heading level ${n}`).join('\n\n')

async function seed(page: Page) {
    const req = page.request
    const existing = (await (await req.get('/api/v1/moments')).json()) as { title: string }[] | null
    if (existing?.some((m) => m.title === TITLE)) return

    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    const archive =
        archives?.find((a) => a.name === 'Headings') ??
        ((await (await req.post('/api/v1/archives', { data: { name: 'Headings' } })).json()) as { id: string })

    const res = await req.post('/api/v1/moments', {
        data: { archive_id: archive.id, title: TITLE, content: BODY, tag_ids: [] },
    })
    if (!res.ok()) throw new Error(`seed -> ${res.status()} ${await res.text()}`)
}

test.describe('markdown heading colours', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    // Colours are compared to h1's rather than to a literal: the browser reports
    // whatever space the theme is authored in (oklch today), so parsing rgb here
    // would quietly match nothing and pass on any colour at all.
    test('every level takes the same colour h1 does', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        const body = page.locator('.prose').filter({ hasText: 'Heading level 6' }).first()
        await expect(body).toBeVisible()

        const colorOf = (level: number) =>
            body
                .locator(`h${level}`)
                .filter({ hasText: `Heading level ${level}` })
                .evaluate((el) => getComputedStyle(el).color)

        const expected = await colorOf(1)
        // The theme's heading colour, not the body colour h5 and h6 inherited.
        const bodyColor = await body.evaluate((el) => getComputedStyle(el).color)
        expect(expected).not.toBe(bodyColor)

        for (const level of [2, 3, 4, 5, 6]) {
            expect(await colorOf(level), `h${level}`).toBe(expected)
        }
    })
})

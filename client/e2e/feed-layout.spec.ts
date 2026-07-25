import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Layout regression for the Moments column.
//
// The column is width-capped and scrolls vertically, so anything inside it that
// lays out wider than the column turns into a horizontal scrollbar running the
// height of the feed. Two things in rendered markdown do that: an unbreakable
// word (a pasted URL, autolinked by GFM into a single <a>) and a table, which is
// sized by its content and has no way to shrink.
//
// jsdom does no layout, so this can only be caught in a real browser. It
// measures geometry rather than asserting on class names.

const LONG_WORD = 'https://example.com/' + 'x'.repeat(400)

const WIDE_TABLE =
    '| ' + Array.from({ length: 12 }, (_, i) => `column ${i + 1}`).join(' | ') + ' |\n' +
    '| ' + Array.from({ length: 12 }, () => '---').join(' | ') + ' |\n' +
    '| ' + Array.from({ length: 12 }, (_, i) => `value number ${i + 1}`).join(' | ') + ' |'

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

// Every box inside the Moments column that has grown a horizontal scrollbar.
// Code blocks and image galleries are excluded: both scroll sideways by design
// (see MarkdownText's copy-button wiring and .md-gallery), and so does the table
// wrapper. The point of it is that the overflow stops there instead of reaching
// the column.
async function horizontalScrollers(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = document.querySelector('[data-testid="feed-column"]')
        if (!root) throw new Error('feed column not rendered')
        const skip = 'pre, .md-gallery, .md-table-wrap'
        const out: string[] = []
        for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
            const h = el as HTMLElement
            if (h.matches(skip) || h.closest(skip)) continue
            const overflowX = getComputedStyle(h).overflowX
            if (overflowX !== 'auto' && overflowX !== 'scroll') continue
            if (h.scrollWidth <= h.clientWidth + 1) continue
            out.push(
                `<${h.tagName.toLowerCase()} class="${(h.getAttribute('class') || '').slice(0, 70)}"> ` +
                    `scrollWidth=${h.scrollWidth} clientWidth=${h.clientWidth}`,
            )
        }
        return out
    })
}

test.describe('Moments column', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('wide moment content does not make the column scroll sideways', async ({ page }) => {
        await signIn(page)
        const archive = await post<{ id: string }>(page.request, '/api/v1/archives', { name: 'Layout' })

        const samples: [string, string][] = [
            ['pasted link', `here you go ${LONG_WORD} and more text after it`],
            ['unbroken word', 'Supercalifragilistic' + 'a'.repeat(300)],
            ['wide table', WIDE_TABLE],
            ['blockquoted link', '> ' + LONG_WORD],
            ['list with a link', '- ' + LONG_WORD + '\n- a second item'],
            ['long inline code', 'try `' + 'z'.repeat(250) + '` and see'],
        ]
        for (const [title, content] of samples) {
            await post(page.request, '/api/v1/moments', { archive_id: archive.id, title, content, tag_ids: [] })
        }

        await page.goto('/')
        const column = page.getByTestId('feed-column')
        await expect(column).toBeVisible()
        // Every sample rendered before measuring.
        for (const [title] of samples) {
            await expect(column.getByText(title, { exact: true }).first()).toBeAttached()
        }
        await expect(column.locator('table')).toBeAttached()

        expect(await horizontalScrollers(page)).toEqual([])
    })
})

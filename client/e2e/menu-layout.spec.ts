import { test, expect, type Page } from '@playwright/test'

// Layout regression for the desktop Menu column (§ Menu revamp).
//
// The column is width-capped (lg:max-w-xs), so anything inside it that refuses
// to shrink overflows sideways. Where that lands in a box which scrolls (the
// docked chat widget's message list, or the widget stack itself) the result is
// a horizontal scrollbar running across the menu. Chat content is the usual
// culprit: a pasted URL is one unbreakable word (and GFM autolinks it into a
// single <a>), so it lays out at its full width no matter how narrow the column.
//
// jsdom does no layout, so this can only be caught in a real browser, hence an
// e2e spec rather than a unit test. It measures geometry rather than asserting
// on class names, so it stays honest if the styling is rewritten.

const LONG_WORD = 'https://example.com/' + 'x'.repeat(400)
const LONG_PROSE = 'lorem ipsum dolor sit amet '.repeat(40)

// Sign in, taking whichever path this server is in: a fresh DB needs the
// first-user (owner) registration, otherwise reuse the account the
// critical-path spec created.
async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

async function seedChat(page: Page, contents: string[]): Promise<void> {
    for (const content of contents) {
        const res = await page.request.post('/api/v1/chat', { data: { content } })
        if (!res.ok()) throw new Error(`POST /api/v1/chat -> ${res.status()} ${await res.text()}`)
    }
}

// Every box inside the menu column that has grown a horizontal scrollbar.
// <pre> is excluded: code blocks scroll sideways on purpose (see the copy-button
// wiring in MarkdownText), and clipping or wrapping code would be worse.
async function horizontalScrollers(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = document.querySelector('[data-testid="menu-column"]')
        if (!root) throw new Error('menu column not rendered')
        const out: string[] = []
        for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
            const h = el as HTMLElement
            if (h.tagName === 'PRE' || h.closest('pre')) continue
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

test.describe('desktop Menu column', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('long chat content does not make the chat preview widget scroll sideways', async ({ page }) => {
        await signIn(page)
        await seedChat(page, [LONG_WORD, LONG_PROSE])
        await page.goto('/')

        const column = page.getByTestId('menu-column')
        await expect(column).toBeVisible()
        // The preview clips visually, so match a substring of the DOM text.
        await expect(column.getByText(new RegExp(LONG_WORD.slice(0, 40))).first()).toBeAttached()
        await expect(column.getByText(/lorem ipsum dolor/).first()).toBeAttached()

        expect(await horizontalScrollers(page)).toEqual([])
    })

    test('long chat content does not make the docked full chat widget scroll sideways', async ({ page }) => {
        await signIn(page)
        await seedChat(page, [LONG_WORD])

        // chatWidgetFull docks the real ChatPanel (composer and all) in the
        // column instead of the read-only preview, a separate render path, and
        // the one where message bodies go through the markdown renderer.
        await page.addInitScript(() => {
            const raw = localStorage.getItem('athena-prefs')
            const prefs = raw ? JSON.parse(raw) : {}
            prefs.chatWidgetFull = true
            localStorage.setItem('athena-prefs', JSON.stringify(prefs))
        })
        await page.goto('/')

        const column = page.getByTestId('menu-column')
        await expect(column).toBeVisible()
        await expect(column.getByRole('heading', { name: 'Chat' })).toBeVisible()
        await expect(column.getByText(new RegExp(LONG_WORD.slice(0, 40))).first()).toBeAttached()

        expect(await horizontalScrollers(page)).toEqual([])
    })
})

import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// The `/` embed flow: slash menu -> searchable picker -> token in the content.
//
// Three separate faults met here. Typing `/` blew up the reactive graph (an
// effect that fed itself, ending in "Maximum call stack size exceeded"), the
// picker's search box was never focused so no keyboard navigation reached it,
// and in the docked chat widget the menu was clipped off by the widget's own
// fixed-height overflow.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

async function post<T>(req: APIRequestContext, url: string, data: unknown): Promise<T> {
    const res = await req.post(url, { data })
    if (!res.ok()) throw new Error(`POST ${url} -> ${res.status()} ${await res.text()}`)
    return (await res.json()) as T
}

// Collects anything the page throws, so a reactive blow-up fails the test
// rather than hiding behind a menu that still happens to render.
function watchForErrors(page: Page): string[] {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text())
    })
    return errors
}

const composer = (page: Page) => page.getByPlaceholder(/Write your thoughts/)
// Scoped to the picker: the seeded moments also render in the feed behind it,
// so an unscoped text match is ambiguous and would be satisfied by the feed
// before the picker has loaded anything.
const pickerList = (page: Page) => page.getByTestId('embed-picker-list')

test.describe('embed picker', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('opens from the slash menu and inserts by keyboard alone', async ({ page }) => {
        const errors = watchForErrors(page)
        await signIn(page)
        const archive = await post<{ id: string }>(page.request, '/api/v1/archives', { name: 'Embeds' })
        const first = await post<{ id: string }>(page.request, '/api/v1/moments', {
            archive_id: archive.id, title: 'Aaa first target', content: 'x', tag_ids: [],
        })
        const second = await post<{ id: string }>(page.request, '/api/v1/moments', {
            archive_id: archive.id, title: 'Bbb second target', content: 'y', tag_ids: [],
        })

        await page.goto('/')
        await composer(page).click()
        await composer(page).type('/')

        await expect(page.getByText('Insert embed')).toBeVisible()
        expect(errors, 'typing "/" should not throw').toEqual([])

        // Down then up lands back on Moment, which Enter opens.
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowUp')
        await page.keyboard.press('Enter')
        await expect(page.getByRole('heading', { name: 'Link a moment' })).toBeVisible()

        // The search box has focus without being clicked, so arrows reach it.
        const search = page.getByPlaceholder('Search…')
        await expect(search).toBeFocused()

        // The picker searches when it opens, and the heading above renders
        // before that lands. Until it does the list is empty, so Enter has
        // nothing to pick and silently does nothing. Waiting for a row is what
        // makes this deterministic; without it the test is a coin flip on
        // whether the keys or the response arrive first.
        await expect(pickerList(page).getByText('Aaa first target')).toBeVisible()

        // The list is newest-first, so ArrowDown moves from the second moment
        // to the first; Enter takes whatever is highlighted.
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')

        await expect(composer(page)).toHaveValue(`[[${first.id}]]`)
        expect(errors, 'the whole flow should be error-free').toEqual([])
        void second
    })

    test('search narrows the list and Escape backs out', async ({ page }) => {
        await signIn(page)
        await page.goto('/')
        await composer(page).click()
        await composer(page).type('/')
        await page.keyboard.press('Enter')

        const search = page.getByPlaceholder('Search…')
        await expect(search).toBeFocused()
        await search.fill('Bbb second')
        // Same load race as above: wait for the narrowed row to exist before
        // Enter, or there is nothing highlighted to take.
        await expect(pickerList(page).getByText('Bbb second target')).toBeVisible()
        await page.keyboard.press('Enter')
        await expect(composer(page)).toHaveValue(/^\[\[.+\]\]$/)

        // And Escape leaves the typed trigger alone rather than eating it.
        await composer(page).fill('')
        await composer(page).type('/')
        await page.keyboard.press('Enter')
        await expect(page.getByPlaceholder('Search…')).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByPlaceholder('Search…')).toHaveCount(0)
        await expect(composer(page)).toHaveValue('/')
    })

    test('the slash menu is not clipped inside the docked chat widget', async ({ page }) => {
        await signIn(page)
        await page.addInitScript(() => {
            const raw = localStorage.getItem('athena-prefs')
            const prefs = raw ? JSON.parse(raw) : {}
            prefs.chatWidgetFull = true
            localStorage.setItem('athena-prefs', JSON.stringify(prefs))
        })
        await page.goto('/')

        const chatBox = page.getByPlaceholder(/Message…/)
        await expect(chatBox).toBeVisible()
        await chatBox.click()
        await chatBox.type('/')

        const menu = page.getByText('Insert embed')
        await expect(menu).toBeVisible()

        // Fully on screen, and not cut off by any ancestor's overflow, which
        // is what a fixed-height widget did to it while it was positioned
        // inside the composer.
        const fits = await page.evaluate(() => {
            const label = Array.from(document.querySelectorAll('span')).find(
                (s) => s.textContent?.trim() === 'Insert embed',
            )
            const box = label?.parentElement
            if (!box) return { found: false }
            const r = box.getBoundingClientRect()
            let el: HTMLElement | null = box.parentElement
            while (el && el !== document.body) {
                const s = getComputedStyle(el)
                if (s.overflow !== 'visible') {
                    const er = el.getBoundingClientRect()
                    if (r.bottom > er.bottom + 1 || r.top < er.top - 1) return { found: true, clippedBy: el.className }
                }
                el = el.parentElement
            }
            return {
                found: true,
                clippedBy: null,
                insideViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
            }
        })
        expect(fits).toEqual({ found: true, clippedBy: null, insideViewport: true })
    })
})

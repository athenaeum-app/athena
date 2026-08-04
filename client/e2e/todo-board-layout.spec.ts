import { test, expect, type Page } from '@playwright/test'

// A to-do column is a fixed w-72 card, so everything in its header has to fit
// inside that width. The title is an <input>, and an input's automatic minimum
// width is its size attribute, about twenty characters: wider than what is left
// beside the grip and the buttons. Without min-w-0 the flex row cannot shrink
// it, so the row overflows and the trailing buttons are painted over the next
// column. The legacy look made it visible because Inter is wider than the other
// looks' body fonts, and legacy is the default look.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

async function seed(page: Page) {
    const req = page.request
    const lists = (await (await req.get('/api/v1/todos')).json()) as { title: string }[] | null
    for (const title of ['Board Daily', 'Board Writing']) {
        if (lists?.some((l) => l.title === title)) continue
        const res = await req.post('/api/v1/todos', {
            data: { title, kind: title.endsWith('Daily') ? 'daily' : 'general' },
        })
        if (!res.ok()) throw new Error(`seed ${title} -> ${res.status()} ${await res.text()}`)
    }
}

async function openBoard(page: Page, look: string) {
    await page.addInitScript((l) => localStorage.setItem('athena-active-look', l), look)
    await page.goto('/')
    await page.getByRole('button', { name: 'Todos' }).first().click()
    await expect(page.getByTestId('todo-column').first()).toBeVisible()
}

test.describe('to-do board column layout', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    // Both the default look and one with a different body font: the column is a
    // fixed width, so no font may push its contents out of it.
    for (const look of ['legacy', 'editorial']) {
        test(`nothing in a column header escapes the column under ${look}`, async ({ page }) => {
            await signIn(page)
            await seed(page)
            await openBoard(page, look)

            const columns = page.getByTestId('todo-column')
            const count = await columns.count()
            expect(count).toBeGreaterThan(1)

            for (let i = 0; i < count; i++) {
                const geo = await columns.nth(i).evaluate((el) => {
                    const column = el.getBoundingClientRect()
                    const row = el.querySelector('div')!.querySelector('div')!
                    return {
                        overflow: row.scrollWidth - row.clientWidth,
                        escaping: Array.from(row.children)
                            .map((c) => Math.round(c.getBoundingClientRect().right - column.right))
                            .filter((past) => past > 0),
                    }
                })
                expect(geo.overflow, `column ${i} header row overflows`).toBeLessThanOrEqual(0)
                expect(geo.escaping, `column ${i} has children past its right edge`).toEqual([])
            }
        })
    }
})

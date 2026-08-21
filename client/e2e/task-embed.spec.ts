import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// Referencing one piece of work rather than the thing that holds it: `::task::`
// for a to-do item, `::card::` for a project card (issue #80). Both draw the
// same row, and both write through, so a task embedded in a note is a task you
// can finish from the note.

async function post<T>(req: APIRequestContext, url: string, data: unknown): Promise<T> {
    const res = await req.post(url, { data })
    if (!res.ok()) throw new Error(`POST ${url} -> ${res.status()} ${await res.text()}`)
    return (await res.json()) as T
}

async function patch(req: APIRequestContext, url: string, data: unknown): Promise<void> {
    const res = await req.patch(url, { data })
    if (!res.ok()) throw new Error(`PATCH ${url} -> ${res.status()} ${await res.text()}`)
}

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

const LIST = 'Bindery errands'
const TASK = 'Rebind the atlas'
const PROJECT = 'The reading room'
const MILESTONE = 'Shelving'
const CARD = 'Plane the door'
const NOTE = 'What this week rests on'

const at = (daysFromToday: number) => {
    const date = new Date()
    date.setHours(12, 0, 0, 0)
    date.setDate(date.getDate() + daysFromToday)
    return date.toISOString()
}

// Idempotent: the throwaway database is wiped once per run, not per test.
async function seed(page: Page) {
    const req = page.request
    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    if (archives?.some((a) => a.name === 'WORKREF')) return

    const archive = await post<{ id: string }>(req, '/api/v1/archives', { name: 'WORKREF' })
    const list = await post<{ id: string }>(req, '/api/v1/todos', { title: LIST, kind: 'general' })
    const item = await post<{ id: string }>(req, `/api/v1/todos/${list.id}/items`, { text: TASK })
    // Overdue, so the row has to colour a date rather than only print one.
    await patch(req, `/api/v1/todo-items/${item.id}`, { due_at: at(-3) })

    const project = await post<{ id: string }>(req, '/api/v1/projects', { title: PROJECT })
    const milestone = await post<{ id: string }>(req, `/api/v1/projects/${project.id}/milestones`, { title: MILESTONE })
    const cards = await post<{ id: string }[]>(req, `/api/v1/projects/${project.id}/cards`, {
        milestone_id: milestone.id,
        titles: [CARD],
    })
    await patch(req, `/api/v1/project-cards/${cards[0].id}`, { due_at: at(0) })

    // The dead reference sits in the same body on purpose: one token pointing at
    // something deleted must not take the two beside it down with it.
    await post(req, '/api/v1/moments', {
        archive_id: archive.id,
        title: NOTE,
        content: `Blocked on:\n\n::task:${item.id}::\n\nand on:\n\n::card:${cards[0].id}::\n\nand once on:\n\n::task:deleted-task-000::`,
        tag_ids: [],
    })
}

const composer = (page: Page) => page.getByPlaceholder('Write your thoughts', { exact: false })
const menu = (page: Page) => page.getByTestId('embed-menu')
const taskRow = (page: Page) => page.getByTestId('task-embed').first()
const cardRow = (page: Page) => page.getByTestId('card-embed').first()

test.describe('a task and a card referenced on their own', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('each draws one row: what it is, where it lives, when it is due', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        await expect(taskRow(page)).toContainText(TASK)
        // The list it came off, because a title alone rarely says where it is.
        await expect(taskRow(page)).toContainText(LIST)
        await expect(taskRow(page)).toContainText(/\d/)

        await expect(cardRow(page)).toContainText(CARD)
        await expect(cardRow(page)).toContainText(PROJECT)
        await expect(cardRow(page)).toContainText(MILESTONE)

        // And the dead one beside them says so rather than rendering its token.
        await expect(page.getByText('Task unavailable')).toBeVisible()
        await expect(page.getByText('::task:deleted-task-000::')).toHaveCount(0)
    })

    test('the task is finished from the note, and put back from it', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        await expect(taskRow(page)).toContainText(TASK)

        await taskRow(page).getByTitle('Tick it off').click()
        // The row stays, unlike an agenda row: a note saying "blocked on this"
        // is worth reading precisely when the thing is finally done.
        await expect(taskRow(page)).toContainText('Done')
        await expect(taskRow(page)).toContainText(TASK)

        await page.reload()
        await expect(taskRow(page)).toContainText('Done')

        await taskRow(page).getByTitle('Put it back').click()
        await expect(taskRow(page)).not.toContainText('Done')
        await page.reload()
        await expect(taskRow(page)).not.toContainText('Done')
    })

    test('the card is finished from the note too', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        await expect(cardRow(page)).toContainText(CARD)

        await cardRow(page).getByTitle('Tick it off').click()
        await expect(cardRow(page)).toContainText('Done')

        await page.reload()
        await expect(cardRow(page)).toContainText('Done')

        await cardRow(page).getByTitle('Put it back').click()
        await expect(cardRow(page)).not.toContainText('Done')
    })
})

// The picker is the only door (ADR-0019), so it is the half that has to hold at
// both widths: the phone writes in the New Moment modal rather than in an
// inline card.
for (const [name, viewport, hasTouch] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['mobile', { width: 390, height: 844 }, true],
] as const) {
    test.describe(`picking one piece of work (${name})`, () => {
        test.use({ viewport, hasTouch })

        test('finds a task by its text and a card by its title, and stores each as its own token', async ({ page }) => {
            await signIn(page)
            await seed(page)
            await page.goto('/')
            if (hasTouch) await page.getByRole('button', { name: 'New Moment' }).first().click()

            await composer(page).click()
            await composer(page).type('[[Rebind the')
            await expect(menu(page).getByText('Task', { exact: true })).toBeVisible()
            await menu(page).getByText(TASK).click()
            await expect(composer(page)).toHaveValue(/^::task:[A-Za-z0-9_-]+::$/)

            await composer(page).fill('')
            await composer(page).type('[[Plane the')
            await expect(menu(page).getByText('Card', { exact: true })).toBeVisible()
            await menu(page).getByText(CARD).click()
            await expect(composer(page)).toHaveValue(/^::card:[A-Za-z0-9_-]+::$/)
        })
    })
}

test.describe('the same two rows on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('read and tick inside the reader, without running off the side of it', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')
        // The phone shows one moment at a time, and a pin from any other spec
        // sits ahead of everything in the swiper. Searching drops the pinned
        // prefix as well as narrowing, so the card on screen is this one.
        await page.locator('i.fa-magnifying-glass').first().evaluate((el) => (el as HTMLElement).click())
        await page.getByPlaceholder('Search Moments').fill(NOTE)
        await expect(page.getByRole('heading', { name: NOTE })).toBeVisible()

        // The swiper card carries no live embeds by design, so the rows are read
        // where the moment is read: tapping the card opens the focused reader.
        const heading = page.getByRole('heading', { name: NOTE })
        const box = await heading.boundingBox()
        expect(box).not.toBeNull()
        await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
        await expect(page.getByTitle('Edit this moment')).toBeVisible()

        await expect(taskRow(page)).toContainText(TASK)
        await expect(cardRow(page)).toContainText(CARD)

        for (const row of [taskRow(page), cardRow(page)]) {
            const rowBox = await row.boundingBox()
            expect(rowBox).not.toBeNull()
            expect(rowBox!.x).toBeGreaterThanOrEqual(0)
            expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(390)
        }

        // The tick is a finger-sized target here too, and it writes through.
        await taskRow(page).getByTitle('Tick it off').click()
        await expect(taskRow(page)).toContainText('Done')
        await taskRow(page).getByTitle('Put it back').click()
        await expect(taskRow(page)).not.toContainText('Done')
    })
})

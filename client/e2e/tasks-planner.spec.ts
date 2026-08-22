import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// The Tasks module's planner (issue #85): the same surface the Projects
// overview draws, so a chore that belongs to no project can finally be given a
// day. It carries a scope, because a chore and a milestone are the same
// question to whoever is looking at a Tuesday.

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

const LIST = 'House'
const CHORE = 'Descale the kettle'
const SECOND_CHORE = 'Bleed the radiators'
const UNDATED = 'Book the chimney sweep'
const DAILY_ITEM = 'Take the vitamins'
const PROJECT = 'The reading room'
const CARD = 'Plane the door'

// Idempotent: the throwaway database is wiped once per run, not per test.
async function seed(page: Page) {
    const req = page.request
    const lists = (await (await req.get('/api/v1/todos')).json()) as { title: string }[] | null
    if (lists?.some((l) => l.title === LIST)) return

    const today = new Date()
    today.setHours(12, 0, 0, 0)

    const list = await post<{ id: string }>(req, '/api/v1/todos', { title: LIST, kind: 'general' })
    const dated = await post<{ id: string }>(req, `/api/v1/todos/${list.id}/items`, { text: CHORE })
    await patch(req, `/api/v1/todo-items/${dated.id}`, { due_at: today.toISOString(), priority: 3 })
    // Two more on the same day, one of them finished, so the list has enough
    // on that day to be drawn as the thing holding them.
    const second = await post<{ id: string }>(req, `/api/v1/todos/${list.id}/items`, { text: SECOND_CHORE })
    await patch(req, `/api/v1/todo-items/${second.id}`, { due_at: today.toISOString() })
    const finished = await post<{ id: string }>(req, `/api/v1/todos/${list.id}/items`, { text: 'Refill the salt' })
    await patch(req, `/api/v1/todo-items/${finished.id}`, { due_at: today.toISOString() })
    await patch(req, `/api/v1/todo-items/${finished.id}`, { done: true })
    await post(req, `/api/v1/todos/${list.id}/items`, { text: UNDATED })

    // A daily list, which the planner leaves out entirely: its items carry no
    // date you can see or set, so a tray offering to schedule one would be
    // offering something that cannot be done.
    const daily = await post<{ id: string }>(req, '/api/v1/todos', { title: 'Every day', kind: 'daily' })
    await post(req, `/api/v1/todos/${daily.id}/items`, { text: DAILY_ITEM })

    const project = await post<{ id: string }>(req, '/api/v1/projects', { title: PROJECT })
    const milestone = await post<{ id: string }>(req, `/api/v1/projects/${project.id}/milestones`, { title: 'Shelving' })
    const cards = await post<{ id: string }[]>(req, `/api/v1/projects/${project.id}/cards`, {
        milestone_id: milestone.id,
        titles: [CARD],
    })
    await patch(req, `/api/v1/project-cards/${cards[0].id}`, { due_at: today.toISOString() })
}

// Ticking is the one thing in this file that changes the seeded database, and
// the database outlives the test that did it: the same tests run again at the
// other viewport and find a chore already done. Put it back by hand.
async function untick(page: Page, text: string) {
    const lists = (await (await page.request.get('/api/v1/todos')).json()) as { items: { id: string; text: string }[] | null }[]
    const item = (lists ?? []).flatMap((list) => list.items ?? []).find((i) => i.text === text)
    if (item) await patch(page.request, `/api/v1/todo-items/${item.id}`, { done: false })
}

const planner = (page: Page) => page.getByTestId('tasks-planner')
const scope = (page: Page, name: string) => page.getByTestId('planner-scope').getByText(name, { exact: true })

async function openPlanner(page: Page, mobile: boolean) {
    await page.goto('/')
    if (mobile) await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('button', { name: 'Todos' }).first().click()
    await page.getByRole('button', { name: 'Planner' }).first().click()
    await expect(planner(page)).toBeVisible()
}

for (const [name, viewport, mobile] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['mobile', { width: 390, height: 844 }, true],
] as const) {
    test.describe(`the tasks planner (${name})`, () => {
        test.use({ viewport, hasTouch: mobile })

        test('draws both halves of what is due, and scopes to either', async ({ page }) => {
            await signIn(page)
            await seed(page)
            await openPlanner(page, mobile)

            // The timeline opens it: seven columns of a month in 390 pixels is
            // too narrow to read a title in, and dropping is a pointer gesture.
            await expect(page.getByTestId('agenda-timeline')).toBeVisible()

            // Everything, which is the point: a chore beside a project's card.
            await expect(planner(page).getByTestId('agenda-task').first()).toContainText(CHORE)
            await expect(planner(page).getByTestId('agenda-card').first()).toContainText(CARD)
            // A daily item is not schedulable, so it is not here.
            await expect(planner(page)).not.toContainText(DAILY_ITEM)

            await scope(page, 'Tasks').click()
            await expect(planner(page).getByTestId('agenda-card')).toHaveCount(0)
            await expect(planner(page).getByTestId('agenda-task').first()).toContainText(CHORE)

            await scope(page, 'Projects').click()
            await expect(planner(page).getByTestId('agenda-task')).toHaveCount(0)
            await expect(planner(page).getByTestId('agenda-card').first()).toContainText(CARD)

            // Kept, like every other view choice here.
            await page.reload()
            await openPlanner(page, mobile)
            await expect(planner(page).getByTestId('agenda-task')).toHaveCount(0)
        })

        test('draws a list as the thing holding its tasks, with a meter', async ({ page }) => {
            await signIn(page)
            await seed(page)
            await openPlanner(page, mobile)
            await scope(page, 'Tasks').click()

            // Two of the seeded chores fall on today, so the list is worth
            // drawing as what holds them. One of the two is already done.
            const container = planner(page).getByTestId('agenda-list').first()
            await expect(container).toContainText(LIST)
            await expect(container).toContainText('1/3 done')
            // It has no date of its own, so there is nothing to pick up.
            await expect(container).toHaveAttribute('draggable', 'false')

            // Ticking one underneath fills the meter rather than emptying the
            // day: a container counts what is finished as well as what is not.
            await planner(page)
                .getByTestId('agenda-task')
                .filter({ hasText: CHORE })
                .first()
                .getByTestId('agenda-complete')
                .click()
            await expect(planner(page).getByTestId('agenda-list').first()).toContainText('2/3 done')

            await untick(page, CHORE)
        })

        test('keeps the undated in a tray, which is where a chore starts', async ({ page }) => {
            await signIn(page)
            await seed(page)
            await openPlanner(page, mobile)
            await scope(page, 'Tasks').click()

            const tray = page.getByTestId('agenda-unscheduled')
            await expect(tray).toContainText(UNDATED)
            // Dated work is on a day, not in the pile.
            await expect(tray).not.toContainText(CHORE)
        })

        // Issue #87. Being allowed to drag and being able to are different
        // questions, and every surface here used to ask only the first, so a
        // phone was told to make a gesture that fires no dragstart at all.
        // `hasTouch: true` is what makes Chromium report (pointer: coarse),
        // so the mobile half of this fails against the un-fixed client.
        test('explains the drag only where a pointer can make one', async ({ page }) => {
            await signIn(page)
            await seed(page)
            await openPlanner(page, mobile)
            await scope(page, 'Tasks').click()

            const trayHint = page.getByTestId('agenda-unscheduled').getByText(/Drag one onto a day/)
            const row = page.getByTestId('agenda-unscheduled').getByTestId('agenda-task').first()

            await page.getByTestId('agenda-view').getByTitle('Calendar').click()
            const calendarHint = page.getByText(/Drop one on a day to date it/)

            if (mobile) {
                await expect(calendarHint).toHaveCount(0)
                await page.getByTestId('agenda-view').getByTitle('Timeline').click()
                await expect(trayHint).toHaveCount(0)
                // The tooltip is the third surface saying it, and the one a
                // fix aimed at the two paragraphs would leave behind.
                await expect(row).toHaveAttribute('title', /^Open /)
            } else {
                await expect(calendarHint).toBeVisible()
                await page.getByTestId('agenda-view').getByTitle('Timeline').click()
                await expect(trayHint).toBeVisible()
                await expect(row).toHaveAttribute('title', /^Drag to a day/)
            }

            // Either way the tray still lists what has no date: a chore is
            // dated from the item itself where it cannot be dragged.
            await expect(page.getByTestId('agenda-unscheduled')).toContainText(UNDATED)
        })
    })
}

// Dragging is the whole point of drawing the days, and it is HTML5 drag and
// drop, so it is a pointer gesture: desktop only, the same as the Projects
// overview's own drag test.
test.describe('scheduling from the tasks planner', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('a chore takes a date from a day in a month, and keeps it', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await openPlanner(page, false)
        await page.getByTestId('agenda-view').getByTitle('Calendar').click()
        await expect(page.getByTestId('agenda-calendar')).toBeVisible()

        // The last cell is weeks past the end of the fortnight, which is the
        // day that could not be reached from the Tasks module at all before.
        await page.dragAndDrop(
            `[data-testid="agenda-unscheduled"] >> text=${UNDATED}`,
            '[data-testid="calendar-day"] >> nth=41',
        )
        await expect(page.getByTestId('calendar-day').last()).toContainText(UNDATED)
        await expect(page.getByTestId('agenda-unscheduled')).not.toContainText(UNDATED)

        // On the server, not only on the screen.
        await page.reload()
        await openPlanner(page, false)
        await expect(page.getByTestId('agenda-calendar')).toBeVisible()
        await expect(page.getByTestId('calendar-day').last()).toContainText(UNDATED)
    })

    test('a project card is finished from here, which the agenda used to refuse', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await openPlanner(page, false)

        const card = planner(page).getByTestId('agenda-card').filter({ hasText: CARD }).first()
        await expect(card).toBeVisible()
        await card.getByTestId('agenda-complete').click()

        // Finished work leaves the planner: a planner is what is left.
        await expect(planner(page).getByTestId('agenda-card').filter({ hasText: CARD })).toHaveCount(0)
    })
})

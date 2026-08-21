import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

// The agenda embed (ADR-0021): the first token that names a view rather than an
// entity. `::agenda::` is everything due, and the two scoped forms are each
// half of it. It is live in both directions: it reads to-do items and project
// deadlines through the one agenda module the Tasks view uses, and ticking a
// row off here drops it from every other agenda on the page.

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

const OVERDUE_TASK = 'Return the library books'
const TODAY_TASK = 'Proof the colophon'
const UNDATED_TASK = 'Someday, learn bookbinding'
const PROJECT_CARD = 'Sand the shelves'

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
    if (archives?.some((a) => a.name === 'AGENDA')) return

    const archive = await post<{ id: string }>(req, '/api/v1/archives', { name: 'AGENDA' })
    const list = await post<{ id: string }>(req, '/api/v1/todos', { title: 'The week', kind: 'general' })
    for (const [text, due] of [
        [OVERDUE_TASK, at(-2)],
        [TODAY_TASK, at(0)],
        [UNDATED_TASK, ''],
    ] as const) {
        const item = await post<{ id: string }>(req, `/api/v1/todos/${list.id}/items`, { text })
        if (due) await patch(req, `/api/v1/todo-items/${item.id}`, { due_at: due })
    }

    const project = await post<{ id: string; milestones: { id: string }[] }>(req, '/api/v1/projects', { title: 'The kitchen' })
    const milestone = await post<{ id: string }>(req, `/api/v1/projects/${project.id}/milestones`, { title: 'Carcass' })
    const cards = await post<{ id: string }[]>(req, `/api/v1/projects/${project.id}/cards`, {
        milestone_id: milestone.id,
        titles: [PROJECT_CARD],
    })
    await patch(req, `/api/v1/project-cards/${cards[0].id}`, { due_at: at(0) })

    // All three scopes in one body, so their order and their independence are
    // both readable from one moment.
    await post(req, '/api/v1/moments', {
        archive_id: archive.id,
        title: 'What today looks like',
        content: `Everything:\n\n::agenda::\n\nTasks:\n\n::agenda:tasks::\n\nProjects:\n\n::agenda:projects::`,
        tag_ids: [],
    })
}

test.describe('the agenda embedded in a moment', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('draws what is due, in the scope the token asked for', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        const cards = page.getByTestId('agenda-embed')
        await expect(cards).toHaveCount(3)
        const [everything, tasks, projects] = [cards.nth(0), cards.nth(1), cards.nth(2)]

        // Everything due, grouped, with the overdue task above today's work.
        await expect(everything).toContainText('Overdue')
        await expect(everything).toContainText('Today')
        await expect(everything).toContainText(OVERDUE_TASK)
        await expect(everything).toContainText(TODAY_TASK)
        await expect(everything).toContainText(PROJECT_CARD)
        // An agenda is what is due. A task with no date is not on it.
        await expect(everything).not.toContainText(UNDATED_TASK)

        // Each half holds its own and nothing of the other's.
        await expect(tasks).toContainText(TODAY_TASK)
        await expect(tasks).not.toContainText(PROJECT_CARD)
        await expect(projects).toContainText(PROJECT_CARD)
        await expect(projects).not.toContainText(TODAY_TASK)
        // A project row says where the work lives, since the title alone rarely
        // does.
        await expect(projects).toContainText('The kitchen')
    })

    // The picker is the only door (ADR-0019), and a kind whose candidates are a
    // fixed list of three is still a kind: nothing here should have to be typed
    // by hand.
    test('is offered by the picker, and stores as its scope', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        const composer = page.getByPlaceholder('Write your thoughts', { exact: false })
        await composer.click()
        await composer.type('[[agenda')
        const menu = page.getByTestId('embed-menu')
        await expect(menu.getByText('Agenda: everything due')).toBeVisible()
        await expect(menu.getByText('Agenda: tasks only')).toBeVisible()
        await expect(menu.getByText('Agenda: project work only')).toBeVisible()

        await menu.getByText('Agenda: tasks only').click()
        await expect(composer).toHaveValue('::agenda:tasks::')
    })

    test('a task ticked off here leaves every agenda on the page', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        const cards = page.getByTestId('agenda-embed')
        const everything = cards.nth(0)
        const tasks = cards.nth(1)
        await expect(everything).toContainText(OVERDUE_TASK)

        await everything.locator('div').filter({ hasText: OVERDUE_TASK }).getByTitle('Tick it off').first().click()

        // Gone from the card it was ticked in, and from the other one, which
        // never heard the click: both read the same agenda.
        await expect(everything).not.toContainText(OVERDUE_TASK)
        await expect(tasks).not.toContainText(OVERDUE_TASK)
        // And it stays gone across a reload, so the tick was written down.
        await page.reload()
        await expect(page.getByTestId('agenda-embed').first()).not.toContainText(OVERDUE_TASK)
    })
})

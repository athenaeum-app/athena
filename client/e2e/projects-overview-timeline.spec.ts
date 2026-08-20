import { test, expect, type Page } from '@playwright/test'

// The portfolio overview's agenda draws as a timeline: a column per day for a
// fortnight, with what has already passed and what falls beyond the run kept
// at either end. The setting behind it defaults on, and the button on the card
// swaps the run between across and down.
//
// Both viewports, because that is exactly what the two directions are for: a
// row of day columns wants a wide window, and the phone wants them stacked.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
    const res = await page.request.post(url, { data })
    if (!res.ok()) throw new Error(`POST ${url} -> ${res.status()} ${await res.text()}`)
    return (await res.json()) as T
}

async function patch(page: Page, url: string, data: unknown): Promise<void> {
    const res = await page.request.patch(url, { data })
    if (!res.ok()) throw new Error(`PATCH ${url} -> ${res.status()} ${await res.text()}`)
}

const day = (n: number) => {
    const date = new Date()
    date.setHours(12, 0, 0, 0)
    date.setDate(date.getDate() + n)
    return date.toISOString()
}

// One project with a deadline in each of the three places the timeline has to
// put something: behind today, on a day it draws, and past the end of the run.
async function seed(page: Page, title: string): Promise<void> {
    const project = await post<{ id: string }>(page, '/api/v1/projects', { title })
    const milestone = await post<{ id: string }>(page, `/api/v1/projects/${project.id}/milestones`, { title: `${title} phase one` })
    const cards = await post<{ id: string }[]>(page, `/api/v1/projects/${project.id}/cards`, {
        milestone_id: milestone.id,
        titles: [`${title} overdue`, `${title} today`, `${title} next week`, `${title} much later`],
    })
    const dates = [-3, 0, 5, 40]
    for (let i = 0; i < cards.length; i++) await patch(page, `/api/v1/project-cards/${cards[i].id}`, { due_at: day(dates[i]) })
}

for (const shell of [
    { name: 'desktop', viewport: { width: 1440, height: 900 }, hasTouch: false, mobile: false },
    { name: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true, mobile: true },
] as const) {
    test.describe(`the overview timeline (${shell.name})`, () => {
        test.use({ viewport: shell.viewport, hasTouch: shell.hasTouch })

        test('runs across by default, turns down, and gives way to the list', async ({ page }) => {
            await signIn(page)
            const title = `Timeline ${shell.name}`
            await seed(page, title)

            await page.goto('/')
            if (shell.mobile) await page.getByRole('button', { name: 'More' }).click()
            await page.getByRole('button', { name: 'Projects' }).click()
            await expect(page.getByTestId('projects-overview')).toBeVisible()

            // The setting is on out of the box, so the timeline is what a new
            // reader sees.
            const timeline = page.getByTestId('agenda-timeline')
            await expect(timeline).toBeVisible()
            await expect(page.getByTestId('agenda-list')).toHaveCount(0)

            // Today is a column of its own; the two ends hold what no column
            // can show.
            await expect(timeline.getByText('Today', { exact: true })).toBeVisible()
            await expect(timeline.getByText('Overdue', { exact: true })).toBeVisible()
            await expect(timeline.getByText('Later', { exact: true })).toBeVisible()
            await expect(timeline.getByRole('button', { name: new RegExp(`${title} today`) })).toBeVisible()

            // Down and back again. The choice is a preference, so it survives
            // a reload.
            await page.getByTitle('Timeline down').click()
            await expect(page.getByTestId('agenda-timeline')).toBeVisible()
            await page.reload()
            if (shell.mobile) await page.getByRole('button', { name: 'More' }).click()
            await page.getByRole('button', { name: 'Projects' }).click()
            await expect(page.getByTitle('Timeline down')).toHaveClass(/bg-highlight-strongest/)
            await page.getByTitle('Timeline across').click()

            // A deadline still opens the board it lives on, timeline or not.
            await page.getByRole('button', { name: new RegExp(`${title} today`) }).click()
            await expect(page.getByRole('button', { name: 'Graveyard' })).toBeVisible()
        })

        test('the setting turns it back into a grouped list', async ({ page }) => {
            await signIn(page)
            await seed(page, `Listed ${shell.name}`)

            await page.goto('/')
            await page.evaluate(() => {
                const stored = JSON.parse(localStorage.getItem('athena-prefs') || '{}')
                stored.projectsAgendaTimeline = false
                localStorage.setItem('athena-prefs', JSON.stringify(stored))
            })
            await page.reload()
            if (shell.mobile) await page.getByRole('button', { name: 'More' }).click()
            await page.getByRole('button', { name: 'Projects' }).click()

            await expect(page.getByTestId('agenda-list')).toBeVisible()
            await expect(page.getByTestId('agenda-timeline')).toHaveCount(0)
            // No timeline, nothing to point it in a direction.
            await expect(page.getByTitle('Timeline down')).toHaveCount(0)
        })
    })
}

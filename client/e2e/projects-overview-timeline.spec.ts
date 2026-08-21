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
        // The last one keeps no date: the tray has to have something in it.
        titles: [`${title} overdue`, `${title} today`, `${title} next week`, `${title} much later`, `${title} undated`],
    })
    const dates = [-3, 0, 5, 40]
    for (let i = 0; i < dates.length; i++) await patch(page, `/api/v1/project-cards/${cards[i].id}`, { due_at: day(dates[i]) })
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

            // The screen scrolls; nothing inside it does, bar the tray when
            // it holds more than it can show. A box that scrolls two pixels
            // of its own scrollbar gutter is the fault being guarded here.
            const strays = await page.getByTestId('projects-overview').evaluate((root: HTMLElement) =>
                [...root.querySelectorAll('*')]
                    .filter((el) => {
                        const e = el as HTMLElement
                        if (e.closest('[data-testid="agenda-unscheduled"]')) return false
                        return e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY !== 'visible'
                    })
                    .map((el) => (el as HTMLElement).className),
            )
            expect(strays).toEqual([])

            // A card opens the card itself, wherever it was clicked from.
            await page.getByRole('button', { name: new RegExp(`${title} today`) }).click()
            const card = page.getByTestId('project-card-modal')
            await expect(card).toBeVisible()
            // The title is an editable field, so it is read as a value.
            await expect(card.locator('input[type="text"]').first()).toHaveValue(`${title} today`)
            // And it is the real card, writing to the real project: the
            // portfolio is still behind it, not a project's board.
            await card.getByTitle('Close').click()
            await expect(page.getByTestId('projects-overview')).toBeVisible()

            // A milestone still opens the board. A milestone is a column, and
            // a column has no modal of its own.
            await page.getByTestId('agenda-unscheduled').getByTestId('agenda-milestone').first().click()
            await expect(page.getByRole('button', { name: 'Graveyard' })).toBeVisible()
        })

        test('a card is finished from the agenda itself', async ({ page }) => {
            await signIn(page)
            const title = `Ticked ${shell.name}`
            await seed(page, title)

            await page.goto('/')
            if (shell.mobile) await page.getByRole('button', { name: 'More' }).click()
            await page.getByRole('button', { name: 'Projects' }).click()
            // Scoped to the agenda: once it is finished the same words turn
            // up again under Recently finished, which is the point.
            const row = page.getByTestId('agenda-timeline').getByRole('button', { name: new RegExp(`${title} today`) })
            await expect(row).toBeVisible()

            // Ticking it finishes it, and finished work is not outstanding, so
            // it leaves the agenda rather than sitting there struck through.
            await row.getByTestId('agenda-complete').click()
            await expect(row).toHaveCount(0)
            await expect(page.getByText(`Marked "${title} today" done.`)).toBeVisible()

            // Written down, not only crossed out on screen. It comes back as
            // one of the recently finished.
            await page.reload()
            if (shell.mobile) await page.getByRole('button', { name: 'More' }).click()
            await page.getByRole('button', { name: 'Projects' }).click()
            await expect(page.getByRole('button', { name: new RegExp(`${title} today`) })).toHaveCount(1)
            await expect(page.getByRole('button', { name: new RegExp(`check_circle ${title} today`) })).toBeVisible()

            // A milestone carries no tick: it is finished by its cards. It is
            // also drawn as a different kind of thing entirely, saying what it
            // is and how far the work inside it has got.
            const milestone = page.getByTestId('agenda-unscheduled').getByTestId('agenda-milestone').first()
            await expect(milestone).toBeVisible()
            await expect(milestone).toContainText('Milestone')
            // 1/5, not 0/5: the card ticked off a moment ago was one of the
            // five inside this milestone, and the meter says so at once.
            await expect(milestone).toContainText('1/5 done')
            await expect(milestone.getByTestId('agenda-complete')).toHaveCount(0)
            // A card is not a milestone, and says which one it belongs to.
            const card = page.getByTestId('agenda-unscheduled').getByTestId('agenda-card').first()
            await expect(card).toContainText(`${title} phase one`)
            await expect(card).not.toContainText('Milestone')
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

// Dragging is the whole point of drawing the fortnight: a date is changed by
// moving the thing to the day it belongs on. Desktop only, because this is
// HTML5 drag and drop, the same mechanism the board's cards use.
test.describe('scheduling by drag', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('a day takes a drop, and the tray gives its date back', async ({ page }) => {
        await signIn(page)
        const title = 'Dragged'
        await seed(page, title)

        await page.goto('/')
        await page.getByRole('button', { name: 'Projects' }).click()
        const tray = page.getByTestId('agenda-unscheduled')
        const today = page.getByTestId('agenda-day').first()

        // Undated to begin with, so it starts in the tray.
        await expect(tray.getByRole('button', { name: new RegExp(`${title} undated`) })).toBeVisible()

        await page.dragAndDrop(
            `[data-testid="agenda-unscheduled"] >> text=${title} undated`,
            '[data-testid="agenda-day"] >> nth=0',
        )
        await expect(today.getByRole('button', { name: new RegExp(`${title} undated`) })).toBeVisible()
        await expect(tray.getByRole('button', { name: new RegExp(`${title} undated`) })).toHaveCount(0)

        // The date is on the server, not only on the screen.
        await page.reload()
        await page.getByRole('button', { name: 'Projects' }).click()
        await expect(page.getByTestId('agenda-day').first().getByRole('button', { name: new RegExp(`${title} undated`) })).toBeVisible()

        // And back to the tray takes the date off again.
        await page.dragAndDrop(
            `[data-testid="agenda-day"] >> nth=0 >> text=${title} undated`,
            '[data-testid="agenda-unscheduled"]',
        )
        await expect(page.getByTestId('agenda-unscheduled').getByRole('button', { name: new RegExp(`${title} undated`) })).toBeVisible()
        await page.reload()
        await page.getByRole('button', { name: 'Projects' }).click()
        await expect(page.getByTestId('agenda-unscheduled').getByRole('button', { name: new RegExp(`${title} undated`) })).toBeVisible()
    })
})

import { test, expect, type Page } from '@playwright/test'

// A board card's note lived entirely behind the card modal: the only hint that
// one existed was the small "notes" glyph in the card's meta row, which says a
// body is there but nothing about what it says. The card now carries a
// two-line flattened excerpt under its title, so a column can be read without
// opening anything. A body that flattens to no text at all (an image or an
// embed on its own) still gets the glyph and no excerpt line.
//
// prefs.projectCardNoteHint trades that excerpt for a plain "Contains notes"
// in the card's corner, for a column read as a list of titles. The excerpt is
// the default.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

async function seedBoard(page: Page, title: string): Promise<void> {
    const post = async (url: string, data: unknown) => {
        const res = await page.request.post(url, { data })
        if (!res.ok()) throw new Error(`POST ${url} -> ${res.status()} ${await res.text()}`)
        return res.json()
    }
    const project = await post('/api/v1/projects', { title })
    const milestone = await post(`/api/v1/projects/${project.id}/milestones`, { title: 'Now' })
    const cards = await post(`/api/v1/projects/${project.id}/cards`, {
        milestone_id: milestone.id,
        titles: ['Card with a note', 'Card without a note', 'Card with a picture note'],
    })
    const byTitle = (t: string) => cards.find((c: { title: string }) => c.title === t).id
    await page.request.patch(`/api/v1/project-cards/${byTitle('Card with a note')}`, {
        data: { body: 'The **ferry** leaves at six, so the survey has to be packed the night before.' },
    })
    await page.request.patch(`/api/v1/project-cards/${byTitle('Card with a picture note')}`, {
        data: { body: '![the jetty](/api/v1/assets/none)' },
    })
}

async function openBoard(page: Page, project: string, mobile: boolean): Promise<void> {
    await page.goto('/')
    if (mobile) await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('button', { name: 'Projects' }).click()
    await expect(page.getByTestId('projects-panel')).toBeVisible()
    await page.getByText(project).first().click()
    await page.getByTitle('Board view').click()
}

for (const shell of [
    { name: 'desktop', width: 1440, height: 900, mobile: false },
    { name: 'mobile', width: 390, height: 844, mobile: true },
] as const) {
    test(`a board card shows a preview of its note (${shell.name})`, async ({ page }) => {
        await signIn(page)
        const project = `Note Preview ${shell.name}`
        await seedBoard(page, project)
        await page.setViewportSize({ width: shell.width, height: shell.height })
        await openBoard(page, project, shell.mobile)

        await expect(page.getByText('The ferry leaves at six', { exact: false })).toBeVisible()
        // Flattened, not rendered: the bold markers do not survive the excerpt.
        await expect(page.getByText('**ferry**', { exact: false })).toHaveCount(0)
        // Two cards carry a body, so two glyphs; only one of them has text.
        await expect(page.locator('[title="Has a body"]')).toHaveCount(2)
        await expect(page.getByText('the jetty', { exact: false })).toHaveCount(0)
        // The excerpt is the default, so nothing here said "Contains notes".
        await expect(page.getByText('Contains notes')).toHaveCount(0)
    })
}

test.describe('the note hint setting', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('trades the excerpt for a plain mention', async ({ page }) => {
        await signIn(page)
        const project = 'Note Hint Setting'
        await seedBoard(page, project)

        await page.goto('/')
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        // The Projects section lives under Modals, beside the window sizes.
        await page.getByRole('button', { name: 'Modals' }).first().click()
        const hint = page.getByTestId('project-card-note-hint')
        await hint.scrollIntoViewIfNeeded()
        await expect(hint.getByRole('button', { name: 'Preview' })).toHaveClass(/border-highlight/)
        await hint.getByRole('button', { name: 'Just a mention' }).click()

        await openBoard(page, project, false)
        // Both cards carrying a note get the mention, the picture-only one
        // included, and it replaces the glyph rather than doubling up with it.
        await expect(page.getByText('Contains notes')).toHaveCount(2)
        await expect(page.getByText('The ferry leaves at six', { exact: false })).toHaveCount(0)
        await expect(page.locator('[title="Has a body"]')).toHaveCount(0)
    })
})

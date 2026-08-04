import { test, expect, type Page } from '@playwright/test'

// The composer's writing area takes the room its chrome has to give.
//
// The edit modal is a fixed 90vh box, so its textarea fills what the title,
// toolbar and tags leave behind instead of sitting at a fixed twelve rows with
// dead space under it. The inline card has no height of its own to divide, so
// it tracks its text instead, and both are capped: the modal by the window, the
// card by GROW_CAP, so a long draft can never push the feed off the screen.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

const body = (page: Page) => page.getByPlaceholder('Write your thoughts', { exact: false })
const height = async (page: Page) => (await body(page).boundingBox())!.height

const LINES = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long draft.`).join('\n')

const TITLE = 'A moment to edit'

// A moment to open the edit modal on: the desktop modal is reached by editing,
// since composing there happens in the inline card.
async function seed(page: Page) {
    const req = page.request
    const existing = (await (await req.get('/api/v1/moments')).json()) as { title: string }[] | null
    if (existing?.some((m) => m.title === TITLE)) return

    const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
    const archive =
        archives?.find((a) => a.name === 'Composing') ??
        ((await (await req.post('/api/v1/archives', { data: { name: 'Composing' } })).json()) as { id: string })
    const res = await req.post('/api/v1/moments', {
        data: { archive_id: archive.id, title: TITLE, content: 'A short body.', tag_ids: [] },
    })
    if (!res.ok()) throw new Error(`seed -> ${res.status()} ${await res.text()}`)
}

test.describe('composer height, desktop', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('the inline card grows with its text, up to the cap', async ({ page }) => {
        await signIn(page)
        await page.goto('/')

        const empty = await height(page)
        // The floor: a comfortable box before anything is typed.
        expect(empty).toBeGreaterThanOrEqual(170)

        await body(page).fill(Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n'))
        const grown = await height(page)
        expect(grown).toBeGreaterThan(empty)

        // The cap: 60vh of a 900px window, and it holds under a much longer
        // draft rather than running the card off the page.
        await body(page).fill(LINES)
        const capped = await height(page)
        expect(capped).toBeGreaterThan(grown)
        expect(capped).toBeLessThanOrEqual(900 * 0.6 + 1)

        // Deleting the text gives the room back.
        await body(page).fill('one line')
        expect(await height(page)).toBeLessThanOrEqual(empty + 1)
    })

    test('the edit modal fills the space its chrome leaves over', async ({ page }) => {
        await signIn(page)
        await seed(page)
        await page.goto('/')

        const inline = await height(page)

        const card = page.locator('[data-moment-id]').filter({ hasText: TITLE }).first()
        await card.hover()
        await card.locator('i.fa-pencil').click()
        // Scoped: the inline composer behind the modal has the same placeholder.
        const modal = page.locator('.fixed').filter({ hasText: 'Edit Moment' }).first()
        await expect(modal.getByRole('heading', { name: 'Edit Moment' })).toBeVisible()
        const area = modal.getByPlaceholder('Write your thoughts', { exact: false })

        const box = (await area.boundingBox())!
        // Taller than the inline card, and past the twelve fixed rows it used
        // to sit at, which is the complaint: the room was always there.
        expect(box.height).toBeGreaterThan(inline)
        expect(box.height).toBeGreaterThan(300)

        // Filling rather than merely tall: what is left under the writing area
        // is the tag field and the footer, not dead space.
        const shell = (await modal.locator('div').first().boundingBox())!
        const below = shell.y + shell.height - (box.y + box.height)
        expect(below).toBeLessThan(shell.height * 0.35)
        // And it still fits inside the window.
        expect(box.y + box.height).toBeLessThanOrEqual(900)
    })
})

test.describe('composer height, desktop, heavily tagged', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    // The 2.15.0 regression: the writing area sizes from a zero flex basis, so
    // thirty unshrinkable tag chip rows squeezed it down to its floor with the
    // chips pressed against the clipped text. The floor is now the twelve rows
    // the modal always had, and the chip strip scrolls past three rows.
    test('tag chips cannot squash the writing area below its old height', async ({ page }) => {
        await signIn(page)

        const req = page.request
        const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
        const archive =
            archives?.find((a) => a.name === 'Composing') ??
            ((await (await req.post('/api/v1/archives', { data: { name: 'Composing' } })).json()) as { id: string })
        const tags = (await (await req.get('/api/v1/tags')).json()) as { id: string; name: string }[] | null
        const ids: string[] = []
        for (let i = 0; i < 30; i++) {
            const name = `crowd-${String(i).padStart(2, '0')}`
            const found = tags?.find((t) => t.name === name)
            ids.push(
                found?.id ??
                    ((await (await req.post('/api/v1/tags', { data: { name, color: '#8899aa' } })).json()) as { id: string }).id,
            )
        }
        const moments = (await (await req.get('/api/v1/moments')).json()) as { id: string; title: string }[] | null
        let m = moments?.find((x) => x.title === 'A crowded moment')
        if (!m) {
            m = (await (
                await req.post('/api/v1/moments', {
                    data: { archive_id: archive.id, title: 'A crowded moment', content: 'A body.', tag_ids: ids },
                })
            ).json()) as { id: string }
        }

        await page.goto('/')
        const card = page.locator(`[data-moment-id="${m.id}"]`).first()
        await card.hover()
        await card.locator('i.fa-pencil').click()
        const modal = page.locator('.fixed').filter({ hasText: 'Edit Moment' }).first()
        await expect(modal.getByRole('heading', { name: 'Edit Moment' })).toBeVisible()

        const area = modal.getByPlaceholder('Write your thoughts', { exact: false })
        // The old fixed twelve rows, as a floor: tags may not take it lower.
        expect((await area.boundingBox())!.height).toBeGreaterThanOrEqual(255)

        // The chip strip is the part that gives: capped and scrolling.
        const strip = modal.getByTestId('selected-tags')
        await expect(strip).toBeVisible()
        expect((await strip.boundingBox())!.height).toBeLessThanOrEqual(28 * 4 + 1)
    })
})

test.describe('composer height, crowded column', () => {
    // A laptop, where the modal has least room to give.
    test.use({ viewport: { width: 1280, height: 800 } })

    // The 2.15.0/2.15.1 regression proper. The writing area is a flex-1 item,
    // so it sizes from a zero basis and collapses when the column overflows,
    // which a full tag suggestion list (~190px, in the layout flow) is enough
    // to cause. Its min-height lived on the textarea rather than on the box, so
    // the box shrank and the textarea painted its text over the tags beneath.
    test('the writing area never paints outside its own box', async ({ page }) => {
        await signIn(page)

        const req = page.request
        const archives = (await (await req.get('/api/v1/archives')).json()) as { id: string; name: string }[]
        const archive =
            archives?.find((a) => a.name === 'Composing') ??
            ((await (await req.post('/api/v1/archives', { data: { name: 'Composing' } })).json()) as { id: string })
        const tags = (await (await req.get('/api/v1/tags')).json()) as { id: string; name: string }[] | null
        const ids: string[] = []
        for (let i = 0; i < 40; i++) {
            const name = `vocab-${String(i).padStart(2, '0')}`
            const found = tags?.find((t) => t.name === name)
            ids.push(
                found?.id ??
                    ((await (await req.post('/api/v1/tags', { data: { name, color: '#8899aa' } })).json()) as { id: string }).id,
            )
        }
        const moments = (await (await req.get('/api/v1/moments')).json()) as { id: string; title: string }[] | null
        let m = moments?.find((x) => x.title === 'A crowded column')
        if (!m) {
            m = (await (
                await req.post('/api/v1/moments', {
                    data: {
                        archive_id: archive.id,
                        title: 'A crowded column',
                        content: Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long body`).join('\n'),
                        tag_ids: ids.slice(0, 4),
                    },
                })
            ).json()) as { id: string }
        }

        await page.goto('/')
        const card = page.locator(`[data-moment-id="${m.id}"]`).first()
        await card.hover()
        await card.locator('i.fa-pencil').click()
        const modal = page.locator('.fixed').filter({ hasText: 'Edit Moment' }).first()
        await expect(modal.getByRole('heading', { name: 'Edit Moment' })).toBeVisible()

        // Focusing the tag input is what puts the suggestion list in the column.
        const tagInput = modal.getByPlaceholder('Add tags', { exact: false })
        await tagInput.click()
        await expect(modal.getByTestId('tag-suggestions')).toBeVisible()

        const area = modal.getByPlaceholder('Write your thoughts', { exact: false })
        // Inside the box that draws its border, to the pixel.
        const spill = await area.evaluate((el) => el.getBoundingClientRect().bottom - el.parentElement!.getBoundingClientRect().bottom)
        expect(spill).toBeLessThanOrEqual(1)

        // And clear of what sits under it.
        const areaBox = (await area.boundingBox())!
        expect(areaBox.y + areaBox.height).toBeLessThanOrEqual((await tagInput.boundingBox())!.y + 1)
        expect(areaBox.y + areaBox.height).toBeLessThanOrEqual((await modal.getByTestId('selected-tags').boundingBox())!.y + 1)
    })
})

test.describe('composer height, mobile', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('the modal writing area stays inside a phone window', async ({ page }) => {
        await signIn(page)
        await page.goto('/')

        await page.getByRole('button', { name: 'New Moment' }).first().click()
        await expect(body(page)).toBeVisible()
        await body(page).fill(LINES)

        // No inline card at this width, so the only writing area is the modal's.
        const box = (await body(page).boundingBox())!
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.y + box.height).toBeLessThanOrEqual(844)
        expect(box.height).toBeGreaterThan(120)
    })
})

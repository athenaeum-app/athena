import { test, expect, type Page, type Locator } from '@playwright/test'

// An upload only exists in the body as placeholder text until the request
// resolves. Posting before that saved the placeholder as the content and lost
// the attachment, and the upload landing afterwards rewrote a buffer submit had
// already cleared, leaving the asset on the server with nothing pointing at it.
//
// Both tests hold the upload open with a route handler rather than racing a
// real one, since the whole bug lives in the window while it is in flight.

async function signIn(page: Page): Promise<void> {
    const setup = (await (await page.request.get('/api/v1/setup')).json()) as { needs_setup: boolean }
    const [path, data] = setup.needs_setup
        ? ['/api/v1/auth/register', { username: 'owner', password: 'password123', invite_id: '', stay_logged_in: true }]
        : ['/api/v1/auth/login', { username: 'owner', password: 'password123', stay_logged_in: true }]
    const res = await page.request.post(path, { data })
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`)
}

// The inline composer posts into whichever archive sorts first, so this only
// has to guarantee the library is not empty.
async function ensureArchive(page: Page): Promise<void> {
    const archives = (await (await page.request.get('/api/v1/archives')).json()) as { name: string }[]
    if (archives?.length) return
    const res = await page.request.post('/api/v1/archives', { data: { name: 'Uploads' } })
    if (!res.ok()) throw new Error(`could not create an archive: ${res.status()}`)
}

// Resolves the returned release() to let the upload complete.
async function holdUploads(page: Page): Promise<() => void> {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    await page.route('**/api/v1/assets', async (route) => {
        if (route.request().method() !== 'POST') return route.continue()
        await held
        await route.continue()
    })
    return release
}

const body = (page: Page) => page.getByPlaceholder(/Write your thoughts/)
const postButton = (page: Page) => page.getByRole('button', { name: 'Post', exact: true })

// Each chrome renders its own hidden file input, so the chat cases scope this
// to the panel rather than taking the first one on the page.
const attachTo = (input: Locator, name: string) =>
    input.setInputFiles({
        name,
        mimeType: 'image/png',
        buffer: Buffer.from('not a real png, and never decoded'),
    })
const attach = (page: Page, name: string) => attachTo(page.locator('input[type=file]').first(), name)

test.describe('submitting while an upload is in flight', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('post is inert until the attachment lands, then saves the file not the placeholder', async ({ page }) => {
        await signIn(page)
        await ensureArchive(page)
        const release = await holdUploads(page)
        await page.goto('/')

        await body(page).fill('before the picture')
        await attach(page, 'shot.png')

        // Mid-flight: the placeholder is the only thing in the body standing in
        // for the file, and the button that would save it is refused.
        await expect(body(page)).toHaveValue(/\[Attaching shot\.png #\d+\.\.\.\]/)
        await expect(postButton(page)).toBeDisabled()

        release()

        // Landed: the placeholder has become a real reference.
        await expect(postButton(page)).toBeEnabled()
        await expect(body(page)).toHaveValue(/!\[shot\.png\]\(\/api\/v1\/assets\/[^)]+\)/)
        await expect(body(page)).not.toHaveValue(/Attaching/)

        await postButton(page).click()

        const card = page.getByTestId('moment-card').filter({ hasText: 'before the picture' }).first()
        await expect(card).toBeVisible()
        await expect(card).not.toContainText('Attaching')
        await expect(card.locator('img')).toHaveAttribute('src', /\/api\/v1\/assets\//)
    })

    // A pasted screenshot is almost always called image.png, so two in a row is
    // the ordinary case rather than a contrived one. Identical placeholder text
    // meant the first upload to finish claimed the first match, which is not
    // necessarily its own.
    test('two uploads of the same filename get their own placeholders', async ({ page }) => {
        await signIn(page)
        await ensureArchive(page)
        const release = await holdUploads(page)
        await page.goto('/')

        await attach(page, 'image.png')
        await expect(body(page)).toHaveValue(/\[Attaching image\.png #1\.\.\.\]/)
        await attach(page, 'image.png')
        await expect(body(page)).toHaveValue(/\[Attaching image\.png #2\.\.\.\]/)

        await expect(postButton(page)).toBeDisabled()
        release()

        // Two distinct references, so neither upload overwrote the other's slot.
        await expect(postButton(page)).toBeEnabled()
        await expect(body(page)).not.toHaveValue(/Attaching/)
        const value = (await body(page).inputValue()).match(/!\[image\.png\]\(\/api\/v1\/assets\/([^)]+)\)/g) ?? []
        expect(value).toHaveLength(2)
        expect(new Set(value).size).toBe(2)
    })
})

// The other affected surface and the other layout. Chat is its own chrome with
// its own Send button, and below the desktop breakpoint that button is the only
// way to send at all: Enter is a newline there, so a disabled button is the
// whole guard rather than a second line of it.
test.describe('sending a chat message while an upload is in flight', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('send is inert until the attachment lands', async ({ page }) => {
        await signIn(page)
        const release = await holdUploads(page)
        await page.goto('/')
        await page.getByRole('button', { name: 'Chat' }).first().click()

        const panel = page.getByTestId('chat-panel')
        const draft = panel.locator('textarea').first()
        const send = panel.getByRole('button', { name: 'Send', exact: true })
        await expect(draft).toBeVisible()

        await attachTo(panel.locator('input[type=file]').first(), 'note.png')

        await expect(draft).toHaveValue(/\[Attaching note\.png #\d+\.\.\.\]/)
        await expect(send).toBeDisabled()

        release()

        await expect(send).toBeEnabled()
        await expect(draft).toHaveValue(/!\[note\.png\]\(\/api\/v1\/assets\/[^)]+\)/)
        await expect(draft).not.toHaveValue(/Attaching/)
    })
})

import { test, expect, type Page } from '@playwright/test'

// The Documents tab (ADR-0020): a project owns durable reference content in an
// unbounded folder tree of its own. The whole round trip is here because every
// step of it is a different mechanism: creation is a POST that lands in the
// project payload, the body runs the shared moment pipeline behind a debounced
// PATCH, and deleting a folder is a recursive hard delete whose response is the
// undo entry.
//
// Both viewports, because the grid, the breadcrumb and the outline all change
// shape at 390px: the outline is a rail on the desktop and a drop-down panel on
// the phone.

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

async function seedProject(page: Page, title: string): Promise<string> {
    const project = await post<{ id: string }>(page, '/api/v1/projects', { title })
    return project.id
}

async function openDocuments(page: Page, project: string, mobile: boolean): Promise<void> {
    await page.goto('/')
    if (mobile) await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('button', { name: 'Projects' }).click()
    await expect(page.getByTestId('projects-panel')).toBeVisible()
    // The portfolio opens on the Overview; the covers are the Catalog.
    await page.getByTitle('Catalog view').click()
    await page.getByText(project).first().click()
    await page.getByTitle('Documents view').click()
    await expect(page.getByTestId('documents-tab')).toBeVisible()
}

for (const shell of [
    { name: 'desktop', viewport: { width: 1440, height: 900 }, hasTouch: false, mobile: false },
    { name: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true, mobile: true },
] as const) {
    test.describe(`the documents tab (${shell.name})`, () => {
        test.use({ viewport: shell.viewport, hasTouch: shell.hasTouch })

        test('folder, document, edit, delete and undo', async ({ page }) => {
            await signIn(page)
            const project = `Documents ${shell.name}`
            await seedProject(page, project)
            await openDocuments(page, project, shell.mobile)

            // The tab opens empty at the root, offering both ghost tiles.
            await expect(page.getByTestId('documents-breadcrumb')).toContainText('Documents')
            await expect(page.getByTestId('new-document')).toBeVisible()
            await expect(page.getByTestId('new-folder')).toBeVisible()

            // A fourth tab is wider than the phone shell, so the row scrolls
            // rather than stranding the last tab behind the panel edge.
            const graveyard = page.getByTitle('Graveyard view')
            await graveyard.scrollIntoViewIfNeeded()
            await graveyard.click()
            await expect(page.getByRole('heading', { name: 'Graveyard' })).toBeVisible()
            await page.getByTitle('Documents view').click()

            // A new folder lands in the grid with its name already selected,
            // since "New folder" is never what it is called.
            await page.getByTestId('new-folder').click()
            const folder = page.getByTestId('folder-tile')
            await expect(folder).toHaveCount(1)
            await folder.getByRole('textbox').fill('Research')
            await folder.getByRole('textbox').press('Enter')
            await expect(folder).toContainText('Research')
            await expect(folder).toContainText('0 folders')

            // Opening it walks the breadcrumb one level down.
            await folder.click()
            await expect(page.getByTestId('documents-breadcrumb')).toContainText('Documents')
            await expect(page.getByTestId('documents-breadcrumb').getByRole('button', { name: 'Research' })).toBeVisible()

            // A new document opens straight into its view, ready to be titled.
            await page.getByTestId('new-document').click()
            await expect(page.getByTestId('document-view')).toBeVisible()
            const title = page.getByTitle('Rename document')
            await title.fill('Storage decision')
            await title.press('Enter')

            // The body is written through the shared editor and read back
            // through the shared renderer.
            // A new document is a draft, and a draft is written by clicking
            // it. Escape puts it back, which is the whole of the old Edit and
            // Done pair.
            const view = page.getByTestId('document-view')
            await expect(view.getByRole('button', { name: 'Edit' })).toHaveCount(0)
            await view.getByTestId('document-body').click()
            const editor = page.getByPlaceholder('The document.', { exact: false })
            await editor.fill('# Why SQLite\n\nIt ships inside the binary.')
            await page.keyboard.press('Escape')
            await expect(editor).toHaveCount(0)
            await expect(page.getByRole('heading', { name: 'Why SQLite' })).toBeVisible()

            // The document tools: a heading in the outline, and a size in the
            // footer. The outline is a rail on the desktop and behind the toc
            // button on the phone.
            if (shell.mobile) {
                await expect(page.getByTestId('document-outline')).toBeHidden()
                await page.getByTitle('Outline').click()
            }
            const outline = page.getByTestId('document-outline').first()
            await expect(outline).toBeVisible()
            await expect(outline).toContainText('Why SQLite')
            await expect(page.getByTestId('document-word-count')).toHaveText('7 words')

            // Back out to the root, where the folder now reports what is
            // inside it.
            await page.getByTitle('Back to the folder').click()
            await expect(page.getByTestId('document-tile')).toContainText('Storage decision')
            await page.getByTestId('documents-breadcrumb').getByRole('button', { name: 'Documents' }).click()
            await expect(folder).toContainText('1 document')

            // Deleting a folder takes everything under it, so the confirm says
            // how much before it happens.
            await folder.hover()
            await page.getByTitle('Delete folder and everything in it').click()
            await expect(page.getByText('Delete folder and 1 item inside?')).toBeVisible()
            await page.getByRole('button', { name: 'Delete', exact: true }).click()
            await expect(folder).toHaveCount(0)

            // Undo puts the whole subtree back under its own ids, so the
            // document inside is still there and still says what it said.
            await page.getByRole('button', { name: 'Undo' }).click()
            await expect(folder).toHaveCount(1)
            await folder.click()
            await expect(page.getByTestId('document-tile')).toContainText('Storage decision')
            await page.getByTestId('document-tile').click()
            await expect(page.getByRole('heading', { name: 'Why SQLite' })).toBeVisible()
        })

        // Status and comments are the two things a reference document has that
        // a card does not: a state that freezes it, and remarks hung off the
        // blocks of its body. Both change shape at 390px, where the comments
        // move from a rail into a sheet behind the header button.
        test('status locks the text, and comments anchor to a block', async ({ page }) => {
            await signIn(page)
            const project = `Reviewed ${shell.name}`
            const projectId = await seedProject(page, project)
            await post(page, `/api/v1/projects/${projectId}/documents`, {
                kind: 'document',
                title: 'The storage call',
                body: '# Why SQLite\n\nIt ships inside the binary.\n\nOne file, one backup.',
            })
            await openDocuments(page, project, shell.mobile)

            const tile = page.getByTestId('document-tile')
            await expect(tile).toContainText('The storage call')
            // Draft carries no badge: every document starts there.
            await expect(tile.getByTestId('document-status-badge')).toHaveCount(0)
            await tile.click()
            const view = page.getByTestId('document-view')
            await expect(view).toBeVisible()

            // A comment hangs off one block. The affordance sits in the margin
            // beside it and the thread lands in the panel.
            const secondBlock = page.getByTestId('add-comment').nth(1)
            await secondBlock.click({ force: true })
            const comments = shell.mobile ? page.getByTestId('document-comments-sheet') : page.getByTestId('document-comments-rail')
            await expect(comments).toBeVisible()
            await expect(comments.getByTestId('comment-draft')).toContainText('It ships inside the binary.')
            await comments.getByPlaceholder('What about this block?').fill('Does this hold with two writers?')
            await comments.getByRole('button', { name: 'Comment', exact: true }).click()
            const thread = comments.getByTestId('comment-thread')
            await expect(thread).toContainText('Does this hold with two writers?')
            // And a marker appears in the margin against that block.
            await expect(page.getByTestId('comment-marker')).toHaveCount(1)

            // Resolved threads fold away behind a count, and come back.
            await thread.getByRole('button', { name: 'Resolve' }).click()
            await expect(thread).toHaveCount(0)
            await expect(comments.getByTestId('resolved-threads')).toContainText('1 resolved')
            await comments.getByTestId('resolved-threads').click()
            await expect(comments.getByTestId('comment-thread')).toContainText('Does this hold with two writers?')
            await comments.getByRole('button', { name: 'Reopen' }).click()

            // Editing the block out orphans the comment rather than sliding it
            // onto whatever now sits at that index.
            await view.getByTestId('document-body').click()
            const editor = page.getByPlaceholder('The document.', { exact: false })
            await editor.fill('# Why SQLite\n\nPostgres would want a second process to babysit.\n\nOne file, one backup.')
            await page.keyboard.press('Escape')
            await expect(comments.getByTestId('comment-orphaned')).toBeVisible()

            // Final settles it: the same click that opened the editor a moment
            // ago now does nothing at all.
            await view.getByTestId('document-status').getByRole('button', { name: 'Final' }).click()
            await view.getByTestId('document-body').click()
            await expect(editor).toHaveCount(0)

            // Locking freezes the text: no editor, a read-only title, and a
            // banner saying how to get out of it.
            await view.getByTestId('document-status').getByRole('button', { name: 'Locked' }).click()
            await expect(page.getByTestId('document-locked')).toBeVisible()
            await expect(page.getByTitle('Rename document')).toHaveCount(0)
            await view.getByTestId('document-body').click()
            await expect(editor).toHaveCount(0)

            // A version restore rewrites the title and body, so it is off too,
            // and says why.
            await page.getByTitle('Versions').click()
            await expect(page.getByTestId('versions-locked')).toBeVisible()
            await expect(page.getByTestId('document-versions')).toContainText('Restoring is off while the document is locked')
            await page.getByTestId('document-versions').getByTitle('Close').click()

            // Unlocking is its own act: the status control, not a hidden step
            // inside an edit.
            await view.getByTestId('document-status').getByRole('button', { name: 'Final' }).click()
            await expect(page.getByTestId('document-locked')).toHaveCount(0)
            // And Draft is the only thing that opens the text again.
            await view.getByTestId('document-status').getByRole('button', { name: 'Draft' }).click()
            await view.getByTestId('document-body').click()
            await expect(editor).toBeVisible()
            await page.keyboard.press('Escape')
            await view.getByTestId('document-status').getByRole('button', { name: 'Final' }).click()

            // Final is worth spotting from the grid, so it badges the tile, and
            // the open thread badges it too.
            await page.getByTitle('Back to the folder').click()
            await expect(tile.getByTestId('document-status-badge')).toContainText('Final')
            await expect(tile.getByTestId('document-tile-comments')).toContainText('1')
        })

        // The plain path is one tap; a template is one more, and lays out a
        // body rather than a kind of document.
        test('a new document can start from a template', async ({ page }) => {
            await signIn(page)
            const project = `Templates ${shell.name}`
            await seedProject(page, project)
            await openDocuments(page, project, shell.mobile)

            await page.getByTestId('new-document-template').click()
            await expect(page.getByTestId('document-templates')).toBeVisible()
            await page.getByRole('button', { name: 'Decision record' }).click()

            await expect(page.getByTestId('document-view')).toBeVisible()
            await expect(page.getByRole('heading', { name: 'Context' })).toBeVisible()
            await expect(page.getByRole('heading', { name: 'Decision', exact: true })).toBeVisible()
            await expect(page.getByRole('heading', { name: 'Consequences' })).toBeVisible()
        })

        // The outline used to call scrollIntoView, which scrolls every
        // scrollable ancestor rather than one box. The panel root is
        // overflow-hidden, which script can scroll and the reader cannot
        // scroll back, so the whole module slid up under its own clipped edge.
        test('the outline scrolls the document and not the panel', async ({ page }) => {
            await signIn(page)
            const project = `Outline ${shell.name}`
            const projectId = await seedProject(page, project)
            const filler = Array.from(
                { length: 12 },
                (_, i) => `Paragraph ${i + 1} of the section, long enough to push the next heading past the fold.`,
            )
            await post(page, `/api/v1/projects/${projectId}/documents`, {
                kind: 'document',
                title: 'The long one',
                body: ['# Beginning', ...filler, '# Middle', ...filler, '# End', ...filler].join('\n\n'),
            })
            await openDocuments(page, project, shell.mobile)
            await page.getByTestId('document-tile').click()
            await expect(page.getByTestId('document-view')).toBeVisible()

            const scrollTops = () =>
                page.evaluate(() => ({
                    panel: (document.querySelector('[data-testid="projects-panel"]') as HTMLElement).scrollTop,
                    body: (document.querySelector('[data-testid="document-body"]') as HTMLElement).scrollTop,
                }))
            expect(await scrollTops()).toEqual({ panel: 0, body: 0 })

            if (shell.mobile) await page.getByTitle('Outline').click()
            await page.getByTestId('document-outline').first().getByRole('button', { name: 'End' }).click()
            // The smooth scroll has to land before either number is worth
            // reading.
            await expect.poll(async () => (await scrollTops()).body).toBeGreaterThan(0)
            expect((await scrollTops()).panel).toBe(0)
            await expect(page.getByRole('heading', { name: 'End' })).toBeInViewport()
        })
    })
}

// A document is the fifth embed kind (ADR-0019) and the only one with no
// endpoint of its own, so opening one from a moment has to find the owning
// project, open its Hub, land on the Documents tab and open the document. Every
// one of those is a separate hop, which is why the whole path is driven here.
test.describe('a document embedded in a moment', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('opens the document in its project hub', async ({ page }) => {
        await signIn(page)
        const projectId = await seedProject(page, 'Embedded Documents')
        const doc = await post<{ id: string }>(page, `/api/v1/projects/${projectId}/documents`, {
            kind: 'document',
            title: 'The storage call',
            body: '# Why SQLite\n\nOne binary, one file.',
        })
        const archive = await post<{ id: string }>(page, '/api/v1/archives', { name: 'Decisions' })
        await post(page, '/api/v1/moments', {
            archive_id: archive.id,
            title: 'Wrote it up',
            content: `The reasoning is in ::doc:${doc.id}::`,
            tag_ids: [],
        })

        await page.goto('/')
        const card = page.getByText('The storage call').first()
        await expect(card).toBeVisible()
        await expect(page.getByText('One binary, one file.')).toBeVisible()
        await card.click()

        await expect(page.getByTestId('projects-panel')).toBeVisible()
        await expect(page.getByTestId('document-view')).toBeVisible()
        await expect(page.getByRole('heading', { name: 'Why SQLite' })).toBeVisible()
    })
})

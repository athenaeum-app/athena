import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@solidjs/testing-library'
import userEvent from '@testing-library/user-event'
import { MomentBody, clearProjectDocumentCache } from './MomentBody'
import { api } from '../api'

// A ::doc:id:: embed is the one kind with no endpoint of its own: the document
// arrives inside its project's payload (ADR-0020), so the card has to find its
// owner before it can draw anything, and it has to hand that owner back when it
// is clicked because a document is only reachable through its project's Hub.

vi.mock('../api', () => ({
    api: {
        listProjects: vi.fn(),
        getMoment: vi.fn(),
        getTodoList: vi.fn(),
        getCanvas: vi.fn(),
        getProject: vi.fn(),
    },
}))

const project = (documents: unknown[]) => ({
    id: 'p1',
    title: 'Athena',
    overview: '',
    accent: '#67b8c7',
    icon: 'space_dashboard',
    position: 0,
    archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    milestones: [],
    cards: [],
    documents,
})

const doc = (id: string, title: string, body: string, kind = 'document') => ({
    id,
    project_id: 'p1',
    kind,
    title,
    body,
    status: 'draft',
    position: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
})

describe('DocEmbed', () => {
    beforeEach(() => {
        clearProjectDocumentCache()
        vi.mocked(api.listProjects).mockReset()
    })

    it('draws the document title, an excerpt and the project it lives in', async () => {
        vi.mocked(api.listProjects).mockResolvedValue([
            project([doc('aaaaaa01', 'Storage decision', 'We chose **SQLite** because it ships in the binary.')]),
        ] as never)

        render(() => <MomentBody content="::doc:aaaaaa01::" />)

        expect(await screen.findByText('Storage decision')).toBeInTheDocument()
        expect(screen.getByText(/We chose SQLite because it ships in the binary\./)).toBeInTheDocument()
        expect(screen.getByText('in Athena')).toBeInTheDocument()
    })

    it('hands the owning project back with the document id when it is opened', async () => {
        vi.mocked(api.listProjects).mockResolvedValue([project([doc('aaaaaa01', 'Storage decision', 'body')])] as never)
        const onOpenDoc = vi.fn()

        render(() => <MomentBody content="::doc:aaaaaa01::" onOpenDoc={onOpenDoc} />)

        await userEvent.click(await screen.findByRole('button'))
        expect(onOpenDoc).toHaveBeenCalledWith('aaaaaa01', 'p1')
    })

    it('shows the unavailable chip for a document no visible project holds', async () => {
        vi.mocked(api.listProjects).mockResolvedValue([project([doc('aaaaaa01', 'Storage decision', 'body')])] as never)

        render(() => <MomentBody content="::doc:cccccc03::" />)

        expect(await screen.findByText('Document unavailable')).toBeInTheDocument()
    })

    // Folders are containers, not content: the picker never offers one, and a
    // token naming one must not draw an empty card as though it were readable.
    it('treats a folder id as unavailable', async () => {
        vi.mocked(api.listProjects).mockResolvedValue([project([doc('ffffff01', 'Research', '', 'folder')])] as never)

        render(() => <MomentBody content="::doc:ffffff01::" />)

        expect(await screen.findByText('Document unavailable')).toBeInTheDocument()
    })

    it('resolves every document embed on a page from one request', async () => {
        vi.mocked(api.listProjects).mockResolvedValue([
            project([doc('aaaaaa01', 'First decision', 'one'), doc('bbbbbb02', 'Second decision', 'two')]),
        ] as never)

        render(() => <MomentBody content={'::doc:aaaaaa01::\n\n::doc:bbbbbb02::'} />)

        expect(await screen.findByText('First decision')).toBeInTheDocument()
        expect(await screen.findByText('Second decision')).toBeInTheDocument()
        await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(1))
    })
})

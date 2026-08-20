import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@solidjs/testing-library'
import { Editor } from './Editor'
import { clearEmbedCache } from '../embedSearch'
import { api } from '../api'
import type { Archive } from '../api'

vi.mock('../api', () => ({
    api: {
        listMoments: vi.fn(),
        listTodos: vi.fn(),
        listCanvases: vi.fn(),
        listProjects: vi.fn(),
        uploadAsset: vi.fn(),
    },
}))

// jsdom ships no matchMedia, and the composer asks for the viewport.
window.matchMedia = ((q: string) => ({
    matches: true,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
})) as unknown as typeof window.matchMedia

const archives: Archive[] = [{ id: 'a1', name: 'Journal' } as Archive]

function composer(momentIndex: { id: string; title: string }[] = []) {
    const { container } = render(() => (
        <Editor
            chrome="inline"
            archives={archives}
            tags={[]}
            momentIndex={momentIndex}
            onSubmit={async () => {}}
        />
    ))
    return container.querySelector('textarea') as HTMLTextAreaElement
}

// Typing, as far as the composer is concerned: the value plus where the caret
// ended up, which is what both triggers read.
function type(textarea: HTMLTextAreaElement, text: string) {
    textarea.value = text
    textarea.selectionStart = text.length
    textarea.selectionEnd = text.length
    fireEvent.input(textarea)
}

describe('the `[[` embed picker', () => {
    beforeEach(() => {
        cleanup()
        localStorage.clear()
        clearEmbedCache()
        vi.mocked(api.listMoments).mockReset().mockResolvedValue([
            { id: 'm1', title: 'Grocery list', content: 'milk' },
        ] as never)
        vi.mocked(api.listTodos).mockReset().mockResolvedValue([
            { id: 't1', title: 'Groceries', items: [] },
        ] as never)
        vi.mocked(api.listCanvases).mockReset().mockResolvedValue([
            { id: 'c1', title: 'Grocery plan' },
        ] as never)
        vi.mocked(api.listProjects).mockReset().mockResolvedValue([] as never)
    })

    it('searches every kind at once and badges the results', async () => {
        const textarea = composer()
        type(textarea, 'see [[groc')

        const menu = await screen.findByTestId('embed-menu')
        await waitFor(() => expect(menu.textContent).toContain('Grocery list'))
        // One heading per kind that matched, and none for the kind that did not.
        expect(menu.textContent).toContain('Moment')
        expect(menu.textContent).toContain('To-do list')
        expect(menu.textContent).toContain('Canvas')
        expect(menu.textContent).not.toContain('Project')
    })

    it('inserts a moment as [[id]], replacing the query text', async () => {
        const textarea = composer()
        type(textarea, 'see [[groc')
        await screen.findByText('Grocery list')

        fireEvent.click(screen.getByText('Grocery list'))
        expect(textarea.value).toBe('see [[m1]]')
    })

    it('inserts every other kind as ::kind:id::', async () => {
        const textarea = composer()
        type(textarea, '[[groc')
        await screen.findByText('Groceries')

        fireEvent.click(screen.getByText('Groceries'))
        expect(textarea.value).toBe('::todo:t1::')
    })

    it('narrows to one kind on a `kind:` prefix', async () => {
        const textarea = composer()
        type(textarea, '[[todo:groc')

        const menu = await screen.findByTestId('embed-menu')
        await waitFor(() => expect(menu.textContent).toContain('Groceries'))
        expect(menu.textContent).not.toContain('Grocery list')
        expect(api.listMoments).not.toHaveBeenCalled()
    })

    it('still walks the list with the arrow keys and picks with Enter', async () => {
        const textarea = composer()
        type(textarea, '[[groc')
        await screen.findByText('Groceries')

        // Down from the first moment hit into the to-do group.
        fireEvent.keyDown(textarea, { key: 'ArrowDown' })
        fireEvent.keyDown(textarea, { key: 'Enter' })
        expect(textarea.value).toBe('::todo:t1::')
    })

    it('closes on Escape and leaves the typed text alone', async () => {
        const textarea = composer()
        type(textarea, '[[groc')
        await screen.findByTestId('embed-menu')

        fireEvent.keyDown(textarea, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByTestId('embed-menu')).toBeNull())
        expect(textarea.value).toBe('[[groc')
    })

    it('answers from the moments already on screen before the server replies', async () => {
        vi.mocked(api.listMoments).mockReturnValue(new Promise(() => {}) as never)
        const textarea = composer([{ id: 'local', title: 'Grocery draft' }])
        type(textarea, '[[groc')

        // No await on the network: this is what the host already had.
        expect(screen.getByTestId('embed-menu').textContent).toContain('Grocery draft')
    })

    it('opens without a moment index, because the search is the server', async () => {
        const textarea = composer()
        type(textarea, '[[groc')
        const menu = await screen.findByTestId('embed-menu')
        await waitFor(() => expect(menu.textContent).toContain('Grocery list'))
    })
})

describe('the slash menu', () => {
    beforeEach(() => {
        cleanup()
        localStorage.clear()
        clearEmbedCache()
        vi.mocked(api.listCanvases).mockReset().mockResolvedValue([{ id: 'c1', title: 'Plan' }] as never)
        vi.mocked(api.listMoments).mockReset().mockResolvedValue([] as never)
        vi.mocked(api.listTodos).mockReset().mockResolvedValue([] as never)
        vi.mocked(api.listProjects).mockReset().mockResolvedValue([] as never)
    })

    it('still opens its dialog and inserts that kind token', async () => {
        const textarea = composer()
        type(textarea, '/canvas')
        fireEvent.keyDown(textarea, { key: 'Enter' })

        const list = await screen.findByTestId('embed-picker-list')
        await waitFor(() => expect(list.textContent).toContain('Plan'))
        fireEvent.click(screen.getByText('Plan'))
        expect(textarea.value).toBe('::canvas:c1::')
    })
})

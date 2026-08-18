import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { render, screen, cleanup, fireEvent } from '@solidjs/testing-library'
import { Editor } from './Editor'
import type { Archive } from '../api'

// A refetch parses fresh objects, so identity changes even when nothing else
// does. Built per call for the tests that turn on exactly that.
const makeArchives = (): Archive[] => [
    { id: 'a1', name: 'Journal' } as Archive,
    { id: 'a2', name: 'Work' } as Archive,
]

const archives = makeArchives()

// jsdom ships no matchMedia, and the composer asks for the viewport.
window.matchMedia = ((q: string) => ({
    matches: true,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
})) as unknown as typeof window.matchMedia

function openComposer(defaultArchive: string | null = null) {
    const onSubmit = vi.fn(async (_t: string, _c: string, _tags: string[], _archive: string) => {})
    render(() => (
        <Editor
            chrome="modal"
            archives={archives}
            tags={[]}
            defaultArchive={defaultArchive}
            onSubmit={onSubmit}
        />
    ))
    return { select: screen.getByRole('combobox') as HTMLSelectElement, onSubmit }
}

describe('composer archive', () => {
    beforeEach(() => {
        localStorage.clear()
        cleanup()
    })

    it('still points at the chosen archive after a moment is posted', async () => {
        const first = openComposer()
        expect(first.select.value).toBe('a1')
        fireEvent.change(first.select, { target: { value: 'a2' } })

        fireEvent.click(screen.getByText('Save'))
        await vi.waitFor(() => expect(first.onSubmit).toHaveBeenCalled())
        expect(first.onSubmit.mock.calls[0][3]).toBe('a2')
        // Posting closes the composer; the next one is built from scratch.
        cleanup()

        expect(openComposer().select.value).toBe('a2')
    })

    it('keeps the choice while a different archive is being read', () => {
        fireEvent.change(openComposer().select, { target: { value: 'a2' } })
        cleanup()

        expect(openComposer('a1').select.value).toBe('a2')
    })

    it('follows the archive on screen until a choice is made', () => {
        expect(openComposer('a2').select.value).toBe('a2')
    })

    // Posting reloads the feed and refetches the archives, about half a second
    // later. Rebuilding the option list used to leave the select showing its
    // first entry, while the value it would have posted to stayed on the one
    // that had been picked.
    it('holds the picked archive when the archive list is refetched', () => {
        const [live, setLive] = createSignal(makeArchives())
        const onSubmit = vi.fn(async (_t: string, _c: string, _tags: string[], _archive: string) => {})
        render(() => (
            <Editor chrome="inline" archives={live()} tags={[]} defaultArchive="a1" onSubmit={onSubmit} />
        ))
        const select = () => screen.getByRole('combobox') as HTMLSelectElement
        fireEvent.change(select(), { target: { value: 'a2' } })

        setLive(makeArchives())

        expect(select().value).toBe('a2')
    })

    it('drops a choice whose archive is gone', () => {
        localStorage.setItem('athena-composer-archive', 'deleted')
        expect(openComposer().select.value).toBe('a1')
    })
})

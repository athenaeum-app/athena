import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@solidjs/testing-library'
import { Editor } from './Editor'
import type { Archive } from '../api'

const archives: Archive[] = [
    { id: 'a1', name: 'Journal' } as Archive,
    { id: 'a2', name: 'Work' } as Archive,
]

// jsdom ships no matchMedia, and the composer asks for the viewport.
window.matchMedia = ((q: string) => ({
    matches: true,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
})) as unknown as typeof window.matchMedia

function openComposer(defaultArchive: string | null = null) {
    render(() => (
        <Editor
            chrome="modal"
            archives={archives}
            tags={[]}
            defaultArchive={defaultArchive}
            onSubmit={async () => {}}
        />
    ))
    return screen.getByRole('combobox') as HTMLSelectElement
}

describe('composer archive', () => {
    beforeEach(() => {
        localStorage.clear()
        cleanup()
    })

    it('reopens on the archive that was chosen by hand', () => {
        const select = openComposer()
        expect(select.value).toBe('a1')
        fireEvent.change(select, { target: { value: 'a2' } })
        cleanup()

        expect(openComposer().value).toBe('a2')
    })

    it('leaves the choice behind when a different archive is on screen', () => {
        fireEvent.change(openComposer(), { target: { value: 'a2' } })
        cleanup()

        expect(openComposer('a1').value).toBe('a1')
    })

    it('drops a choice whose archive is gone', () => {
        localStorage.setItem(
            'athena-composer-archive',
            JSON.stringify({ archiveId: 'deleted', context: '' }),
        )
        expect(openComposer().value).toBe('a1')
    })
})

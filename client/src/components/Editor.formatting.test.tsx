import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@solidjs/testing-library'
import { Editor } from './Editor'

// The toolbar is one component behind every composer in the app, so what it
// writes is what every moment, card body and overview will hold.

window.matchMedia = ((q: string) => ({
    matches: true,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
})) as unknown as typeof window.matchMedia

function composer() {
    const onSubmit = vi.fn(async () => {})
    render(() => <Editor chrome="body" initialContent="pick me" onSubmit={onSubmit} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    textarea.setSelectionRange(0, 'pick me'.length)
    return textarea
}

describe('composer formatting toolbar', () => {
    beforeEach(() => {
        localStorage.clear()
        cleanup()
    })

    it('wraps the selection in the highlight markers', () => {
        const textarea = composer()
        fireEvent.click(screen.getByTitle('Highlight'))
        expect(textarea.value).toBe('==pick me==')
    })

    it('wraps the selection in the underline markers', () => {
        const textarea = composer()
        fireEvent.click(screen.getByTitle('Underline'))
        expect(textarea.value).toBe('++pick me++')
    })

    it('offers the six presets and wraps the selection in the chosen one', () => {
        const textarea = composer()
        fireEvent.click(screen.getByTitle('Text color'))
        expect(screen.getAllByLabelText(/^Color the selection /)).toHaveLength(6)

        fireEvent.click(screen.getByLabelText('Color the selection purple'))
        expect(textarea.value).toBe('[pick me]{color=purple}')
        // Picked, so the swatches are done.
        expect(screen.queryByLabelText('Color the selection purple')).toBeNull()
    })
})

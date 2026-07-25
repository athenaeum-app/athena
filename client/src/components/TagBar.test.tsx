import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library'
import userEvent from '@testing-library/user-event'
import { TagBar } from './TagBar'
import type { Tag } from '../api'

const tags: Tag[] = [
    { id: 't1', name: 'work', color: '#3b82f6', created_at: '', updated_at: '' },
    { id: 't2', name: 'idea', color: '#22c55e', created_at: '', updated_at: '' },
]

function setup(overrides: Partial<Parameters<typeof TagBar>[0]> = {}) {
    const onToggleTag = vi.fn()
    const onClear = vi.fn()
    const onCreateTag = vi.fn().mockResolvedValue(undefined)
    const onDeleteTag = vi.fn()
    const props = {
        tags,
        selectedTagIds: [] as string[],
        onToggleTag,
        onClear,
        onCreateTag,
        onDeleteTag,
        canManage: true,
        ...overrides,
    }
    render(() => <TagBar {...props} />)
    return { onToggleTag, onClear, onCreateTag, onDeleteTag }
}

describe('TagBar', () => {
    it('renders a button per tag', () => {
        setup()
        expect(screen.getByText('#work')).toBeInTheDocument()
        expect(screen.getByText('#idea')).toBeInTheDocument()
    })

    it('calls onToggleTag when a tag is clicked', async () => {
        const { onToggleTag } = setup()
        await userEvent.click(screen.getByText('#work'))
        expect(onToggleTag).toHaveBeenCalledWith('t1')
    })

    it('shows a Clear button only when tags are selected', () => {
        const { onClear } = setup({ selectedTagIds: ['t1'] })
        const clear = screen.getByText('Clear')
        fireEvent.click(clear)
        expect(onClear).toHaveBeenCalled()
    })

    it('hides Clear when nothing is selected', () => {
        setup({ selectedTagIds: [] })
        expect(screen.queryByText('Clear')).not.toBeInTheDocument()
    })

    it('validates that a new tag needs a name', async () => {
        const { onCreateTag } = setup()
        await userEvent.click(screen.getByText('New'))
        // Submit with an empty name.
        await userEvent.click(screen.getByText('Create'))
        expect(await screen.findByText('Name is required')).toBeInTheDocument()
        expect(onCreateTag).not.toHaveBeenCalled()
    })

    it('creates a tag with the entered name and selected color', async () => {
        const { onCreateTag } = setup()
        await userEvent.click(screen.getByText('New'))

        const input = screen.getByPlaceholderText('Tag name')
        await userEvent.type(input, '  urgent  ')
        await userEvent.click(screen.getByText('Create'))

        await waitFor(() =>
            // name is trimmed; color defaults to the first preset (#ef4444)
            expect(onCreateTag).toHaveBeenCalledWith('urgent', '#ef4444'),
        )
    })
})

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@solidjs/testing-library'
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
    const onDeleteTag = vi.fn()
    const props = {
        tags,
        selectedTagIds: [] as string[],
        onToggleTag,
        onClear,
        onDeleteTag,
        canManage: true,
        ...overrides,
    }
    render(() => <TagBar {...props} />)
    return { onToggleTag, onClear, onDeleteTag }
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

    // Tags are created in the moment composer, attached to the moment being
    // written, so the filter bar offers no way to make one. A tag created here
    // belonged to nothing, and once the bar started hiding tags with no moments
    // it vanished the instant it was created.
    it('offers no way to create a tag', () => {
        setup()
        expect(screen.queryByText('New')).not.toBeInTheDocument()
        expect(screen.queryByPlaceholderText('Tag name')).not.toBeInTheDocument()
    })

    // Filtering is AND, so a tag outside the facet set would empty the feed.
    it('keeps a selected tag visible even when it falls outside the facet set', () => {
        setup({ availableTagIds: new Set(['t1']), selectedTagIds: ['t2'] })
        expect(screen.getByText('#work')).toBeInTheDocument()
        expect(screen.getByText('#idea')).toBeInTheDocument()
    })

    it('hides an unavailable tag that is not selected', () => {
        setup({ availableTagIds: new Set(['t1']) })
        expect(screen.getByText('#work')).toBeInTheDocument()
        expect(screen.queryByText('#idea')).not.toBeInTheDocument()
    })

    // null means the facet response has not arrived; blanking the bar on every
    // cold load would be worse than briefly offering a dead end.
    it('shows every tag until the facet answer arrives', () => {
        setup({ availableTagIds: null })
        expect(screen.getByText('#work')).toBeInTheDocument()
        expect(screen.getByText('#idea')).toBeInTheDocument()
    })
})

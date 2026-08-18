import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@solidjs/testing-library'
import userEvent from '@testing-library/user-event'
import { Feed, EMPTY_FEED_FILTERS } from './Feed'
import { UIProvider } from '../ui'
import { setPref, resetPrefs } from '../prefs'
import type { Moment, Tag } from '../api'

const tags: Tag[] = [{ id: 't1', name: 'work', color: '#3b82f6', created_at: '', updated_at: '' }]

const moment: Moment = {
    id: 'm1',
    title: 'A moment',
    content: '',
    timestamp: '2026-01-01T00:00:00Z',
    tag_ids: ['t1'],
} as Moment

// jsdom ships no matchMedia, and Feed asks for the viewport on mount.
window.matchMedia = ((q: string) => ({
    matches: true,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
})) as unknown as typeof window.matchMedia

function setup(withHandler = true) {
    const onToggleTag = vi.fn()
    render(() => (
        <UIProvider>
            <Feed
                moments={[moment]}
                pinnedMoments={[]}
                tags={tags}
                archives={[]}
                selectedTagIds={[]}
                loading={false}
                loadingMore={false}
                hasMore={false}
                searchQuery=""
                filters={{ ...EMPTY_FEED_FILTERS }}
                onChangeFilters={() => {}}
                canPin={false}
                canEditMoment={() => false}
                canDeleteMoment={() => false}
                onSearch={() => {}}
                onCreateMoment={() => {}}
                onEditMoment={() => {}}
                onDeleteMoment={() => {}}
                onTogglePin={() => {}}
                onLoadMore={() => {}}
                onToggleTag={withHandler ? onToggleTag : undefined}
                canCreate={false}
                showComposer={false}
            />
        </UIProvider>
    ))
    return { onToggleTag }
}

describe('Feed tag chips', () => {
    beforeEach(() => resetPrefs())

    it('toggles the filter when a tag on a card is clicked', async () => {
        const { onToggleTag } = setup()
        await userEvent.click(screen.getByText('#work'))
        expect(onToggleTag).toHaveBeenCalledWith('t1')
    })

    it('is inert while the pref is off', async () => {
        const { onToggleTag } = setup()
        setPref('clickableMomentTags', false)
        await userEvent.click(screen.getByText('#work'))
        expect(onToggleTag).not.toHaveBeenCalled()
    })
})

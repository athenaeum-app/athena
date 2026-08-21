import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRoot, createSignal } from 'solid-js'
import {
    EMBED_KINDS,
    clearEmbedCache,
    createEmbedSearch,
    embedToken,
    groupEmbedCandidates,
    isEmbedKind,
    matchEmbedItems,
    parseEmbedTrigger,
    type EmbedCandidate,
    type EmbedKind,
} from './embedSearch'
import { api } from './api'

vi.mock('./api', () => ({
    api: {
        listMoments: vi.fn(),
        listTodos: vi.fn(),
        listCanvases: vi.fn(),
        listProjects: vi.fn(),
    },
}))

describe('parseEmbedTrigger', () => {
    it('opens on `[[` and takes everything after it as the query', () => {
        expect(parseEmbedTrigger('write [[groc')).toEqual({ kind: null, query: 'groc', start: 6 })
    })

    it('opens with an empty query the moment the brackets are typed', () => {
        expect(parseEmbedTrigger('[[')).toEqual({ kind: null, query: '', start: 0 })
    })

    it('stays shut without the trigger', () => {
        expect(parseEmbedTrigger('one [ two')).toBeNull()
        expect(parseEmbedTrigger('plain text')).toBeNull()
    })

    it('closes once the token is finished', () => {
        expect(parseEmbedTrigger('see [[abc]]')).toBeNull()
    })

    it('narrows to one kind on a kind prefix', () => {
        expect(parseEmbedTrigger('[[todo:groc')).toEqual({ kind: 'todo', query: 'groc', start: 0 })
        expect(parseEmbedTrigger('[[CANVAS: plan')).toEqual({ kind: 'canvas', query: 'plan', start: 0 })
        expect(parseEmbedTrigger('[[project:')).toEqual({ kind: 'project', query: '', start: 0 })
        expect(parseEmbedTrigger('[[doc:storage')).toEqual({ kind: 'doc', query: 'storage', start: 0 })
    })

    it('treats a colon that names no kind as part of the query', () => {
        expect(parseEmbedTrigger('[[note: buy milk')).toEqual({ kind: null, query: 'note: buy milk', start: 0 })
    })

    it('starts at the last `[[`, so the token replaces only the trigger', () => {
        const trigger = parseEmbedTrigger('a [[one]] b [[tw')
        expect(trigger?.start).toBe(12)
        expect(trigger?.query).toBe('tw')
    })
})

describe('embedToken', () => {
    it('writes a moment as a wiki-style token and everything else as ::kind:id::', () => {
        expect(embedToken('moment', 'm1')).toBe('[[m1]]')
        expect(embedToken('todo', 't1')).toBe('::todo:t1::')
        expect(embedToken('canvas', 'c1')).toBe('::canvas:c1::')
        expect(embedToken('project', 'p1')).toBe('::project:p1::')
        expect(embedToken('doc', 'd1')).toBe('::doc:d1::')
    })

    it('writes an agenda as its scope, which is the one token that names no entity', () => {
        expect(embedToken('agenda', 'all')).toBe('::agenda:all::')
        expect(embedToken('agenda', 'tasks')).toBe('::agenda:tasks::')
    })

    it('has a token for every registered kind', () => {
        for (const spec of EMBED_KINDS) {
            expect(embedToken(spec.kind, 'x')).toContain('x')
            expect(isEmbedKind(spec.kind)).toBe(true)
        }
    })
})

describe('matchEmbedItems', () => {
    const items = [
        { id: '1', title: 'Grocery list', sub: 'milk' },
        { id: '2', title: 'Weekly grocery run', sub: 'eggs' },
        { id: '3', title: 'Trip notes', sub: 'buy groceries in Tokyo' },
        { id: '4', title: 'Unrelated', sub: 'nothing' },
    ]

    it('puts a title that starts with the query first, then contains, then body', () => {
        expect(matchEmbedItems(items, 'groc').map((i) => i.id)).toEqual(['1', '2', '3'])
    })

    it('is case insensitive and honours the cap', () => {
        expect(matchEmbedItems(items, 'GROC', 2).map((i) => i.id)).toEqual(['1', '2'])
    })

    it('returns everything for an empty query', () => {
        expect(matchEmbedItems(items, '  ')).toHaveLength(4)
    })
})

describe('groupEmbedCandidates', () => {
    it('groups by kind in registry order and drops empty kinds', () => {
        const candidates: EmbedCandidate[] = [
            { kind: 'project', id: 'p1', title: 'Ship it' },
            { kind: 'moment', id: 'm1', title: 'Monday' },
            { kind: 'moment', id: 'm2', title: 'Tuesday' },
        ]
        const groups = groupEmbedCandidates(candidates)
        expect(groups.map((g) => g.kind)).toEqual(['moment', 'project'])
        expect(groups[0].items.map((i) => i.id)).toEqual(['m1', 'm2'])
        expect(groups[0].label).toBe('Moment')
    })
})

// --- the search primitive ---------------------------------------------------

const moment = (id: string, title: string) => ({ id, title, content: '' })

function runSearch(request: () => { kind: EmbedKind | null; query: string } | null) {
    return createRoot((dispose) => {
        const search = createEmbedSearch({
            request,
            fallbackMoments: () => [
                { id: 'local-1', title: 'Grocery draft' },
                { id: 'local-2', title: 'Unrelated' },
            ],
            debounceMs: 0,
        })
        return { search, dispose }
    })
}

describe('createEmbedSearch', () => {
    beforeEach(() => {
        clearEmbedCache()
        vi.mocked(api.listMoments).mockReset()
        vi.mocked(api.listTodos).mockReset().mockResolvedValue([])
        vi.mocked(api.listCanvases).mockReset().mockResolvedValue([])
        vi.mocked(api.listProjects).mockReset().mockResolvedValue([])
    })

    it('answers from the in-memory moments while the server search is in flight', () => {
        vi.mocked(api.listMoments).mockReturnValue(new Promise(() => {}) as never)
        const { search, dispose } = runSearch(() => ({ kind: null, query: 'groc' }))
        expect(search.results().map((r) => r.id)).toEqual(['local-1'])
        expect(search.loading()).toBe(true)
        dispose()
    })

    it('replaces them with the server hits once they land', async () => {
        vi.mocked(api.listMoments).mockResolvedValue([moment('server-1', 'Grocery list')] as never)
        const { search, dispose } = runSearch(() => ({ kind: null, query: 'groc' }))
        await vi.waitFor(() => expect(search.loading()).toBe(false))
        expect(search.results().filter((r) => r.kind === 'moment').map((r) => r.id)).toEqual(['server-1'])
        expect(api.listMoments).toHaveBeenCalledWith({ q: 'groc', limit: 20 })
        dispose()
    })

    it('falls back to the in-memory moments when the search fails', async () => {
        vi.mocked(api.listMoments).mockRejectedValue(new Error('offline'))
        const { search, dispose } = runSearch(() => ({ kind: null, query: 'groc' }))
        await vi.waitFor(() => expect(search.loading()).toBe(false))
        expect(search.results().map((r) => r.id)).toEqual(['local-1'])
        dispose()
    })

    it('searches every kind when no prefix narrows it', async () => {
        vi.mocked(api.listMoments).mockResolvedValue([moment('m1', 'Grocery list')] as never)
        vi.mocked(api.listTodos).mockResolvedValue([{ id: 't1', title: 'Groceries', items: [] }] as never)
        const { search, dispose } = runSearch(() => ({ kind: null, query: 'groc' }))
        await vi.waitFor(() => expect(search.results()).toHaveLength(2))
        expect(search.groups().map((g) => g.kind)).toEqual(['moment', 'todo'])
        dispose()
    })

    it('asks only the named kind when a prefix narrows it', async () => {
        vi.mocked(api.listTodos).mockResolvedValue([{ id: 't1', title: 'Groceries', items: [] }] as never)
        const { search, dispose } = runSearch(() => ({ kind: 'todo', query: 'groc' }))
        await vi.waitFor(() => expect(search.results()).toHaveLength(1))
        expect(search.results()[0]).toMatchObject({ kind: 'todo', id: 't1' })
        expect(api.listMoments).not.toHaveBeenCalled()
        dispose()
    })

    it('clears when the trigger closes', async () => {
        vi.mocked(api.listMoments).mockResolvedValue([moment('m1', 'Grocery list')] as never)
        const [request, setRequest] = createSignal<{ kind: EmbedKind | null; query: string } | null>({
            kind: 'moment',
            query: 'groc',
        })
        const { search, dispose } = runSearch(request)
        await vi.waitFor(() => expect(search.results()).toHaveLength(1))
        setRequest(null)
        expect(search.results()).toEqual([])
        expect(search.loading()).toBe(false)
        dispose()
    })

    // Documents have no list endpoint: the kind's source flattens them out of
    // the projects, drops folders, and labels each one with where it lives.
    it('finds a document by flattening the projects, folders excluded', async () => {
        vi.mocked(api.listProjects).mockResolvedValue([
            {
                id: 'p1',
                title: 'Athena',
                archived: false,
                cards: [],
                documents: [
                    { id: 'f1', kind: 'folder', title: 'Storage', parent_id: undefined, position: 0 },
                    { id: 'd1', kind: 'document', title: 'Storage decision', parent_id: 'f1', position: 0 },
                ],
            },
        ] as never)
        const { search, dispose } = runSearch(() => ({ kind: 'doc', query: 'storage' }))
        await vi.waitFor(() => expect(search.results()).toHaveLength(1))
        expect(search.results()[0]).toMatchObject({ kind: 'doc', id: 'd1', title: 'Storage decision', sub: 'Athena / Storage' })
        dispose()
    })

    it('caches a kind list rather than refetching it per keystroke', async () => {
        vi.mocked(api.listCanvases).mockResolvedValue([{ id: 'c1', title: 'Plan' }] as never)
        const [query, setQuery] = createSignal('p')
        const { search, dispose } = runSearch(() => ({ kind: 'canvas', query: query() }))
        await vi.waitFor(() => expect(search.results()).toHaveLength(1))
        setQuery('pl')
        await vi.waitFor(() => expect(search.results()).toHaveLength(1))
        expect(api.listCanvases).toHaveBeenCalledTimes(1)
        dispose()
    })
})

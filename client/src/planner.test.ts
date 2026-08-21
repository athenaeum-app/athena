import { describe, it, expect } from 'vitest'
import type { Project, ProjectCard, ProjectMilestone, TodoItem, TodoList } from './api'
import {
    datedRows,
    isContainer,
    isMovable,
    plannerFromLists,
    plannerFromProjects,
    sortPlanner,
    undatedRows,
    type PlannerRow,
} from './planner'

const iso = (daysFromToday: number) => {
    const date = new Date()
    date.setHours(12, 0, 0, 0)
    date.setDate(date.getDate() + daysFromToday)
    return date.toISOString()
}

const milestone = (id: string, dueAt?: string): ProjectMilestone => ({
    id,
    project_id: 'p1',
    title: id,
    due_at: dueAt,
    track: 0,
    position: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
})

const card = (id: string, fields: Partial<ProjectCard> = {}): ProjectCard => ({
    id,
    project_id: 'p1',
    milestone_id: 'm1',
    title: id,
    body: '',
    labels: '',
    priority: 0,
    done: false,
    dismissed: false,
    position: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...fields,
})

const project = (fields: Partial<Project> = {}): Project => ({
    id: 'p1',
    title: 'Kitchen',
    overview: '',
    accent: '#ff0000',
    icon: 'kitchen',
    position: 0,
    archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    milestones: [],
    cards: [],
    documents: [],
    ...fields,
})

describe('plannerFromProjects', () => {
    it('says where a row lives without naming the module it came from', () => {
        const rows = plannerFromProjects([
            project({ milestones: [milestone('m1')], cards: [card('c1', { priority: 2 })] }),
        ])
        const item = rows.find((r) => r.id === 'c1')!
        expect(item.source).toBe('project')
        expect(item.homeId).toBe('p1')
        expect(item.homeTitle).toBe('Kitchen')
        // The milestone a card sits in is a grouping inside its home, not the
        // home itself.
        expect(item.groupTitle).toBe('m1')
        expect(item.accent).toBe('#ff0000')
        expect(item.priority).toBe(2)
    })

    it('calls a milestone a container and a card not', () => {
        const rows = plannerFromProjects([project({ milestones: [milestone('m1')], cards: [card('c1')] })])
        expect(isContainer(rows.find((r) => r.id === 'm1')!)).toBe(true)
        expect(isContainer(rows.find((r) => r.id === 'c1')!)).toBe(false)
    })

    it('carries a milestone\'s progress, which is what it is drawn with', () => {
        const rows = plannerFromProjects([
            project({ milestones: [milestone('m1')], cards: [card('c1', { done: true }), card('c2')] }),
        ])
        const container = rows.find((r) => r.id === 'm1')!
        expect([container.done, container.total]).toEqual([1, 2])
    })
})

describe('datedRows', () => {
    it('keeps what has a day on it, soonest first, urgent first inside a day', () => {
        const rows = plannerFromProjects([
            project({
                cards: [
                    card('later', { due_at: iso(4) }),
                    card('soon-low', { due_at: iso(1), priority: 1 }),
                    card('soon-high', { due_at: iso(1), priority: 3 }),
                    card('never'),
                ],
            }),
        ])
        expect(datedRows(rows).map((r) => r.id)).toEqual(['soon-high', 'soon-low', 'later'])
    })
})

describe('undatedRows', () => {
    it('lists the outstanding work that has no date, and nothing that has one', () => {
        const rows = undatedRows(
            plannerFromProjects([
                project({
                    milestones: [milestone('dated', iso(3)), milestone('undated')],
                    cards: [
                        card('c-dated', { due_at: iso(1) }),
                        card('c-undated'),
                        card('c-done', { done: true }),
                        card('c-dismissed', { dismissed: true }),
                    ],
                }),
            ]),
        )
        expect(rows.map((r) => r.id)).toEqual(['c-undated', 'undated'])
        expect(rows.every((r) => !r.dueAt)).toBe(true)
    })

    it('leaves archived projects alone, the way the agenda does', () => {
        expect(undatedRows(plannerFromProjects([project({ archived: true, cards: [card('c1')] })]))).toEqual([])
    })

    it('drops a milestone whose cards are all finished, and keeps an empty one', () => {
        const finished = undatedRows(
            plannerFromProjects([project({ milestones: [milestone('m1')], cards: [card('c1', { done: true })] })]),
        )
        expect(finished).toEqual([])
        expect(
            undatedRows(plannerFromProjects([project({ milestones: [milestone('m1')] })])).map((r) => r.id),
        ).toEqual(['m1'])
    })

    describe('the order it comes back in', () => {
        // Two projects, so the three orders actually differ. Named out of
        // alphabetical order on purpose: a sort that happens to agree with
        // insertion order proves nothing.
        const rows = () =>
            plannerFromProjects([
                project({
                    id: 'p2',
                    title: 'Zinc works',
                    milestones: [milestone('m1')],
                    cards: [card('anvil', { priority: 1 }), card('crucible', { priority: 3 })],
                }),
                project({
                    id: 'p1',
                    title: 'Bindery',
                    milestones: [milestone('m2')],
                    cards: [card('boards', { priority: 2, milestone_id: 'm2' })],
                }),
            ])

        it('groups by where the work lives, highest priority first inside one', () => {
            expect(undatedRows(rows(), 'home').map((r) => r.id)).toEqual(['boards', 'm2', 'crucible', 'anvil', 'm1'])
        })

        it('puts the most urgent first wherever it lives', () => {
            expect(undatedRows(rows(), 'priority').map((r) => r.id)).toEqual(['crucible', 'boards', 'anvil', 'm2', 'm1'])
        })

        it('reads alphabetically by name, homes mixed together', () => {
            expect(undatedRows(rows(), 'name').map((r) => r.id)).toEqual(['anvil', 'boards', 'crucible', 'm1', 'm2'])
        })

        it('groups by home when nobody asked for an order', () => {
            expect(undatedRows(rows())).toEqual(undatedRows(rows(), 'home'))
        })
    })

    it('sorts without disturbing what it was handed', () => {
        const original: PlannerRow[] = plannerFromProjects([
            project({ cards: [card('b'), card('a')] }),
        ])
        const before = original.map((r) => r.id)
        sortPlanner(original, 'name')
        expect(original.map((r) => r.id)).toEqual(before)
    })
})

describe('a list as a container', () => {
    const item = (id: string, fields: Partial<TodoItem> = {}): TodoItem => ({
        id,
        list_id: 'l1',
        text: id,
        done: false,
        position: 0,
        rolled_over: false,
        priority: 0,
        recurrence: '',
        reset_mode: 'calendar',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...fields,
    })

    const list = (fields: Partial<TodoList> = {}): TodoList => ({
        id: 'l1',
        kind: 'general',
        title: 'Weekend jobs',
        notes: '',
        position: 0,
        reset_mode: 'calendar',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        items: [],
        ...fields,
    })

    it('draws the list once for a day several of its tasks land on', () => {
        const rows = plannerFromLists([list({ items: [item('a', { due_at: iso(2) }), item('b', { due_at: iso(2) })] })])
        const containers = rows.filter((r) => r.kind === 'list')
        expect(containers).toHaveLength(1)
        expect(containers[0].title).toBe('Weekend jobs')
        expect(isContainer(containers[0])).toBe(true)
    })

    it('leaves a lone task alone: one thing is not a container', () => {
        const rows = plannerFromLists([list({ items: [item('a', { due_at: iso(2) }), item('b', { due_at: iso(5) })] })])
        expect(rows.filter((r) => r.kind === 'list')).toEqual([])
    })

    it('counts the finished ones in the meter, so ticking fills it rather than emptying the day', () => {
        const rows = plannerFromLists([
            list({
                items: [
                    item('a', { due_at: iso(2), done: true }),
                    item('b', { due_at: iso(2), done: true }),
                    item('c', { due_at: iso(2) }),
                ],
            }),
        ])
        const container = rows.find((r) => r.kind === 'list')!
        expect([container.done, container.total]).toEqual([2, 3])
        // The finished tasks are meter, not rows of their own.
        expect(rows.filter((r) => r.kind === 'task').map((r) => r.id)).toEqual(['c'])
    })

    it('draws no container for a day whose work is all behind you', () => {
        const rows = plannerFromLists([
            list({ items: [item('a', { due_at: iso(-3), done: true }), item('b', { due_at: iso(-3), done: true })] }),
        ])
        expect(rows).toEqual([])
    })

    it('leaves daily lists out entirely, dates or no dates', () => {
        const rows = plannerFromLists([
            list({ kind: 'daily', items: [item('a', { due_at: iso(1) }), item('b', { due_at: iso(1) })] }),
        ])
        expect(rows).toEqual([])
    })

    it('is not a thing that can be moved, having no date of its own', () => {
        const rows = plannerFromLists([list({ items: [item('a', { due_at: iso(2) }), item('b', { due_at: iso(2) })] })])
        expect(isMovable(rows.find((r) => r.kind === 'list')!)).toBe(false)
        expect(isMovable(rows.find((r) => r.kind === 'task')!)).toBe(true)
    })

    it('comes before the work it holds inside its day', () => {
        const rows = datedRows(
            plannerFromLists([
                list({ items: [item('a', { due_at: iso(2), priority: 3 }), item('b', { due_at: iso(2) })] }),
            ]),
        )
        expect(rows.map((r) => r.kind)).toEqual(['list', 'task', 'task'])
    })
})

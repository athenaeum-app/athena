import { describe, it, expect } from 'vitest'
import type { Project, ProjectCard, ProjectMilestone } from './api'
import { datedRows, isContainer, plannerFromProjects, sortPlanner, undatedRows, type PlannerRow } from './planner'

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

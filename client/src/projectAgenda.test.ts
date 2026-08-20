import { describe, it, expect } from 'vitest'
import type { Project, ProjectCard, ProjectMilestone } from './api'
import { bucketByDue, projectDeadlines } from './projectAgenda'

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

describe('projectDeadlines', () => {
    it('takes dated cards and milestones, soonest first', () => {
        const deadlines = projectDeadlines([
            project({
                milestones: [milestone('m1', iso(9))],
                cards: [card('c1', { due_at: iso(3) }), card('c2', { due_at: iso(1) })],
            }),
        ])
        expect(deadlines.map((d) => d.id)).toEqual(['c2', 'c1', 'm1'])
        expect(deadlines[0]).toMatchObject({ kind: 'card', projectTitle: 'Kitchen', milestoneTitle: 'm1', accent: '#ff0000' })
        expect(deadlines[2].kind).toBe('milestone')
    })

    it('leaves out what is no longer waiting on anyone', () => {
        const deadlines = projectDeadlines([
            project({
                milestones: [milestone('m1')],
                cards: [
                    card('undated'),
                    card('done', { due_at: iso(1), done: true }),
                    card('dismissed', { due_at: iso(1), dismissed: true }),
                ],
            }),
        ])
        expect(deadlines).toEqual([])
    })

    it('drops a milestone once every card in it is done, and keeps an empty one', () => {
        const finished = projectDeadlines([
            project({ milestones: [milestone('m1', iso(2))], cards: [card('c1', { done: true })] }),
        ])
        expect(finished).toEqual([])

        // Nothing has been planned into an empty milestone yet, so its date is
        // still ahead of it rather than met.
        const empty = projectDeadlines([project({ milestones: [milestone('m1', iso(2))] })])
        expect(empty.map((d) => d.id)).toEqual(['m1'])
        expect(empty[0]).toMatchObject({ done: 0, total: 0 })
    })

    it('ignores archived projects, which is what archiving one is for', () => {
        const deadlines = projectDeadlines([
            project({ archived: true, milestones: [milestone('m1', iso(1))], cards: [card('c1', { due_at: iso(1) })] }),
        ])
        expect(deadlines).toEqual([])
    })
})

describe('bucketByDue', () => {
    it('sorts rows into deadline windows and drops the empty ones', () => {
        const rows = [
            { id: 'late', due: iso(-2) },
            { id: 'now', due: iso(0) },
            { id: 'soon', due: iso(1) },
            { id: 'week', due: iso(4) },
            { id: 'far', due: iso(40) },
        ]
        const buckets = bucketByDue(rows, (r) => r.due)
        expect(buckets.map((b) => b.key)).toEqual(['overdue', 'today', 'tomorrow', 'week', 'later'])
        expect(buckets.map((b) => b.rows.map((r) => r.id))).toEqual([['late'], ['now'], ['soon'], ['week'], ['far']])

        expect(bucketByDue([{ id: 'now', due: iso(0) }], (r) => r.due).map((b) => b.key)).toEqual(['today'])
    })
})

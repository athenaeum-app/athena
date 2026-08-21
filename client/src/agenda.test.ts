import { describe, it, expect } from 'vitest'
import type { TodoItem, TodoList } from './api'
import type { ProjectDeadline } from './projectAgenda'
import { agendaBuckets, agendaHead, agendaRows } from './agenda'

const iso = (daysFromToday: number) => {
    const date = new Date()
    date.setHours(12, 0, 0, 0)
    date.setDate(date.getDate() + daysFromToday)
    return date.toISOString()
}

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

const list = (id: string, items: TodoItem[], kind: TodoList['kind'] = 'general'): TodoList => ({
    id,
    kind,
    title: `${id} list`,
    notes: '',
    position: 0,
    reset_mode: 'calendar',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    items,
})

const deadline = (id: string, dueAt: string, fields: Partial<ProjectDeadline> = {}): ProjectDeadline => ({
    id,
    kind: 'card',
    title: id,
    dueAt,
    priority: 0,
    projectId: 'p1',
    projectTitle: 'The Bindery',
    accent: '#aabbcc',
    icon: 'book',
    ...fields,
})

describe('agendaRows', () => {
    it('merges tasks and deadlines, soonest first and higher priority ahead', () => {
        const lists = [list('l1', [item('later', { due_at: iso(3) }), item('today-low', { due_at: iso(0), priority: 1 })])]
        const deadlines = [deadline('today-high', iso(0), { priority: 3 }), deadline('tomorrow', iso(1))]
        expect(agendaRows(lists, deadlines).map((r) => r.key)).toEqual([
            'card:today-high',
            'task:today-low',
            'card:tomorrow',
            'task:later',
        ])
    })

    it('leaves out what is done, undated, or on a daily list', () => {
        const lists = [
            list('l1', [item('done', { due_at: iso(0), done: true }), item('undated'), item('kept', { due_at: iso(0) })]),
            list('l2', [item('daily', { due_at: iso(0), list_id: 'l2' })], 'daily'),
        ]
        expect(agendaRows(lists, []).map((r) => r.key)).toEqual(['task:kept'])
    })

    it('carries the list a task came from, so a row says where it lives', () => {
        const rows = agendaRows([list('l1', [item('write', { due_at: iso(0) })])], [])
        expect(rows[0].kind === 'task' && rows[0].listTitle).toBe('l1 list')
    })

    it('takes one half or the other on request', () => {
        const lists = [list('l1', [item('task', { due_at: iso(0) })])]
        const deadlines = [deadline('card', iso(0))]
        expect(agendaRows(lists, deadlines, { scope: 'tasks' }).map((r) => r.key)).toEqual(['task:task'])
        expect(agendaRows(lists, deadlines, { scope: 'projects' }).map((r) => r.key)).toEqual(['card:card'])
        expect(agendaRows(lists, deadlines, { scope: 'all' })).toHaveLength(2)
    })

    it('searches a deadline by its project and milestone, not only its title', () => {
        const deadlines = [
            deadline('sand the shelves', iso(0), { projectTitle: 'The kitchen', milestoneTitle: 'Carcass' }),
            deadline('read the proofs', iso(0)),
        ]
        expect(agendaRows([], deadlines, { search: 'kitchen' }).map((r) => r.key)).toEqual(['card:sand the shelves'])
        expect(agendaRows([], deadlines, { search: 'carcass' }).map((r) => r.key)).toEqual(['card:sand the shelves'])
        expect(agendaRows([], deadlines, { search: 'proofs' }).map((r) => r.key)).toEqual(['card:read the proofs'])
    })
})

describe('agendaBuckets', () => {
    it('groups by window and drops the windows that hold nothing', () => {
        const lists = [
            list('l1', [
                item('late', { due_at: iso(-2) }),
                item('now', { due_at: iso(0) }),
                item('far', { due_at: iso(30) }),
            ]),
        ]
        expect(agendaBuckets(lists, []).map((b) => b.key)).toEqual(['overdue', 'today', 'later'])
    })
})

describe('agendaHead', () => {
    it('keeps the first rows and counts the rest', () => {
        const items = Array.from({ length: 5 }, (_, i) => item(`t${i}`, { due_at: iso(i) }))
        const head = agendaHead([list('l1', items)], [], 2)
        expect(head.total).toBe(5)
        expect(head.hidden).toBe(3)
        expect(head.buckets.flatMap((b) => b.rows).map((r) => r.key)).toEqual(['task:t0', 'task:t1'])
    })

    it('hides nothing when everything fits', () => {
        const head = agendaHead([list('l1', [item('one', { due_at: iso(0) })])], [], 12)
        expect({ total: head.total, hidden: head.hidden }).toEqual({ total: 1, hidden: 0 })
    })
})

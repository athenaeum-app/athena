import { describe, it, expect } from 'vitest'
import { serializeLists, parseLists } from './todoTransfer'
import type { TodoList } from './api'

const item = (over: Partial<TodoList['items'][number]> & { id: string; text: string }) => ({
    list_id: 'l1',
    done: false,
    position: 0,
    rolled_over: false,
    priority: 0,
    recurrence: '',
    reset_mode: 'calendar' as const,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...over,
})

const board: TodoList[] = [
    {
        id: 'l1',
        kind: 'general',
        title: 'Groceries',
        notes: 'Line one\nLine two',
        position: 0,
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-01T00:00:00Z',
        items: [
            item({ id: 'a', text: 'Buy milk', priority: 2, due_at: '2026-07-28T00:00:00Z' }),
            item({ id: 'b', text: 'Check the fridge', parent_id: 'a', done: true }),
            item({ id: 'c', text: 'Water plants', recurrence: 'daily', reset_mode: 'interval' }),
        ],
    },
]

describe('todo transfer', () => {
    it('serializes a board to readable markdown', () => {
        expect(serializeLists(board)).toBe(
            ['# Groceries (general)', '> Line one', '> Line two', '- [ ] Buy milk !2 @2026-07-28', '  - [x] Check the fridge', '- [ ] Water plants ~daily+interval', ''].join('\n'),
        )
    })

    it('round-trips every field', () => {
        const [list] = parseLists(serializeLists(board))
        expect(list.title).toBe('Groceries')
        expect(list.kind).toBe('general')
        expect(list.notes).toBe('Line one\nLine two')
        expect(list.items).toHaveLength(2)
        expect(list.items[0]).toMatchObject({ text: 'Buy milk', priority: 2, dueDate: '2026-07-28', done: false })
        expect(list.items[0].subtasks[0]).toMatchObject({ text: 'Check the fridge', done: true })
        expect(list.items[1]).toMatchObject({ text: 'Water plants', recurrence: 'daily', resetMode: 'interval' })
    })

    it('accepts a hand-written list with no metadata', () => {
        const [list] = parseLists('# Reading\n- [ ] Finish the chapter\n* [x] Return the library book\n')
        expect(list.kind).toBe('general')
        expect(list.items.map((i) => [i.text, i.done])).toEqual([
            ['Finish the chapter', false],
            ['Return the library book', true],
        ])
    })

    it('leaves unrecognised trailing words in the task text', () => {
        const [list] = parseLists('# X\n- [ ] Pay invoice #3 !important\n')
        expect(list.items[0].text).toBe('Pay invoice #3 !important')
        expect(list.items[0].priority).toBe(0)
    })

    it('keeps items that appear before any heading', () => {
        const [list] = parseLists('- [ ] Orphan task\n')
        expect(list.title).toBe('Imported list')
        expect(list.items[0].text).toBe('Orphan task')
    })

    it('ignores an unknown recurrence rather than inventing one', () => {
        const [list] = parseLists('# X\n- [ ] Odd task ~fortnightly\n')
        expect(list.items[0].text).toBe('Odd task ~fortnightly')
        expect(list.items[0].recurrence).toBe('')
    })
})

import type { TodoItem, TodoList, TodoResetMode } from './api'

// Plain-text interchange for to-do boards (issue #4).
//
// The point of this format is that a person, or a language model, can read and
// rewrite it without knowing anything about Athena. So it is markdown-ish
// checklists rather than JSON: reorder the lines, retitle things, split a task
// into subtasks, paste it back.
//
//   # Groceries (general)
//   > optional notes, one line per '>'
//   - [ ] Buy milk !2 @2026-07-28 ~daily+interval
//     - [x] Check the fridge first
//
// Trailing tokens on an item line, any order, all optional:
//   !1 !2 !3            priority (low, medium, high)
//   @YYYY-MM-DD         due date
//   ~daily|weekly|monthly[+calendar|+interval]   recurrence and reset mode
//
// Two-space indentation makes an item a subtask of the one above it. Nesting is
// one level deep, matching the data model.

export interface ParsedItem {
    text: string
    done: boolean
    priority: number
    dueDate?: string // YYYY-MM-DD
    recurrence: string
    resetMode: TodoResetMode
    subtasks: ParsedItem[]
}

export interface ParsedList {
    title: string
    kind: 'daily' | 'general'
    notes: string
    items: ParsedItem[]
}

const isoToDate = (iso?: string) => (iso ? iso.slice(0, 10) : undefined)

function itemLine(item: TodoItem, indent: string): string {
    const bits = [`${indent}- [${item.done ? 'x' : ' '}] ${item.text}`]
    if (item.priority > 0) bits.push(`!${item.priority}`)
    const due = isoToDate(item.due_at)
    if (due) bits.push(`@${due}`)
    if (item.recurrence) {
        // Only spell out the reset mode when it isn't the default, to keep the
        // common case uncluttered.
        bits.push(item.reset_mode === 'interval' ? `~${item.recurrence}+interval` : `~${item.recurrence}`)
    }
    return bits.join(' ')
}

export function serializeLists(lists: TodoList[]): string {
    const out: string[] = []
    for (const list of lists) {
        out.push(`# ${list.title} (${list.kind})`)
        for (const line of (list.notes || '').split('\n')) {
            if (line.trim()) out.push(`> ${line}`)
        }
        const items = list.items || []
        const roots = items.filter((i) => !i.parent_id)
        for (const root of roots) {
            out.push(itemLine(root, ''))
            for (const sub of items.filter((i) => i.parent_id === root.id)) {
                out.push(itemLine(sub, '  '))
            }
        }
        out.push('')
    }
    return out.join('\n').trimEnd() + '\n'
}

const RECURRENCES = new Set(['daily', 'weekly', 'monthly'])

// Pull trailing metadata tokens off an item's text, right to left, stopping at
// the first word that isn't one. Anything unrecognised stays part of the text,
// so a task genuinely called "Pay invoice #3 !important" keeps its wording.
function extractTokens(raw: string): Omit<ParsedItem, 'done' | 'subtasks'> {
    let text = raw.trim()
    let priority = 0
    let dueDate: string | undefined
    let recurrence = ''
    let resetMode: TodoResetMode = 'calendar'

    for (;;) {
        const match = /\s(\S+)$/.exec(text)
        if (!match) break
        const token = match[1]
        if (/^![123]$/.test(token) && priority === 0) {
            priority = Number(token.slice(1))
        } else if (/^@\d{4}-\d{2}-\d{2}$/.test(token) && !dueDate) {
            dueDate = token.slice(1)
        } else if (token.startsWith('~') && !recurrence) {
            const [rule, mode] = token.slice(1).split('+')
            if (!RECURRENCES.has(rule)) break
            recurrence = rule
            if (mode === 'interval') resetMode = 'interval'
        } else {
            break
        }
        text = text.slice(0, match.index)
    }
    return { text: text.trim(), priority, dueDate, recurrence, resetMode }
}

export function parseLists(input: string): ParsedList[] {
    const lists: ParsedList[] = []
    let current: ParsedList | null = null
    let lastRoot: ParsedItem | null = null

    for (const rawLine of input.split(/\r?\n/)) {
        const line = rawLine.trimEnd()
        if (!line.trim()) continue

        const heading = /^#\s+(.*?)(?:\s*\((daily|general)\))?$/.exec(line)
        if (heading) {
            current = { title: heading[1].trim() || 'Untitled list', kind: (heading[2] as 'daily' | 'general') || 'general', notes: '', items: [] }
            lists.push(current)
            lastRoot = null
            continue
        }
        // Content before any heading still needs somewhere to go, rather than
        // being silently dropped.
        if (!current) {
            current = { title: 'Imported list', kind: 'general', notes: '', items: [] }
            lists.push(current)
        }

        if (line.trimStart().startsWith('>')) {
            const note = line.trimStart().slice(1).trim()
            current.notes = current.notes ? `${current.notes}\n${note}` : note
            continue
        }

        const item = /^(\s*)[-*]\s+\[([ xX])\]\s*(.*)$/.exec(line)
        if (!item) continue
        const indent = item[1].length
        const parsed: ParsedItem = { ...extractTokens(item[3]), done: item[2].toLowerCase() === 'x', subtasks: [] }
        if (!parsed.text) continue

        if (indent >= 2 && lastRoot) {
            lastRoot.subtasks.push(parsed)
        } else {
            current.items.push(parsed)
            lastRoot = parsed
        }
    }
    return lists
}

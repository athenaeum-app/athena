import { type TodoItem, type TodoList } from './api'
import { bucketByDue, dueMs, type DueBucket, type ProjectDeadline } from './projectAgenda'

// The agenda: everything open with a date on it, wherever it lives. A to-do
// item and a dated project card are the same question to the person reading
// them ("what is due"), so they are merged into one run, sorted by date and
// then by priority, and grouped under Overdue, Today, Tomorrow, This week and
// Later.
//
// This lives apart from both modules because three things draw it now: the
// Tasks module's agenda view, the agenda embed, and whatever asks next. The
// project half already made the same move into projectAgenda, for the same
// reason: one answer, so two screens cannot disagree about what is outstanding
// or what order it comes in.

// Which half of the agenda is wanted. A project document usually wants the
// deadlines alone; a daily note wants the lot.
export type AgendaScope = 'all' | 'tasks' | 'projects'

export const AGENDA_SCOPES = ['all', 'tasks', 'projects'] as const

export const isAgendaScope = (value: string): value is AgendaScope => (AGENDA_SCOPES as readonly string[]).includes(value)

// How a due date is written wherever the agenda is read: short month and day,
// in the reader's locale. One copy, because two screens showing the same
// deadline in two formats is how a reader stops trusting either.
export const formatDue = (iso: string) =>
    new Intl.DateTimeFormat(navigator.language, { month: 'short', day: 'numeric' }).format(new Date(iso))

export type AgendaRow =
    | { kind: 'task'; key: string; dueAt: string; priority: number; item: TodoItem; listTitle: string }
    | { kind: 'project'; key: string; dueAt: string; priority: number; deadline: ProjectDeadline }

export interface AgendaOptions {
    scope?: AgendaScope
    // Matched against the row's own words: a task's text, or a deadline's
    // title, project and milestone, so "kitchen" finds a project's deadlines
    // without knowing what any of its cards are called.
    search?: string
}

// Everything due, soonest first, with the higher priority ahead inside a day.
//
// Daily lists are left out. Their items carry no due date you can see or set,
// so any left over from before would arrive here as rows with no explanation
// and no way to change them.
export function agendaRows(lists: TodoList[], deadlines: ProjectDeadline[], options: AgendaOptions = {}): AgendaRow[] {
    const scope = options.scope ?? 'all'
    const needle = (options.search ?? '').trim().toLowerCase()
    const matches = (...fields: (string | undefined)[]) =>
        !needle || fields.some((field) => (field ?? '').toLowerCase().includes(needle))

    const rows: AgendaRow[] = []
    if (scope !== 'projects') {
        const titles = new Map(lists.map((l) => [l.id, l.title]))
        for (const list of lists) {
            if (list.kind === 'daily') continue
            for (const item of list.items || []) {
                if (item.done || !item.due_at) continue
                if (!matches(item.text)) continue
                rows.push({
                    kind: 'task',
                    key: `task:${item.id}`,
                    dueAt: item.due_at,
                    priority: item.priority,
                    item,
                    listTitle: titles.get(item.list_id) ?? '',
                })
            }
        }
    }
    if (scope !== 'tasks') {
        for (const deadline of deadlines) {
            if (!matches(deadline.title, deadline.projectTitle, deadline.milestoneTitle)) continue
            rows.push({
                kind: 'project',
                key: `${deadline.kind}:${deadline.id}`,
                dueAt: deadline.dueAt,
                priority: deadline.priority,
                deadline,
            })
        }
    }
    rows.sort((a, b) => dueMs(a.dueAt) - dueMs(b.dueAt) || b.priority - a.priority)
    return rows
}

// The same run, grouped the way an agenda is read. Empty groups are dropped by
// bucketByDue, so a quiet week is short rather than five empty headings.
export function agendaBuckets(
    lists: TodoList[],
    deadlines: ProjectDeadline[],
    options: AgendaOptions = {},
): DueBucket<AgendaRow>[] {
    return bucketByDue(agendaRows(lists, deadlines, options), (row) => row.dueAt)
}

// The first `limit` rows, still grouped, and how many were left behind. An
// agenda inside a paragraph has to end somewhere, and ending on a count is
// more honest than ending on whatever happened to fit.
export function agendaHead(
    lists: TodoList[],
    deadlines: ProjectDeadline[],
    limit: number,
    options: AgendaOptions = {},
): { buckets: DueBucket<AgendaRow>[]; total: number; hidden: number } {
    const rows = agendaRows(lists, deadlines, options)
    const shown = rows.slice(0, limit)
    return {
        buckets: bucketByDue(shown, (row) => row.dueAt),
        total: rows.length,
        hidden: rows.length - shown.length,
    }
}

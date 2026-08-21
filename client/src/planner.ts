import { type Project, type TodoItem, type TodoList } from './api'
import { dueMs, projectWork, type ProjectWorkItem } from './projectAgenda'

// The planner: the surface that answers "when is this happening", and the one
// row type everything on it is drawn from.
//
// Two modules put work on it. A project contributes its cards and milestones;
// the Tasks module contributes the items on its lists. They are the same thing
// to a reader looking at a Tuesday, so they are the same row here, and the one
// component draws both. Before this they were two implementations of the same
// screen, and they had already started to disagree about whether you may tick
// a project row off an agenda.

// What a row is. The two containers (a milestone, a list) hold the other two
// and are drawn as what they are rather than as more work.
export type PlannerRowKind = 'card' | 'milestone' | 'task' | 'list'

// Which module the row came from. The planner itself does not care; a host
// does, because opening a card and opening a to-do list are different acts.
export type PlannerSource = 'project' | 'task'

export interface PlannerRow {
    id: string
    kind: PlannerRowKind
    source: PlannerSource
    title: string
    // Absent on undated work, which is most of the point: the tray is full of
    // rows that have never been given a day.
    dueAt?: string
    // 0 none, 1 low, 2 med, 3 high. A container carries none of its own.
    priority: number
    // Where it lives: its project, or its list. Named for the question rather
    // than for either module, because a row of each kind sits in one column.
    homeId: string
    homeTitle: string
    // The colour of that place, so a mixed day is still readable.
    accent: string
    icon: string
    // The milestone a card belongs to. A task has no equivalent: its list is
    // its home, not a second grouping inside it.
    groupTitle?: string
    // How far a container has got.
    done?: number
    total?: number
    // Two marks a row may carry. Both are general relations rather than task
    // trivia: something that comes back around, and something written about
    // elsewhere. Only the Tasks side sets them today.
    repeats?: string
    momentId?: string
}

// A row with a day on it, which is what every view but the tray draws.
export interface PlannerDated extends PlannerRow {
    dueAt: string
}

export const isContainer = (row: PlannerRow): boolean => row.kind === 'milestone' || row.kind === 'list'

// Whether the row is a thing with a date of its own. A milestone is: it has a
// due date on the server and dragging it moves that date. A list container is
// not: it is drawn from the tasks under it, exists only on the day they fall
// on, and has nothing of its own to move.
export const isMovable = (row: PlannerRow): boolean => row.kind !== 'list'

const fromWorkItem = (item: ProjectWorkItem): PlannerRow => ({
    id: item.id,
    kind: item.kind,
    source: 'project',
    title: item.title,
    dueAt: item.dueAt,
    priority: item.priority,
    homeId: item.projectId,
    homeTitle: item.projectTitle,
    accent: item.accent,
    icon: item.icon,
    groupTitle: item.milestoneTitle,
    done: item.done,
    total: item.total,
})

// Every live project's outstanding work, dated or not. projectWork already
// decides what "outstanding" means (archived projects out, finished cards out,
// a milestone whose cards are all done out), and that answer is not the
// planner's to give a second time.
export function plannerFromProjects(projects: Project[]): PlannerRow[] {
    return projectWork(projects).map(fromWorkItem)
}

// A list has no colour of its own, so it is given one from its name: the same
// name always gets the same colour, which is what makes a column of several
// lists readable at a glance. The palette is the projects' own, so a day
// holding both halves looks like one app rather than two.
const LIST_ACCENTS = ['#67b8c7', '#c9a35c', '#9d8fd6', '#c98fae', '#8fbf8f', '#6fae93', '#bf8f8f', '#8f9fbf']

export function listAccent(title: string): string {
    let hash = 0
    for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    return LIST_ACCENTS[hash % LIST_ACCENTS.length]
}

const fromTodoItem = (item: TodoItem, list: TodoList): PlannerRow => ({
    id: item.id,
    kind: 'task',
    source: 'task',
    title: item.text,
    dueAt: item.due_at,
    priority: item.priority,
    homeId: list.id,
    homeTitle: list.title || 'Untitled list',
    accent: listAccent(list.title || ''),
    icon: 'task_alt',
    repeats: item.recurrence || undefined,
    momentId: item.moment_id || undefined,
})

// How many tasks a list needs due on one day before it is worth drawing as the
// thing that holds them. One is a task, not a container with one thing in it.
const CONTAINER_MIN = 2

// A list on the day its tasks land, drawn the way a milestone is: the thing
// the work feeds into rather than more work.
//
// A list has no due date of its own, unlike a milestone, so what dates it is
// what is inside it. The meter counts everything on that list due that day,
// finished included, which is what makes it a meter rather than a tally: tick
// one off and the bar fills instead of the row disappearing.
const containerRow = (list: TodoList, day: TodoItem[]): PlannerRow => ({
    // Not an entity id: this row exists only for this list on this day.
    id: `list:${list.id}:${dueMs(day[0].due_at)}`,
    kind: 'list',
    source: 'task',
    title: list.title || 'Untitled list',
    dueAt: day[0].due_at,
    priority: 0,
    homeId: list.id,
    homeTitle: list.title || 'Untitled list',
    accent: listAccent(list.title || ''),
    icon: 'checklist',
    done: day.filter((item) => item.done).length,
    total: day.length,
})

// Everything outstanding on the to-do lists, plus a container row per list per
// day where several tasks land together.
//
// Daily lists are left out, the same exclusion the agenda makes and for the
// same reason: their items carry no due date you can see or set, so they would
// arrive as rows nothing can be done to, in a tray whose whole purpose is
// giving something a date.
export function plannerFromLists(lists: TodoList[]): PlannerRow[] {
    const out: PlannerRow[] = []
    for (const list of lists) {
        if (list.kind === 'daily') continue
        const items = list.items || []
        for (const item of items) {
            if (item.done) continue
            out.push(fromTodoItem(item, list))
        }

        const byDay = new Map<number, TodoItem[]>()
        for (const item of items) {
            if (!item.due_at) continue
            const day = dueMs(item.due_at)
            const found = byDay.get(day)
            if (found) found.push(item)
            else byDay.set(day, [item])
        }
        for (const day of byDay.values()) {
            // A day whose work is all behind you needs no container: the list
            // would sit there on a Tuesday in the past with nothing under it.
            if (day.length < CONTAINER_MIN || day.every((item) => item.done)) continue
            out.push(containerRow(list, day))
        }
    }
    return out
}

// The dated half, soonest first. Inside a day the container comes before the
// work it holds, because it is what introduces the work rather than another
// piece of it; then the higher priority first.
export function datedRows(rows: PlannerRow[]): PlannerDated[] {
    return rows
        .filter((row): row is PlannerDated => !!row.dueAt)
        .sort(
            (a, b) =>
                dueMs(a.dueAt) - dueMs(b.dueAt) ||
                Number(isContainer(b)) - Number(isContainer(a)) ||
                b.priority - a.priority,
        )
}

// How a pile of undated work can be ordered. Three questions get asked of it:
// where does this live, what is most important, and where is the one called X.
// Each is a different order and no one of them answers the other two.
//
// `home` is a project on one side and a list on the other, so the surface
// supplies the word rather than the table: the value is the same sort either
// way and does not need saying twice.
export const PLANNER_SORTS = [
    { v: 'home', label: 'Where' },
    { v: 'priority', label: 'Priority' },
    { v: 'name', label: 'Name' },
] as const

export type PlannerSort = (typeof PLANNER_SORTS)[number]['v']

export const isPlannerSort = (value: string): value is PlannerSort => PLANNER_SORTS.some((s) => s.v === value)

// Every order falls back through the other two, so rows that tie on the chosen
// one still come out in a stable and readable sequence rather than in whatever
// order they happened to load.
const plannerOrder: Record<PlannerSort, (a: PlannerRow, b: PlannerRow) => number> = {
    home: (a, b) => a.homeTitle.localeCompare(b.homeTitle) || b.priority - a.priority || a.title.localeCompare(b.title),
    priority: (a, b) => b.priority - a.priority || a.homeTitle.localeCompare(b.homeTitle) || a.title.localeCompare(b.title),
    name: (a, b) => a.title.localeCompare(b.title) || a.homeTitle.localeCompare(b.homeTitle),
}

export const sortPlanner = (rows: PlannerRow[], sort: PlannerSort = 'home'): PlannerRow[] =>
    [...rows].sort(plannerOrder[sort])

// The undated part: work that is real but has never been put on a day. The
// planner keeps it beside the days so a date can be given by dragging it onto
// one.
// An undated milestone belongs here as much as an undated card does: both are
// things with a date still to give.
export function undatedRows(rows: PlannerRow[], sort: PlannerSort = 'home'): PlannerRow[] {
    return sortPlanner(
        rows.filter((row) => !row.dueAt),
        sort,
    )
}

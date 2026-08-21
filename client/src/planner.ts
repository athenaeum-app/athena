import { type Project } from './api'
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
}

// A row with a day on it, which is what every view but the tray draws.
export interface PlannerDated extends PlannerRow {
    dueAt: string
}

export const isContainer = (row: PlannerRow): boolean => row.kind === 'milestone' || row.kind === 'list'

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

// The dated half, soonest first, with the higher priority ahead inside a day.
export function datedRows(rows: PlannerRow[]): PlannerDated[] {
    return rows
        .filter((row): row is PlannerDated => !!row.dueAt)
        .sort((a, b) => dueMs(a.dueAt) - dueMs(b.dueAt) || b.priority - a.priority)
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

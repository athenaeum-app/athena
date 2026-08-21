import { type Project } from './api'

// What a project owes a date on: cards with a due date, and the milestones
// that carry one. The Tasks module's agenda and the Projects overview both
// draw from this, so "what is due" means the same thing in both places rather
// than being worked out twice with two sets of rules.
//
// A dated card is a task in every sense that matters to the reader, which is
// why the Tasks agenda lists them beside its own items.

export type DeadlineKind = 'card' | 'milestone'

// A piece of a project's outstanding work, dated or not. The overview lets
// one be dragged onto a day, which is the same row before and after it has a
// date, so the date is the only part that is optional.
export interface ProjectWorkItem {
    id: string
    kind: DeadlineKind
    title: string
    dueAt?: string
    // 0 none, 1 low, 2 med, 3 high. Milestones carry no priority of their own.
    priority: number
    projectId: string
    projectTitle: string
    // The project's identity, so a row is recognisable at a glance in a list
    // that mixes several projects together.
    accent: string
    icon: string
    // Which milestone a card sits in, and how a milestone is progressing.
    milestoneTitle?: string
    done?: number
    total?: number
}

// One with a date on it, which is what an agenda is made of.
export interface ProjectDeadline extends ProjectWorkItem {
    dueAt: string
}

const startOfToday = () => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    return date.getTime()
}

// Dates are compared by the day they fall on: a task due at any hour today is
// due today.
export const dueMs = (iso?: string) => (iso ? new Date(iso).setHours(0, 0, 0, 0) : Infinity)

// Everything a live project still has outstanding, dated or not.
//
// Archived projects are left out. Archiving is how a project stops being work
// in progress, and a shelved deadline resurfacing on a to-do list is exactly
// what archiving was meant to stop.
//
// A card that is done or dismissed is behind you. A milestone whose cards are
// all finished has landed, whatever its date says; an empty one has not,
// since nothing has been planned into it yet.
export function projectWork(projects: Project[]): ProjectWorkItem[] {
    const out: ProjectWorkItem[] = []
    for (const project of projects) {
        if (project.archived) continue
        const milestoneTitles = new Map(project.milestones.map((m) => [m.id, m.title]))
        const live = project.cards.filter((c) => !c.dismissed)

        for (const card of live) {
            if (card.done) continue
            out.push({
                id: card.id,
                kind: 'card',
                title: card.title,
                dueAt: card.due_at,
                priority: card.priority,
                projectId: project.id,
                projectTitle: project.title,
                accent: project.accent,
                icon: project.icon,
                milestoneTitle: milestoneTitles.get(card.milestone_id),
            })
        }

        for (const milestone of project.milestones) {
            const cards = live.filter((c) => c.milestone_id === milestone.id)
            const done = cards.filter((c) => c.done).length
            if (cards.length > 0 && done === cards.length) continue
            out.push({
                id: milestone.id,
                kind: 'milestone',
                title: milestone.title,
                dueAt: milestone.due_at,
                priority: 0,
                projectId: project.id,
                projectTitle: project.title,
                accent: project.accent,
                icon: project.icon,
                done,
                total: cards.length,
            })
        }
    }
    return out
}

// The dated part of that, soonest first: what the agendas are made of.
export function projectDeadlines(projects: Project[]): ProjectDeadline[] {
    return projectWork(projects)
        .filter((item): item is ProjectDeadline => !!item.dueAt)
        .sort((a, b) => dueMs(a.dueAt) - dueMs(b.dueAt) || b.priority - a.priority)
}

// How a pile of undated work can be ordered. Three questions get asked of it:
// what is on this project, what is most important, and where is the one called
// X. Each is a different order, and no one of them answers the other two.
export const WORK_SORTS = [
    { v: 'project', label: 'Project' },
    { v: 'priority', label: 'Priority' },
    { v: 'name', label: 'Name' },
] as const

export type WorkSort = (typeof WORK_SORTS)[number]['v']

export const isWorkSort = (value: string): value is WorkSort => WORK_SORTS.some((s) => s.v === value)

// Every order falls back through the other two, so rows that tie on the chosen
// one still come out in a stable and readable sequence rather than in whatever
// order the projects happened to load.
const workOrder: Record<WorkSort, (a: ProjectWorkItem, b: ProjectWorkItem) => number> = {
    project: (a, b) => a.projectTitle.localeCompare(b.projectTitle) || b.priority - a.priority || a.title.localeCompare(b.title),
    priority: (a, b) => b.priority - a.priority || a.projectTitle.localeCompare(b.projectTitle) || a.title.localeCompare(b.title),
    name: (a, b) => a.title.localeCompare(b.title) || a.projectTitle.localeCompare(b.projectTitle),
}

export const sortWork = (items: ProjectWorkItem[], sort: WorkSort = 'project'): ProjectWorkItem[] =>
    [...items].sort(workOrder[sort])

// The undated part: work that is real but has never been put on a day. The
// overview keeps it beside the timeline so a date can be given by dragging it
// onto one. By project unless asked otherwise, since that is the order it was
// written in.
export function unscheduledWork(projects: Project[], sort: WorkSort = 'project'): ProjectWorkItem[] {
    return sortWork(
        projectWork(projects).filter((item) => !item.dueAt),
        sort,
    )
}

// The deadline windows an agenda is read in. Ordered soonest first; a row
// falls in the first window it fits.
export interface DueBucket<T> {
    key: 'overdue' | 'today' | 'tomorrow' | 'week' | 'later'
    label: string
    rows: T[]
}

// Sorts rows into those windows, dropping the windows that stay empty so an
// agenda shows headings for the days that actually hold something.
export function bucketByDue<T>(rows: T[], dueOf: (row: T) => string | undefined): DueBucket<T>[] {
    const today = startOfToday()
    const tomorrowDate = new Date(today)
    tomorrowDate.setDate(tomorrowDate.getDate() + 1)
    const tomorrow = tomorrowDate.getTime()
    const weekDate = new Date(today)
    weekDate.setDate(weekDate.getDate() + 7)
    const weekEnd = weekDate.getTime()

    const buckets: DueBucket<T>[] = [
        { key: 'overdue', label: 'Overdue', rows: [] },
        { key: 'today', label: 'Today', rows: [] },
        { key: 'tomorrow', label: 'Tomorrow', rows: [] },
        { key: 'week', label: 'This week', rows: [] },
        { key: 'later', label: 'Later', rows: [] },
    ]
    for (const row of rows) {
        const ms = dueMs(dueOf(row))
        const bucket = ms < today ? buckets[0] : ms === today ? buckets[1] : ms === tomorrow ? buckets[2] : ms <= weekEnd ? buckets[3] : buckets[4]
        bucket.rows.push(row)
    }
    return buckets.filter((b) => b.rows.length > 0)
}

// ---- the timeline ----

// How many days the overview's timeline draws a column for, starting today.
// A fortnight is as far as a run of individual days stays worth reading:
// past that the gaps say nothing, so what is left is gathered into "Later".
export const TIMELINE_DAYS = 14

export interface TimelineDay {
    // Local midnight, which is what dueMs compares against.
    at: number
    today: boolean
    weekend: boolean
    rows: ProjectDeadline[]
}

// Walks the calendar a day at a time rather than adding 24 hours: a day is
// not always 86400 seconds long, and an hour lost to daylight saving would
// slide every column after it onto the wrong date.
export function timelineDays(deadlines: ProjectDeadline[], span = TIMELINE_DAYS): TimelineDay[] {
    const cursor = new Date(startOfToday())
    const days: TimelineDay[] = []
    for (let i = 0; i < span; i++) {
        const at = cursor.getTime()
        const weekday = cursor.getDay()
        days.push({
            at,
            today: i === 0,
            weekend: weekday === 0 || weekday === 6,
            rows: deadlines.filter((d) => dueMs(d.dueAt) === at),
        })
        cursor.setDate(cursor.getDate() + 1)
    }
    return days
}

// The two ends of that run: what a column cannot show because it has already
// passed, and what falls beyond the last day drawn.
export function timelineEnds(deadlines: ProjectDeadline[], span = TIMELINE_DAYS): { overdue: ProjectDeadline[]; later: ProjectDeadline[] } {
    const today = startOfToday()
    const after = new Date(today)
    after.setDate(after.getDate() + span)
    const end = after.getTime()
    return {
        overdue: deadlines.filter((d) => dueMs(d.dueAt) < today),
        later: deadlines.filter((d) => dueMs(d.dueAt) >= end),
    }
}

// How an agenda can be drawn. Three, because they answer different questions:
// what is due in the next fortnight, where in a month something falls, and
// what is overdue or landing this week.
export const AGENDA_VIEWS = [
    { v: 'timeline', label: 'Timeline', icon: 'view_week' },
    { v: 'calendar', label: 'Calendar', icon: 'calendar_month' },
    { v: 'list', label: 'List', icon: 'format_list_bulleted' },
] as const

export type AgendaView = (typeof AGENDA_VIEWS)[number]['v']

// ---- the calendar ----

// A month, the other way of aiming at a day. The timeline is the near future
// in detail; a month is how anything further out gets a date at all, since a
// run of fourteen columns cannot hold a day in October.

export interface CalendarDay extends TimelineDay {
    // False for the days either side of the month, which are drawn dimmed and
    // still take a drop: the turn of a month should not be a wall.
    inMonth: boolean
}

// Six weeks always, so the grid keeps its height as the months change under
// it. A month needs five rows or six depending on which weekday it opens on,
// and a grid that changes height when you page it is a grid that moves what
// you were aiming at.
export const CALENDAR_WEEKS = 6

// Local midnight on the first of whatever month that instant falls in.
export function monthStart(at: number): number {
    const date = new Date(at)
    date.setHours(0, 0, 0, 0)
    date.setDate(1)
    return date.getTime()
}

// Months, not days: setMonth on the first of a month cannot overshoot the way
// it would on the 31st.
export function shiftMonth(monthAt: number, by: number): number {
    const date = new Date(monthStart(monthAt))
    date.setMonth(date.getMonth() + by)
    return date.getTime()
}

// Which weekday a week opens on here: 0 is Sunday, 6 is Saturday. Taken from
// the reader's locale, where the engine knows it, because a Sunday-first grid
// reads as wrong to half the world and Monday-first to the other half.
export function weekStartDay(locale: string = navigator.language): number {
    try {
        const info = new Intl.Locale(locale) as unknown as {
            weekInfo?: { firstDay?: number }
            getWeekInfo?: () => { firstDay?: number }
        }
        const firstDay = info.getWeekInfo ? info.getWeekInfo().firstDay : info.weekInfo?.firstDay
        // ISO numbering: 1 is Monday and 7 is Sunday.
        if (typeof firstDay === 'number') return firstDay % 7
    } catch {
        // Older engines have no week info at all.
    }
    return 1
}

// The month as weeks of days, each carrying what falls due on it. Walked with
// setDate rather than by adding a day's worth of milliseconds, for the same
// reason the timeline is: an hour lost to daylight saving would slide every
// day after it onto the wrong date.
export function calendarWeeks(deadlines: ProjectDeadline[], monthAt: number, firstDay = weekStartDay()): CalendarDay[][] {
    const first = new Date(monthStart(monthAt))
    const month = first.getMonth()
    const today = startOfToday()
    const cursor = new Date(first)
    cursor.setDate(1 - ((first.getDay() - firstDay + 7) % 7))

    const weeks: CalendarDay[][] = []
    for (let week = 0; week < CALENDAR_WEEKS; week++) {
        const days: CalendarDay[] = []
        for (let day = 0; day < 7; day++) {
            const at = cursor.getTime()
            const weekday = cursor.getDay()
            days.push({
                at,
                inMonth: cursor.getMonth() === month,
                today: at === today,
                weekend: weekday === 0 || weekday === 6,
                rows: deadlines.filter((d) => dueMs(d.dueAt) === at),
            })
            cursor.setDate(cursor.getDate() + 1)
        }
        weeks.push(days)
    }
    return weeks
}

import { type Project } from './api'

// What a project owes a date on: cards with a due date, and the milestones
// that carry one. The Tasks module's agenda and the Projects overview both
// draw from this, so "what is due" means the same thing in both places rather
// than being worked out twice with two sets of rules.
//
// A dated card is a task in every sense that matters to the reader, which is
// why the Tasks agenda lists them beside its own items.

export type DeadlineKind = 'card' | 'milestone'

export interface ProjectDeadline {
    id: string
    kind: DeadlineKind
    title: string
    dueAt: string
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

const startOfToday = () => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    return date.getTime()
}

// Dates are compared by the day they fall on: a task due at any hour today is
// due today.
export const dueMs = (iso?: string) => (iso ? new Date(iso).setHours(0, 0, 0, 0) : Infinity)

// Everything a live project is waiting on, soonest first.
//
// Archived projects are left out. Archiving is how a project stops being work
// in progress, and a shelved deadline resurfacing on a to-do list is exactly
// what archiving was meant to stop.
export function projectDeadlines(projects: Project[]): ProjectDeadline[] {
    const out: ProjectDeadline[] = []
    for (const project of projects) {
        if (project.archived) continue
        const milestoneTitles = new Map(project.milestones.map((m) => [m.id, m.title]))
        const live = project.cards.filter((c) => !c.dismissed)

        for (const card of live) {
            if (card.done || !card.due_at) continue
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
            if (!milestone.due_at) continue
            const cards = live.filter((c) => c.milestone_id === milestone.id)
            const done = cards.filter((c) => c.done).length
            // A milestone whose cards are all finished has landed, whatever its
            // date says. An empty one has not: nothing has been planned into it
            // yet, so the date is still ahead of it.
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
    return out.sort((a, b) => dueMs(a.dueAt) - dueMs(b.dueAt) || b.priority - a.priority)
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

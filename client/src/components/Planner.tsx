import { createMemo, createSignal, For, Match, onCleanup, Show, Switch, type Accessor, type Component } from 'solid-js'
import {
    AGENDA_VIEWS,
    bucketByDue,
    calendarWeeks,
    dueMs,
    monthStart,
    shiftMonth,
    timelineDays,
    timelineEnds,
    type AgendaView,
    type TimelineDay,
} from '../projectAgenda'
import { PLANNER_SORTS, isContainer, type PlannerDated, type PlannerRow, type PlannerSort } from '../planner'
import { formatDue as fmtDue } from '../agenda'
import { PRIORITIES, priorityColor, priorityIcon } from '../priority'
import { Meter } from './Meter'

// The planner: a run of days, a month, a list, and the tray of work with no
// date yet, over the one row type both modules map onto (see planner.ts).
//
// It was the Projects overview's agenda and nothing else could reach it, which
// is why the Tasks module had a second, poorer copy that had already started
// disagreeing with this one. The host supplies the rows, the words for its own
// domain, and what a row does when it is opened or ticked; everything about
// how a day is drawn and dropped onto lives here.

export interface PlannerDrag {
    // Whether dragging is allowed at all: a viewer reads the planner, it does
    // not schedule anything.
    enabled: boolean
    item: () => PlannerRow | null
    start: (item: PlannerRow) => void
    end: () => void
    // Which target the pointer is over, so it can say it will take the drop.
    // A day is its midnight; the unscheduled tray is 'none'.
    over: () => number | 'none' | null
    // at: local midnight of the day to move it to, or null to clear the date.
    schedule: (item: PlannerRow, at: number | null) => void
    setOver: (target: number | 'none' | null) => void
}

// The drag state, made once by a host and handed to every part of its planner.
export function createPlannerDrag(options: {
    enabled: Accessor<boolean>
    schedule: (item: PlannerRow, at: number | null) => void
}): PlannerDrag {
    const [item, setItem] = createSignal<PlannerRow | null>(null)
    const [over, setOver] = createSignal<number | 'none' | null>(null)
    return {
        get enabled() {
            return options.enabled()
        },
        item,
        start: (row) => setItem(row),
        end: () => {
            setItem(null)
            setOver(null)
        },
        over,
        setOver,
        schedule: (row, at) => options.schedule(row, at),
    }
}

// Noon, not midnight: a date stored at midnight lands on the day before as
// soon as it is read a timezone to the west.
export const isoAtNoon = (at: number) => {
    const date = new Date(at)
    date.setHours(12, 0, 0, 0)
    return date.toISOString()
}

// The handlers that make something a drop target. Spread onto the element,
// because the month has forty-two of them and they must behave identically.
const dropTarget = (drag: PlannerDrag, key: number | 'none') => ({
    onDragOver: (e: DragEvent) => {
        if (!drag.item()) return
        // Without preventDefault the browser refuses the drop.
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        if (drag.over() !== key) drag.setOver(key)
    },
    onDragLeave: () => {
        if (drag.over() === key) drag.setOver(null)
    },
    onDrop: (e: DragEvent) => {
        e.preventDefault()
        const item = drag.item()
        drag.setOver(null)
        drag.end()
        if (item) drag.schedule(item, key === 'none' ? null : key)
    },
})

// What every part of the planner needs from its host beyond the rows.
export interface PlannerHandlers {
    drag: PlannerDrag
    // Handed the row rather than an id: what a row opens depends on what it
    // is, and that is one decision for the host to make rather than one for
    // every surface to make again.
    onOpen: (row: PlannerRow) => void
    // Absent for a reader who cannot write. A container never gets one: a
    // milestone is finished by its cards and a list by its tasks, so a tick
    // here would be a claim the board would contradict on the spot.
    onComplete?: (row: PlannerRow) => void
    // The host's own wording for a row's title attribute. Opening a card, a
    // board and a to-do list are three different sentences.
    openTitle?: (row: PlannerRow) => string
    // A row that names a moment offers a way into it, where the host can open
    // one.
    onOpenMoment?: (id: string) => void
}

const defaultOpenTitle = (row: PlannerRow) => (isContainer(row) ? `Open ${row.homeTitle}` : `Open "${row.title}"`)

const rowTitle = (handlers: PlannerHandlers, row: PlannerRow) => {
    const open = (handlers.openTitle ?? defaultOpenTitle)(row)
    return handlers.drag.enabled ? `Drag to a day to date it, or click to ${open[0].toLowerCase()}${open.slice(1)}` : open
}

// One row of work, wherever the planner draws it: in a day's column, in a
// day's row, in the plain list, or in the tray of undated work. Plain until
// hovered, with its home's colour down its left edge so a column of several
// projects, or several lists, is still readable.
//
// A container is drawn as what it is, which is not another piece of work: it
// is the thing the work around it feeds into. It takes a surface of its own,
// says what it is outright, wears its title in the home colour and carries a
// meter for the work inside it. An item stays plain and points back at its
// container with a chip, so the relationship is drawn once, in the direction
// it actually runs.
const Row: Component<{
    row: PlannerRow
    overdue: boolean
    handlers: PlannerHandlers
}> = (props) => {
    const row = () => props.row
    const drag = () => props.handlers.drag
    const dragging = () => drag().item()?.id === row().id
    const container = () => isContainer(row())
    const tickable = () => !!props.handlers.onComplete && !container()
    return (
        // A div rather than a button, since it holds a button: the tick has to
        // be its own control, and a button inside a button is not markup a
        // browser will keep.
        <div
            role="button"
            tabindex={0}
            onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                props.handlers.onOpen(row())
            }}
            draggable={drag().enabled}
            onDragStart={(e) => {
                // Firefox starts no drag at all without payload on the event.
                e.dataTransfer?.setData('text/plain', row().id)
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                drag().start(row())
            }}
            onDragEnd={() => drag().end()}
            onClick={() => props.handlers.onOpen(row())}
            data-testid={`agenda-${row().kind}`}
            class="hover:bg-element-matte hover:border-highlight/60 flex w-full items-start gap-2.5 rounded-md border p-2 text-left transition-colors"
            classList={{
                'cursor-grab active:cursor-grabbing': drag().enabled,
                'hover:cursor-pointer': !drag().enabled,
                'opacity-40': dragging(),
                'bg-element-matte border-element-accent': container(),
                'border-transparent': !container(),
            }}
            style={{ 'border-left': `${container() ? 5 : 3}px solid ${row().accent}` }}
            title={rowTitle(props.handlers, row())}
        >
            {/* One slot on the left, whatever the row is: a tick for work
                that can be finished from here, and the thing's own mark for
                everything else. */}
            <Show
                when={tickable()}
                fallback={
                    <span class="material-symbols-outlined mt-px shrink-0 text-[19px]" style={{ color: row().accent }}>
                        {row().kind === 'milestone' ? 'flag' : row().kind === 'list' ? 'checklist' : row().icon}
                    </span>
                }
            >
                <button
                    data-testid="agenda-complete"
                    onClick={(e) => {
                        e.stopPropagation()
                        props.handlers.onComplete!(row())
                    }}
                    // The row drags from anywhere on it, so a tick has to tick
                    // rather than pick the row up.
                    onPointerDown={(e) => e.stopPropagation()}
                    draggable={false}
                    title={`Mark "${row().title}" done`}
                    class="text-sub/70 hover:text-highlight mt-px shrink-0 transition-colors hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-[19px]">check_box_outline_blank</span>
                </button>
            </Show>
            <div class="min-w-0 flex-1">
                <Show when={container()}>
                    <p class="font-mono text-[10px] font-bold uppercase tracking-widest" style={{ color: row().accent }}>
                        {row().kind === 'milestone' ? 'Milestone' : 'List'}
                    </p>
                </Show>
                <p
                    class="text-base leading-snug"
                    classList={{ 'text-main': !container(), 'font-semibold': container() }}
                    style={container() ? { color: row().accent } : {}}
                >
                    {row().title}
                </p>
                {/* A milestone still says which project it belongs to. A list
                    is its own home, so the line would say the same word
                    twice, and that is what this leaves out. */}
                <Show when={row().homeTitle !== row().title}>
                    <p class="text-sub/80 flex min-w-0 items-center gap-1.5 text-xs">
                        {/* Capped rather than free: in a narrow column a long
                            project name would eat the chip beside it entirely. */}
                        <span class="max-w-[55%] shrink-0 truncate">{row().homeTitle}</span>
                        {/* The card names its milestone as a chip rather than
                            as more grey text: it is a place the card belongs
                            to, not another line about the card. */}
                        <Show when={!container() && row().groupTitle}>
                            <span class="border-element-accent text-sub/70 flex min-w-0 shrink items-center gap-0.5 rounded border px-1 py-px">
                                <span class="material-symbols-outlined shrink-0 text-[11px]">flag</span>
                                <span class="truncate">{row().groupTitle}</span>
                            </span>
                        </Show>
                    </p>
                </Show>
                {/* What a container is worth saying: how far the work inside
                    it has got. */}
                <Show when={container()}>
                    <div class="mt-1.5 flex items-center gap-2">
                        <Meter done={row().done ?? 0} total={row().total ?? 0} class="w-24" color={row().accent} />
                        <span class="text-sub/80 shrink-0 font-mono text-[11px]">
                            {row().done ?? 0}/{row().total ?? 0} done
                        </span>
                    </div>
                </Show>
            </div>
            {/* Two marks that belong to the row rather than to the view:
                that it comes back around, and that something is written about
                it elsewhere. */}
            <Show when={row().repeats}>
                <span class="material-symbols-outlined text-sub/60 mt-px shrink-0 text-[15px]" title={`Repeats ${row().repeats}`}>
                    repeat
                </span>
            </Show>
            <Show when={row().momentId && props.handlers.onOpenMoment}>
                <button
                    onClick={(e) => {
                        e.stopPropagation()
                        props.handlers.onOpenMoment!(row().momentId!)
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    draggable={false}
                    title="Open the linked moment"
                    class="text-sub/70 hover:text-main mt-px shrink-0 transition-colors hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-[15px]">bookmark</span>
                </button>
            </Show>
            <Show when={priorityIcon(row().priority)}>
                <span
                    class="material-symbols-outlined mt-px shrink-0 text-[17px]"
                    style={{ color: priorityColor(row().priority) }}
                    title={`${PRIORITIES.find((p) => p.v === row().priority)?.label} priority`}
                >
                    {priorityIcon(row().priority)}
                </span>
            </Show>
            <Show when={props.overdue && row().dueAt}>
                <span class="bg-danger/20 text-danger shrink-0 rounded px-1.5 py-0.5 text-xs font-bold">{fmtDue(row().dueAt!)}</span>
            </Show>
        </div>
    )
}

// The day columns, with their headings formatted here rather than in a module:
// a date reads in the reader's own locale, and the grouping is worth testing
// without a locale in the way.
const dayHeadings = (day: TimelineDay<PlannerDated>) => ({
    weekday: new Intl.DateTimeFormat(navigator.language, { weekday: 'short' }).format(new Date(day.at)),
    label: new Intl.DateTimeFormat(navigator.language, { month: 'short', day: 'numeric' }).format(new Date(day.at)),
})

// Long enough to read as a date, short enough to sit under a heading.
const dayTitle = (day: { at: number }) =>
    new Intl.DateTimeFormat(navigator.language, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(day.at))

// A drag near the edge of a scroller walks it: the pointer is already holding
// something, so it cannot reach for a scrollbar or a wheel.
export const edgeAutoScroll = (axis: 'x' | 'y') => {
    let el: HTMLElement | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => {
        clearInterval(timer)
        timer = undefined
    }
    onCleanup(stop)
    const EDGE = 72
    const STEP = 10
    return {
        ref: (node: HTMLElement) => (el = node),
        stop,
        onDragOver: (e: DragEvent) => {
            if (!el) return
            const box = el.getBoundingClientRect()
            const way =
                axis === 'x'
                    ? e.clientX < box.left + EDGE
                        ? -1
                        : e.clientX > box.right - EDGE
                          ? 1
                          : 0
                    : e.clientY < box.top + EDGE
                      ? -1
                      : e.clientY > box.bottom - EDGE
                        ? 1
                        : 0
            stop()
            if (!way) return
            timer = setInterval(() => el?.scrollBy(axis === 'x' ? { left: way * STEP } : { top: way * STEP }), 16)
        },
    }
}

const TimelineAcross: Component<{ rows: PlannerDated[]; handlers: PlannerHandlers }> = (props) => {
    const days = createMemo(() => timelineDays(props.rows))
    const ends = createMemo(() => timelineEnds(props.rows))
    const scroll = edgeAutoScroll('x')
    const drag = () => props.handlers.drag
    return (
        // Scrolls sideways rather than compressing: a fortnight of columns
        // never fits a panel, and a column too narrow to read a card in is
        // worse than one that has to be scrolled to.
        <div
            ref={scroll.ref}
            onDragOver={scroll.onDragOver}
            onDragLeave={scroll.stop}
            onDrop={scroll.stop}
            onDragEnd={scroll.stop}
            data-testid="agenda-timeline"
            /* overflow-y-hidden on purpose: a box with overflow-x auto and
               overflow-y visible computes to auto on both, and the scrollbar
               that puts on the side scrolls the two pixels of its own gutter
               and nothing else. */
            class="-mx-1 flex min-h-56 gap-2 overflow-x-auto overflow-y-hidden px-1 pb-2"
        >
            <Show when={ends().overdue.length > 0}>
                <div class="border-danger/60 flex w-64 shrink-0 flex-col rounded-lg border-t-2 pt-2">
                    <p class="text-danger mb-2 text-sm font-bold uppercase tracking-wide">Overdue</p>
                    <div class="flex flex-col gap-1.5">
                        <For each={ends().overdue}>{(row) => <Row row={row} overdue handlers={props.handlers} />}</For>
                    </div>
                </div>
            </Show>
            <For each={days()}>
                {(day) => (
                    <div
                        {...dropTarget(drag(), day.at)}
                        data-testid="agenda-day"
                        class="flex shrink-0 flex-col rounded-lg border-t-2 pt-2 transition-all"
                        classList={{
                            // An empty day stays a sliver even mid-drag:
                            // widening all fourteen of them would push the
                            // run past the edge of a window that cannot be
                            // scrolled while something is held. The one under
                            // the pointer opens up, which is the only one
                            // being aimed at.
                            'w-64': day.rows.length > 0 || drag().over() === day.at,
                            'w-20': day.rows.length === 0 && drag().over() !== day.at,
                            'border-highlight': day.today,
                            'border-element-accent': !day.today,
                            'opacity-50': day.rows.length === 0 && !day.today && drag().over() !== day.at,
                            'bg-highlight/10 ring-highlight ring-1': drag().over() === day.at,
                        }}
                        title={drag().item() ? `Move to ${dayTitle(day)}` : undefined}
                    >
                        <p class="mb-2 flex items-baseline gap-1.5">
                            <span class="text-sm font-bold uppercase tracking-wide" classList={{ 'text-highlight': day.today, 'text-main': !day.today }}>
                                {day.today ? 'Today' : dayHeadings(day).weekday}
                            </span>
                            <span class="text-sub text-xs" classList={{ 'font-bold': day.weekend }}>{dayHeadings(day).label}</span>
                        </p>
                        <div class="flex flex-1 flex-col gap-1.5">
                            <For each={day.rows}>{(row) => <Row row={row} overdue={false} handlers={props.handlers} />}</For>
                        </div>
                    </div>
                )}
            </For>
            <Show when={ends().later.length > 0}>
                <div class="border-element-accent flex w-64 shrink-0 flex-col rounded-lg border-t-2 pt-2">
                    <p class="text-sub mb-2 text-sm font-bold uppercase tracking-wide">Later</p>
                    <div class="flex flex-col gap-1.5">
                        <For each={ends().later}>{(row) => <Row row={row} overdue={false} handlers={props.handlers} />}</For>
                    </div>
                </div>
            </Show>
        </div>
    )
}

const TimelineDown: Component<{ rows: PlannerDated[]; handlers: PlannerHandlers }> = (props) => {
    const days = createMemo(() => timelineDays(props.rows))
    const ends = createMemo(() => timelineEnds(props.rows))
    const drag = () => props.handlers.drag
    // An empty day keeps its place in the run but not its height: the rhythm
    // of the dates is what makes a gap read as a gap.
    return (
        <div data-testid="agenda-timeline" class="flex flex-col">
            <Show when={ends().overdue.length > 0}>
                <div class="border-danger/60 flex gap-4 border-l-2 pb-4 pl-4">
                    <p class="text-danger w-24 shrink-0 text-sm font-bold uppercase tracking-wide">Overdue</p>
                    <div class="grid min-w-0 flex-1 grid-cols-1 gap-x-6 gap-y-1.5 xl:grid-cols-2">
                        <For each={ends().overdue}>{(row) => <Row row={row} overdue handlers={props.handlers} />}</For>
                    </div>
                </div>
            </Show>
            <For each={days()}>
                {(day) => (
                    <div
                        {...dropTarget(drag(), day.at)}
                        data-testid="agenda-day"
                        class="flex gap-4 rounded-r-lg border-l-2 pl-4 transition-colors"
                        classList={{
                            'border-highlight': day.today,
                            'border-element-accent': !day.today,
                            'pb-4': day.rows.length > 0,
                            'pb-2': day.rows.length === 0,
                            'bg-highlight/10': drag().over() === day.at,
                        }}
                        title={drag().item() ? `Move to ${dayTitle(day)}` : undefined}
                    >
                        <p class="w-24 shrink-0" classList={{ 'opacity-50': day.rows.length === 0 && !day.today && !drag().item() }}>
                            <span class="block text-sm font-bold uppercase tracking-wide" classList={{ 'text-highlight': day.today, 'text-main': !day.today }}>
                                {day.today ? 'Today' : dayHeadings(day).weekday}
                            </span>
                            <span class="text-sub text-xs" classList={{ 'font-bold': day.weekend }}>{dayHeadings(day).label}</span>
                        </p>
                        <div class="grid min-w-0 flex-1 grid-cols-1 gap-x-6 gap-y-1.5 xl:grid-cols-2">
                            <For each={day.rows}>{(row) => <Row row={row} overdue={false} handlers={props.handlers} />}</For>
                        </div>
                    </div>
                )}
            </For>
            <Show when={ends().later.length > 0}>
                <div class="border-element-accent flex gap-4 border-l-2 pl-4 pt-2">
                    <p class="text-sub w-24 shrink-0 text-sm font-bold uppercase tracking-wide">Later</p>
                    <div class="grid min-w-0 flex-1 grid-cols-1 gap-x-6 gap-y-1.5 xl:grid-cols-2">
                        <For each={ends().later}>{(row) => <Row row={row} overdue={false} handlers={props.handlers} />}</For>
                    </div>
                </div>
            </Show>
        </div>
    )
}

// The month, which is the only view that can reach a day in October: a run of
// fourteen columns cannot hold one, so anything further out than a fortnight
// would be undateable by hand entirely.
//
// A drag cannot let go to press a button, so the months turn under it: holding
// the pointer against either arrow, or against either edge of the grid, pages
// while it is held. The days either side of the month take drops too, so the
// turn of a month is not a wall.
const MONTH_PAGE_DWELL_MS = 700

// How many chips a day can show before it stops and counts the rest. Six weeks
// of cells have to fit a screen, so a busy day says how busy rather than
// growing until the grid does not.
const CALENDAR_DAY_ROWS = 3

const MonthGrid: Component<{ rows: PlannerDated[]; handlers: PlannerHandlers }> = (props) => {
    const [month, setMonth] = createSignal(monthStart(Date.now()))
    const drag = () => props.handlers.drag
    const weeks = createMemo(() => calendarWeeks(props.rows, month()))
    const label = () => new Intl.DateTimeFormat(navigator.language, { month: 'long', year: 'numeric' }).format(new Date(month()))
    const weekdays = createMemo(() => {
        const format = new Intl.DateTimeFormat(navigator.language, { weekday: 'short' })
        return weeks()[0].map((day) => format.format(new Date(day.at)))
    })
    const thisMonth = () => month() === monthStart(Date.now())

    // Pages while the pointer is held there, and re-arms itself, so a hand
    // resting on the edge walks forward a month at a time rather than once.
    // Deliberately not a drop target: releasing on an arrow should leave the
    // date alone rather than guess at a day.
    const pager = (by: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const stop = () => {
            clearTimeout(timer)
            timer = undefined
        }
        onCleanup(stop)
        return {
            onDragOver: () => {
                if (!drag().item() || timer) return
                timer = setTimeout(() => {
                    stop()
                    setMonth((at) => shiftMonth(at, by))
                }, MONTH_PAGE_DWELL_MS)
            },
            onDragLeave: stop,
            onDragEnd: stop,
            onDrop: stop,
        }
    }

    const Arrow: Component<{ by: number; icon: string; label: string }> = (arrow) => (
        <button
            onClick={() => setMonth((at) => shiftMonth(at, arrow.by))}
            {...pager(arrow.by)}
            title={drag().item() ? `${arrow.label} (hold to keep going)` : arrow.label}
            class="text-sub hover:text-main border-element-accent flex shrink-0 items-center rounded-md border px-1.5 py-1 transition-colors hover:cursor-pointer"
        >
            <span class="material-symbols-outlined text-base">{arrow.icon}</span>
        </button>
    )

    return (
        <div data-testid="agenda-calendar" class="flex flex-col">
            <div class="mb-2 flex items-center gap-2">
                <Arrow by={-1} icon="chevron_left" label="The month before" />
                <p data-testid="calendar-month" class="text-main font-serif min-w-44 text-center text-lg font-semibold">
                    {label()}
                </p>
                <Arrow by={1} icon="chevron_right" label="The month after" />
                <Show when={!thisMonth()}>
                    <button
                        onClick={() => setMonth(monthStart(Date.now()))}
                        title="Back to this month"
                        class="text-sub hover:text-main border-element-accent shrink-0 rounded-md border px-2 py-1 text-xs transition-colors hover:cursor-pointer"
                    >
                        This month
                    </button>
                </Show>
                <Show when={drag().enabled}>
                    <p class="text-sub/70 ml-auto text-sm">Drop one on a day to date it. Hold at an edge to change month.</p>
                </Show>
            </div>

            {/* The edges page too, and only while something is held: a hand
                carrying a card is already at the side of the grid by the time
                it wants the next month. */}
            <div class="flex items-stretch gap-1">
                <Show when={drag().item()}>
                    <div
                        {...pager(-1)}
                        data-testid="calendar-page-back"
                        class="border-element-accent bg-element text-sub/60 flex w-7 shrink-0 items-center justify-center rounded-md border border-dashed"
                        title="Hold here to go back a month"
                    >
                        <span class="material-symbols-outlined text-base">chevron_left</span>
                    </div>
                </Show>
                <div class="min-w-0 flex-1">
                    <div class="mb-1 grid grid-cols-7 gap-1">
                        <For each={weekdays()}>
                            {(name) => <p class="text-sub/70 truncate px-1 text-xs font-bold uppercase tracking-wide">{name}</p>}
                        </For>
                    </div>
                    <div class="grid grid-cols-7 gap-1">
                        <For each={weeks().flat()}>
                            {(day) => (
                                <div
                                    {...dropTarget(drag(), day.at)}
                                    data-testid="calendar-day"
                                    class="flex min-h-24 flex-col gap-1 rounded-md border p-1 transition-colors"
                                    classList={{
                                        'border-highlight': day.today,
                                        'border-element-accent/60': !day.today,
                                        'bg-element': day.inMonth,
                                        'opacity-50': !day.inMonth,
                                        'bg-highlight/10 ring-highlight ring-1': drag().over() === day.at,
                                    }}
                                    title={drag().item() ? `Move to ${dayTitle(day)}` : dayTitle(day)}
                                >
                                    <p class="flex items-baseline gap-1 px-0.5">
                                        <span
                                            class="text-xs font-bold"
                                            classList={{ 'text-highlight': day.today, 'text-main': !day.today && day.inMonth, 'text-sub': !day.inMonth }}
                                        >
                                            {new Date(day.at).getDate()}
                                        </span>
                                        <Show when={day.rows.length > CALENDAR_DAY_ROWS}>
                                            <span class="text-sub/60 ml-auto font-mono text-[10px]">{day.rows.length}</span>
                                        </Show>
                                    </p>
                                    <For each={day.rows.slice(0, CALENDAR_DAY_ROWS)}>
                                        {(row) => <Chip row={row} handlers={props.handlers} />}
                                    </For>
                                    <Show when={day.rows.length > CALENDAR_DAY_ROWS}>
                                        <p class="text-sub/60 px-0.5 text-[10px]">and {day.rows.length - CALENDAR_DAY_ROWS} more</p>
                                    </Show>
                                </div>
                            )}
                        </For>
                    </div>
                </div>
                <Show when={drag().item()}>
                    <div
                        {...pager(1)}
                        data-testid="calendar-page-on"
                        class="border-element-accent bg-element text-sub/60 flex w-7 shrink-0 items-center justify-center rounded-md border border-dashed"
                        title="Hold here to go on a month"
                    >
                        <span class="material-symbols-outlined text-base">chevron_right</span>
                    </div>
                </Show>
            </div>
        </div>
    )
}

// A day in a month is a seventh of the width, which is no room for a row. The
// chip keeps what survives that: the home's colour, the title, and whether it
// is a container, which is filled rather than outlined because a container
// should read as heavier than the work inside it.
const Chip: Component<{ row: PlannerDated; handlers: PlannerHandlers }> = (props) => {
    const row = () => props.row
    const drag = () => props.handlers.drag
    const container = () => isContainer(row())
    return (
        <button
            draggable={drag().enabled}
            onDragStart={(e) => {
                e.dataTransfer?.setData('text/plain', row().id)
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                drag().start(row())
            }}
            onDragEnd={() => drag().end()}
            onClick={() => props.handlers.onOpen(row())}
            data-testid={`calendar-${row().kind}`}
            class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] leading-tight transition-colors"
            classList={{
                'cursor-grab active:cursor-grabbing': drag().enabled,
                'hover:cursor-pointer': !drag().enabled,
                'opacity-40': drag().item()?.id === row().id,
                'font-bold text-white': container(),
                'text-main hover:bg-element-matte': !container(),
            }}
            style={
                container()
                    ? { 'background-color': row().accent }
                    : { 'border-left': `3px solid ${row().accent}`, 'border-radius': '2px' }
            }
            title={`${row().title} (${row().homeTitle})`}
        >
            <Show when={container()}>
                <span class="material-symbols-outlined shrink-0 text-[12px]">{row().kind === 'list' ? 'checklist' : 'flag'}</span>
            </Show>
            <span class="truncate">{row().title}</span>
        </button>
    )
}

// The timeline off: the same rows under Overdue, Today, Tomorrow, This week
// and Later, two abreast where there is room. Nothing is dragged here, because
// a bucket is a range of days and a drop would have to guess which.
const BucketList: Component<{ rows: PlannerDated[]; handlers: PlannerHandlers }> = (props) => {
    const buckets = createMemo(() => bucketByDue(props.rows, (row) => row.dueAt))
    const still = (): PlannerHandlers => ({ ...props.handlers, drag: { ...props.handlers.drag, enabled: false } })
    return (
        <div data-testid="agenda-list" class="flex flex-col gap-6">
            <For each={buckets()}>
                {(bucket) => (
                    <div>
                        <h4 class="border-element-accent/60 mb-2 flex items-center gap-2 border-b pb-1.5 text-sm font-bold uppercase tracking-wide">
                            <span
                                classList={{
                                    'text-danger': bucket.key === 'overdue',
                                    'text-highlight': bucket.key === 'today',
                                    'text-sub': bucket.key !== 'overdue' && bucket.key !== 'today',
                                }}
                            >
                                {bucket.label}
                            </span>
                            <span class="text-sub/60 font-mono text-xs">{bucket.rows.length}</span>
                        </h4>
                        <div class="grid grid-cols-1 gap-x-6 gap-y-1 lg:grid-cols-2 2xl:grid-cols-3">
                            <For each={bucket.rows}>
                                {(row) => <Row row={row} overdue={bucket.key === 'overdue'} handlers={still()} />}
                            </For>
                        </div>
                    </div>
                )}
            </For>
        </div>
    )
}

// The chosen view. The empty case belongs to the list alone: a run of days and
// a month are surfaces you drop onto, and nothing dated yet is exactly when you
// want to drop something. Hiding the days behind a line of text is what made
// the first date the hardest one to set.
export const PlannerBody: Component<{
    rows: PlannerDated[]
    view: AgendaView
    vertical: boolean
    handlers: PlannerHandlers
    // What the list says when there is nothing dated at all.
    emptyNote: string
}> = (props) => (
    <Switch>
        <Match when={props.view === 'calendar'}>
            <MonthGrid rows={props.rows} handlers={props.handlers} />
        </Match>
        <Match when={props.view === 'list'}>
            <Show when={props.rows.length > 0} fallback={<p class="text-sub/60 italic">{props.emptyNote}</p>}>
                <BucketList rows={props.rows} handlers={props.handlers} />
            </Show>
        </Match>
        <Match when={props.view === 'timeline' && props.vertical}>
            <TimelineDown rows={props.rows} handlers={props.handlers} />
        </Match>
        <Match when={props.view === 'timeline'}>
            <TimelineAcross rows={props.rows} handlers={props.handlers} />
        </Match>
    </Switch>
)

// The view control, on the surface it changes rather than only in a settings
// panel two screens away. The across/down toggle only means anything on the
// timeline, so it is only offered there.
export const PlannerViewSwitch: Component<{
    view: AgendaView
    setView: (view: AgendaView) => void
    vertical: boolean
    setVertical: (vertical: boolean) => void
}> = (props) => (
    <div class="flex items-center gap-2">
        <div data-testid="agenda-view" class="border-element-accent flex overflow-hidden rounded-md border">
            <For each={AGENDA_VIEWS}>
                {(option) => (
                    <button
                        onClick={() => props.setView(option.v)}
                        class="flex items-center px-2 py-1 transition-colors hover:cursor-pointer"
                        classList={{
                            'bg-highlight-strongest text-white': props.view === option.v,
                            'text-sub hover:text-main': props.view !== option.v,
                        }}
                        title={option.label}
                    >
                        <span class="material-symbols-outlined text-base">{option.icon}</span>
                    </button>
                )}
            </For>
        </div>
        <Show when={props.view === 'timeline'}>
            <div class="border-element-accent flex overflow-hidden rounded-md border">
                <For
                    each={[
                        { v: false, icon: 'view_column', label: 'Timeline across' },
                        { v: true, icon: 'view_agenda', label: 'Timeline down' },
                    ]}
                >
                    {(option) => (
                        <button
                            onClick={() => props.setVertical(option.v)}
                            class="flex items-center px-2 py-1 transition-colors hover:cursor-pointer"
                            classList={{
                                'bg-highlight-strongest text-white': props.vertical === option.v,
                                'text-sub hover:text-main': props.vertical !== option.v,
                            }}
                            title={option.label}
                        >
                            <span class="material-symbols-outlined text-base">{option.icon}</span>
                        </button>
                    )}
                </For>
            </div>
        </Show>
    </div>
)

// Work with no date on it. It stays under the days rather than off in a panel
// of its own, because the point of it is the short distance between a row here
// and the day it belongs on. Dropping something here takes its date off again.
export const PlannerTray: Component<{
    rows: PlannerRow[]
    sort: PlannerSort
    setSort: (sort: PlannerSort) => void
    // The host's word for where a row lives: Project on one side, List on the
    // other. The sort is the same either way.
    homeWord: string
    handlers: PlannerHandlers
}> = (props) => (
    <div
        {...dropTarget(props.handlers.drag, 'none')}
        data-testid="agenda-unscheduled"
        class="bg-element border-element-accent/60 mt-5 rounded-lg border p-4 transition-colors sm:p-5"
        classList={{ 'bg-highlight/10 ring-highlight ring-1': props.handlers.drag.over() === 'none' }}
    >
        <div class="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h3 class="text-main font-serif text-xl font-semibold">
                Not scheduled <span class="text-sub/60 font-mono text-base">{props.rows.length}</span>
            </h3>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Show when={props.handlers.drag.enabled}>
                    <p class="text-sub/70 text-sm">Drag one onto a day to date it. Drag a dated one back here to take its date off.</p>
                </Show>
                {/* The order is the reader's, not the module's: a pile with no
                    dates is read for where things live, for what is urgent, or
                    for one name, and those are three different orders. */}
                <div data-testid="unscheduled-sort" class="border-element-accent flex shrink-0 overflow-hidden rounded-md border">
                    <For each={PLANNER_SORTS}>
                        {(sort) => {
                            const label = () => (sort.v === 'home' ? props.homeWord : sort.label)
                            return (
                                <button
                                    onClick={() => props.setSort(sort.v)}
                                    class="px-2.5 py-1 text-xs transition-colors hover:cursor-pointer"
                                    classList={{
                                        'bg-highlight-strongest text-white': props.sort === sort.v,
                                        'text-sub hover:text-main': props.sort !== sort.v,
                                    }}
                                    title={`Sort by ${label().toLowerCase()}`}
                                >
                                    {label()}
                                </button>
                            )
                        }}
                    </For>
                </div>
            </div>
        </div>
        <Show
            when={props.rows.length > 0}
            fallback={<p class="text-sub/50 italic">Everything outstanding has a date on it.</p>}
        >
            <div class="grid max-h-72 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
                <For each={props.rows}>{(row) => <Row row={row} overdue={false} handlers={props.handlers} />}</For>
            </div>
        </Show>
    </div>
)

// Whether a row is behind: read here so a host does not have to import the
// date maths to ask one question about one row.
export const isOverdue = (row: PlannerRow): boolean => {
    if (!row.dueAt) return false
    return dueMs(row.dueAt) < new Date().setHours(0, 0, 0, 0)
}

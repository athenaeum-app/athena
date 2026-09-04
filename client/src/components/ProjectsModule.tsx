import { createSignal, createMemo, createEffect, on, untrack, For, Match, Show, Switch, onMount, onCleanup, type Component, type JSX } from 'solid-js'
import { createStore, produce, reconcile } from 'solid-js/store'
import {
    APIError,
    api,
    type Project,
    type ProjectMilestone,
    type ProjectCard,
    type ProjectDocument,
    type ProjectDocumentComment,
    type ProjectDocumentStatus,
    type ProjectDocumentVersion,
} from '../api'
import { useUI } from '../ui'
import { MomentBody, excerpt, clearProjectDocumentCache } from './MomentBody'
import {
    childDocuments,
    documentBlocks,
    documentOutline,
    documentPath,
    documentStatusBadge,
    documentSubtree,
    documentThreads,
    documentWordCount,
    folderCounts,
    nextDocumentPosition,
    openThreadCount,
    readingMinutes,
    type DocumentBlock,
    type DocumentHeading,
    type DocumentThread,
} from '../projectDocuments'
import {
    AGENDA_VIEWS,
    bucketByDue,
    calendarWeeks,
    monthStart,
    projectDeadlines,
    shiftMonth,
    timelineDays,
    timelineEnds,
    type ProjectDeadline,
    type ProjectWorkItem,
    type TimelineDay,
} from '../projectAgenda'
import { loadUsers, userName } from '../users'
import { Editor } from './Editor'
import { BookcaseDrift } from './BookcaseDrift'
// The agenda's date format, so a deadline reads the same here as it does on
// the Tasks agenda and inside an agenda embed.
import { formatDue as fmtDue } from '../agenda'
import { prefs, setPref, MODAL_WIDTH_CLASS } from '../prefs'
import { PRIORITIES, priorityColor, priorityIcon } from '../priority'
import { Meter } from './Meter'
import {
    PlannerBody,
    PlannerTray,
    PlannerViewSwitch,
    createPlannerDrag,
    edgeAutoScroll,
    isoAtNoon,
    type PlannerHandlers,
} from './Planner'
import { datedRows, plannerFromProjects, undatedRows, type PlannerRow } from '../planner'
import { desktop } from '../desktop'
import { Modal } from './Modal'

// Projects module: a portfolio of long-horizon efforts. Each project is a
// tabbed hub (brief, milestone board, documents, graveyard) with an identity
// color and icon. Milestones are board columns; columns sharing a track stack
// vertically and split the height. Cards dismiss (never silently delete) into
// a graveyard with a deep Ctrl+Z stack. Documents are durable reference content
// in an unbounded folder tree the project owns outright (ADR-0020); deleting
// one is recursive and lands on the same undo stack. Brief, card and document
// bodies render through the moment pipeline, so ::todo:id::, ::canvas:id::,
// ::project:id::, ::doc:id:: and [[moment]] embeds are live, and are written
// through the same Editor a moment uses (slash menu, [[ autocomplete,
// paste-to-attach).
//
// Mutations are optimistic: state first, request after, refetch on failure.
// Requires ManageProjects for writes; read-only otherwise.

interface ProjectsModuleProps {
    onClose: () => void
    canManage: boolean
    // A ::project:id:: embed elsewhere in the app asked for this project;
    // open straight onto it instead of the portfolio.
    initialProjectId?: string
    // Which tab that project should open on. The Tasks agenda sends a card or
    // a milestone here, and the board is where those live.
    initialProjectTab?: HubTab
    // A ::doc:id:: embed asked for one document inside that project: land on
    // the Documents tab with it open, rather than on the brief.
    initialDocumentId?: string
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
}

// ---- vocabulary ----


// A document's status, in the order it travels: written, settled, frozen. It
// is also the mode. Draft is the only one that can be typed into, which is
// what makes the control worth having: it used to sit beside an Edit button
// that decided the same thing per visit and told nobody else.
const DOCUMENT_STATUSES = [
    { v: 'draft', label: 'Draft', icon: 'edit_note', hint: 'Draft: click the text to write in it.' },
    { v: 'final', label: 'Final', icon: 'task_alt', hint: 'Final: the text is read only until it goes back to Draft.' },
    { v: 'locked', label: 'Locked', icon: 'lock', hint: 'Lock it: the title and body freeze until it comes back to Draft or Final.' },
] as const

// What a new document can start as. Client-side only: a template is a first
// draft of a body, not a kind of document, so nothing about it survives the
// creation. The plain path stays one tap and a template is one more.
interface DocumentTemplate {
    key: string
    label: string
    hint: string
    icon: string
    title: string
    body: string
}
const DOCUMENT_TEMPLATES: DocumentTemplate[] = [
    {
        key: 'decision',
        label: 'Decision record',
        hint: 'Context, decision, consequences',
        icon: 'gavel',
        title: 'Decision record',
        body: [
            '## Context',
            '',
            'What is going on, and why this has to be decided now.',
            '',
            '## Decision',
            '',
            'What was decided, in a sentence, then the detail behind it.',
            '',
            '## Consequences',
            '',
            'What this makes easier, what it makes harder, and what has to change because of it.',
            '',
        ].join('\n'),
    },
    {
        key: 'research',
        label: 'Research note',
        hint: 'Question, findings, sources',
        icon: 'science',
        title: 'Research note',
        body: [
            '## Question',
            '',
            'What is being answered, and for whom.',
            '',
            '## Findings',
            '',
            'What turned up, and how sure it is.',
            '',
            '## Sources',
            '',
            'Where it came from, so the next reader can check it.',
            '',
        ].join('\n'),
    },
]

const ACCENTS = ['#67b8c7', '#c9a35c', '#9d8fd6', '#c98fae', '#8fbf8f', '#6fae93', '#bf8f8f', '#8f9fbf']
const ICONS = ['space_dashboard', 'sports_esports', 'storefront', 'joystick', 'videocam', 'home', 'school', 'construction', 'brush', 'science', 'menu_book', 'flight']

// Free-form labels get a stable color from a fixed palette by name hash.
const LABEL_PALETTE = ['#c4b5fd', '#67e8f9', '#f9a8d4', '#fcd34d', '#86efac', '#fdba74', '#a5b4fc', '#f0abfc']
const labelColor = (name: string) => {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
    return LABEL_PALETTE[Math.abs(h) % LABEL_PALETTE.length]
}
const splitLabels = (s: string) => s.split(',').map((l) => l.trim()).filter(Boolean)

// ---- derived ----

const live = (cards: ProjectCard[]) => cards.filter((c) => !c.dismissed)
const flatLive = (p: Project) => live(p.cards)
const doneCount = (cards: ProjectCard[]) => cards.filter((c) => c.done).length
const msOrder = (p: Project) => [...p.milestones].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
const trackList = (p: Project) => [...new Set(p.milestones.map((m) => m.track))].sort((a, b) => a - b)
const inTrack = (p: Project, t: number) => msOrder(p).filter((m) => m.track === t)
const cardsOf = (p: Project, msId: string) =>
    live(p.cards)
        .filter((c) => c.milestone_id === msId)
        .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
const allCardsOf = (p: Project, msId: string) => p.cards.filter((c) => c.milestone_id === msId)

const startOfToday = () => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
}
const dueMs = (iso?: string) => (iso ? new Date(iso).setHours(0, 0, 0, 0) : Infinity)
// Documents are edited rather than scheduled, so their stamps carry the time of
// day: "Mar 4" twice in a row says nothing about which draft is the later one.
const fmtWhen = (iso: string) =>
    new Intl.DateTimeFormat(navigator.language, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
const isoToDateInput = (iso?: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const dateInputToIso = (s: string) => (s ? new Date(`${s}T00:00:00`).toISOString() : '')
const cardOverdue = (c: ProjectCard) => !!c.due_at && !c.done && dueMs(c.due_at) < startOfToday()

const msComplete = (p: Project, m: ProjectMilestone) => {
    const cards = cardsOf(p, m.id)
    return cards.length > 0 && doneCount(cards) === cards.length
}
const msOverdue = (p: Project, m: ProjectMilestone) => !!m.due_at && dueMs(m.due_at) < startOfToday() && !msComplete(p, m)
const nextMilestone = (p: Project) => msOrder(p).find((m) => !msComplete(p, m))

const health = (p: Project): { word: string; icon: string; danger: boolean } => {
    const cards = flatLive(p)
    if (cards.length > 0 && doneCount(cards) === cards.length) return { word: 'Complete', icon: 'flag', danger: false }
    if (p.milestones.some((m) => msOverdue(p, m))) return { word: 'Overdue', icon: 'warning', danger: true }
    if (p.milestones.length === 0) return { word: 'Unplanned', icon: 'explore', danger: false }
    return { word: 'On track', icon: 'route', danger: false }
}

// Jira-style card keys: the project's initials plus a stable per-project
// number derived from creation order.
const keyOf = (p: Project) =>
    p.title
        .split(/[\s(]+/)
        .filter((w) => w && /[a-zA-Z0-9]/.test(w[0]))
        .map((w) => w[0].toUpperCase())
        .slice(0, 3)
        .join('') || 'P'
const cardNum = (p: Project, id: string) => {
    const ordered = [...p.cards].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    return ordered.findIndex((c) => c.id === id) + 1
}

// Cards finished per day over the last 14 days, from completed_at.
const momentum = (p: Project) => {
    const days = Array(14).fill(0)
    const today = startOfToday()
    for (const c of flatLive(p)) {
        if (!c.completed_at) continue
        const d = new Date(c.completed_at)
        d.setHours(0, 0, 0, 0)
        const ago = Math.round((today - d.getTime()) / 86400000)
        if (ago >= 0 && ago < 14) days[13 - ago]++
    }
    return days
}

// What a board card shows of its note, per prefs.projectCardNoteHint: the
// flattened excerpt, or nothing when the reader asked for the plain label.
// Two lines' worth; the card is a summary, and the modal holds the body.
const cardNote = (card: ProjectCard) => (prefs().projectCardNoteHint === 'preview' ? excerpt(card.body, 120) : '')

// The first meaningful non-heading line of the overview, stripped of markup.
const snippetOf = (p: Project) => {
    const line = p.overview
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && !l.startsWith('::') && !l.startsWith('- ') && !l.startsWith('!'))
    return line ? line.replace(/\*\*|\*|`/g, '').replace(/\[\[([^\]]+)\]\]/g, '$1') : ''
}

// ---- shared bits ----

// One segment per milestone, each filling with that milestone's completion.
const SpineMeter: Component<{ p: Project; color?: string }> = (props) => (
    <div class="flex h-2 w-full gap-0.5">
        <For each={msOrder(props.p)}>
            {(m) => {
                const cards = () => cardsOf(props.p, m.id)
                return (
                    <div class="bg-element-accent h-full flex-1 overflow-hidden rounded-sm" title={`${m.title}: ${doneCount(cards())}/${cards().length}`}>
                        <div
                            class="bg-highlight-strongest h-full transition-all"
                            style={{ width: `${cards().length === 0 ? 0 : Math.round((doneCount(cards()) / cards().length) * 100)}%`, 'background-color': props.color }}
                        />
                    </div>
                )
            }}
        </For>
        <Show when={props.p.milestones.length === 0}>
            <div class="bg-element-accent h-full flex-1 rounded-sm" />
        </Show>
    </div>
)

const HealthWord: Component<{ p: Project }> = (props) => (
    <span
        class="flex items-center gap-1 text-xs font-medium"
        classList={{ 'text-danger': health(props.p).danger, 'text-sub': !health(props.p).danger }}
    >
        <span class="material-symbols-outlined text-[13px]">{health(props.p).icon}</span>
        {health(props.p).word}
    </span>
)

const MomentumBars: Component<{ days: number[]; height?: number; barClass?: string; color?: string }> = (props) => {
    const days = () => props.days
    const max = () => Math.max(1, ...days())
    return (
        <div class="border-element-accent flex items-end gap-1 border-b pb-px" style={{ height: `${props.height || 28}px` }} title="Cards finished per day, last 14 days">
            <For each={days()}>
                {(n, i) => (
                    <div
                        title={`${n} finished · ${13 - i() === 0 ? 'today' : `${13 - i()}d ago`}`}
                        class={`rounded-t-sm transition-[filter] hover:brightness-150 ${props.barClass || 'w-2'} ${n > 0 ? 'bg-highlight-strongest' : 'bg-element-accent'}`}
                        style={{ height: n === 0 ? '2px' : `${Math.round((n / max()) * 100)}%`, 'background-color': n > 0 ? props.color : undefined }}
                    />
                )}
            </For>
        </div>
    )
}

// Quick-add: Enter adds and stays focused; a multi-line paste becomes one card
// per line in a single request. This input is the whole capture story.
const QuickAdd: Component<{ placeholder: string; onAdd: (titles: string[]) => void }> = (props) => {
    const [text, setText] = createSignal('')
    return (
        <input
            type="text"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' && text().trim()) {
                    props.onAdd([text()])
                    setText('')
                }
            }}
            onPaste={(e) => {
                const pasted = e.clipboardData?.getData('text') || ''
                if (pasted.includes('\n')) {
                    e.preventDefault()
                    props.onAdd(pasted.split('\n'))
                    setText('')
                }
            }}
            placeholder={props.placeholder}
            class="bg-element-matte text-main border-element-accent focus:border-highlight placeholder:text-sub/50 w-full min-w-0 rounded-md border px-2 py-1.5 text-sm focus:outline-none"
        />
    )
}

const LabelChip: Component<{ name: string; dim?: boolean }> = (props) => (
    <span
        class="rounded px-1.5 text-[10px] font-medium"
        classList={{ 'opacity-60': props.dim }}
        style={{ color: labelColor(props.name), border: `1px solid ${labelColor(props.name)}44`, 'background-color': props.dim ? 'transparent' : `${labelColor(props.name)}14` }}
    >
        {props.name}
    </span>
)

// ---- module root ----

export const ProjectsModule: Component<ProjectsModuleProps> = (props) => {
    const ui = useUI()
    const [projects, setProjects] = createStore<Project[]>([])
    const [loading, setLoading] = createSignal(true)
    const [loadError, setLoadError] = createSignal(false)
    const [openId, setOpenId] = createSignal<string | null>(null)
    // Which tab the project should land on. A deadline on the overview's
    // agenda is a card or a milestone, and the board is where those live, so
    // the row opens the board rather than the project's own overview. Cleared
    // by every other way in, which lands on the overview as before.
    const [openTab, setOpenTab] = createSignal<HubTab | undefined>()
    const openProjectAt = (id: string, tab?: HubTab) => {
        setOpenTab(tab)
        setOpenId(id)
    }
    const [pview, setPview] = createSignal<PortfolioView>('overview')
    // A card opened from the portfolio agenda. The board's copy of this modal
    // lives in the Hub, one project deep, which is exactly where the overview
    // cannot reach: from here a row is a card in whichever project owns it.
    const [openCardId, setOpenCardId] = createSignal<string | null>(null)
    // Which document a ::doc:id:: embed asked for, and whose project it is in.
    // Held here rather than in the Hub because a document embed can point at a
    // document in a project that is not the open one.
    const [docRequest, setDocRequest] = createSignal<{ id: string; projectId: string } | null>(null)
    const openDoc = (id: string, projectId: string) => {
        setDocRequest({ id, projectId })
        openProjectAt(projectId)
    }
    // An effect, not a mount-time read: a project embed clicked while the
    // module is already open (from the focused reader above it) retargets it.
    createEffect(() => {
        if (props.initialProjectId) openProjectAt(props.initialProjectId, props.initialProjectTab)
    })
    createEffect(() => {
        if (props.initialDocumentId && props.initialProjectId) {
            setDocRequest({ id: props.initialDocumentId, projectId: props.initialProjectId })
        }
    })
    const load = async () => {
        setLoading(true)
        setLoadError(false)
        try {
            const data = await api.listProjects()
            setProjects(
                reconcile(
                    (data ?? []).map((p) => ({ ...p, milestones: p.milestones ?? [], cards: p.cards ?? [], documents: p.documents ?? [] })),
                ),
            )
        } catch (err) {
            console.error('Failed to load projects:', err)
            setLoadError(true)
            ui.toast('Could not load projects.', 'error')
        } finally {
            setLoading(false)
        }
    }
    onMount(load)

    const windowed = () => prefs().projectsWindowed

    const openProject = () => projects.find((p) => p.id === openId()) || null
    const mutate = (id: string, fn: (p: Project) => void) => setProjects((p) => p.id === id, produce(fn))

    // Optimistic project field patch; refetch on failure so the truth wins.
    const patchProject = (id: string, optimistic: (p: Project) => void, body: Parameters<typeof api.updateProject>[1]) => {
        mutate(id, optimistic)
        api.updateProject(id, body).catch((err) => {
            console.error('Failed to update project:', err)
            ui.toast('Could not update the project.', 'error')
            void load()
        })
    }

    // A date moved on the overview's timeline. Optimistic like every other
    // field patch here, and noon rather than midnight so the day it lands on
    // is the day it was dropped on wherever it is read. null takes the date
    // off, which is what dropping into the unscheduled tray means.
    const scheduleWork = (item: PlannerRow, at: number | null) => {
        const iso = at === null ? '' : isoAtNoon(at)
        mutate(item.homeId, (p) => {
            if (item.kind === 'card') {
                const card = p.cards.find((c) => c.id === item.id)
                if (card) card.due_at = iso || undefined
            } else {
                const milestone = p.milestones.find((m) => m.id === item.id)
                if (milestone) milestone.due_at = iso || undefined
            }
        })
        const saved =
            item.kind === 'card' ? api.updateProjectCard(item.id, { due_at: iso }) : api.updateProjectMilestone(item.id, { due_at: iso })
        saved.catch((err) => {
            console.error('Failed to change a due date:', err)
            ui.toast('Could not change that due date.', 'error')
            void load()
        })
    }

    // Found by walking the store rather than held beside the id, so the modal
    // redraws when the card it is showing changes underneath it.
    const openCard = createMemo(() => {
        const id = openCardId()
        if (!id) return null
        for (const project of projects) {
            const card = project.cards.find((c) => c.id === id)
            if (card) return { card, project }
        }
        return null
    })
    const patchOverviewCard = (id: string, optimistic: (c: ProjectCard) => void, body: Parameters<typeof api.updateProjectCard>[1]) => {
        const projectId = openCard()?.project.id
        if (!projectId) return
        mutate(projectId, (p) => {
            const card = p.cards.find((c) => c.id === id)
            if (card) optimistic(card)
        })
        api.updateProjectCard(id, body).catch((err) => {
            console.error('Failed to update card:', err)
            ui.toast('Could not update the card.', 'error')
            void load()
        })
    }

    // Ticked off from the agenda. Only a card can be: a milestone is finished
    // by the cards inside it. The server stamps completed_at, which the
    // momentum graph and Recently finished both read, so the response is
    // merged back rather than assumed.
    const completeWork = (item: PlannerRow) => {
        const withCard = (fn: (c: ProjectCard) => void) =>
            mutate(item.homeId, (p) => {
                const card = p.cards.find((c) => c.id === item.id)
                if (card) fn(card)
            })
        withCard((c) => (c.done = true))
        api.updateProjectCard(item.id, { done: true })
            .then((updated) => withCard((c) => Object.assign(c, updated)))
            .catch((err) => {
                console.error('Failed to finish card:', err)
                ui.toast('Could not mark that done.', 'error')
                void load()
            })
        ui.toast(`Marked "${item.title}" done.`, 'success')
    }

    const newProject = async () => {
        try {
            const created = await api.createProject('New project')
            setProjects(
                produce((arr) =>
                    arr.push({ ...created, milestones: created.milestones ?? [], cards: created.cards ?? [], documents: created.documents ?? [] }),
                ),
            )
            openProjectAt(created.id)
        } catch (err) {
            console.error('Failed to create project:', err)
            ui.toast('Could not create a project.', 'error')
        }
    }

    const deleteProjectForever = async (p: Project) => {
        const ok = await ui.confirm({
            title: 'Delete project?',
            message: `"${p.title}" and everything in it will be permanently removed.`,
            confirmLabel: 'Delete',
            danger: true,
        })
        if (!ok) return
        try {
            await api.deleteProject(p.id)
            setProjects(produce((arr) => {
                const i = arr.findIndex((x) => x.id === p.id)
                if (i >= 0) arr.splice(i, 1)
            }))
            if (openId() === p.id) setOpenId(null)
            ui.toast('Project deleted.', 'success')
        } catch (err) {
            console.error('Failed to delete project:', err)
            ui.toast('Could not delete the project.', 'error')
        }
    }

    return (
        <Modal
            onClose={props.onClose}
            layer="panel"
            scrim={windowed() ? 'strong' : 'none'}
            align={windowed() ? 'center' : 'free'}
            dismissable={windowed()}
            classList={{
                'p-6': windowed(),
                // Clears the frameless header and the native window controls,
                // which the panel would otherwise float into.
                'pt-14': windowed() && !!desktop(),
            }}
        >
            <div
                data-testid="projects-panel"
                // relative: BookcaseDrift is an absolutely positioned -z-10
                // layer, so without a positioned host it resolves against the
                // Modal's fixed overlay instead, escapes overflow-hidden, and
                // paints the shelf texture over the whole viewport above the
                // scrim. That reads as every panel behind going transparent.
                class="animate-fade-in text-main relative isolate flex h-full w-full flex-col overflow-hidden"
                classList={{ 'border-element-accent max-h-[90vh] max-w-[90vw] rounded-xl border shadow-2xl': windowed() }}
                style={{ 'background-color': 'var(--theme-bg)' }}
                // Solid surfaces while the texture is on; see index.css.
                data-solid-surfaces={prefs().bookcaseProjects ? '' : undefined}
            >
            {/* The login page's drifting bookcase, quieter: a working surface
                wants texture, not a statement. Toggleable per surface in
                Settings (Appearance, Backgrounds). */}
            <Show when={prefs().bookcaseProjects}>
                <BookcaseDrift class="opacity-[0.04]" />
            </Show>
            {/* Desktop shell, filling the screen: the frameless app header
                underneath stays a window drag region even under this overlay
                (Electron computes drag regions document-wide, ignoring
                stacking), and the native window controls overlay the top-right
                36px. This strip keeps the module's own bars below both, and
                doubles as the drag handle while the module is open. Windowed
                mode is inset past both already. */}
            <Show when={desktop() && !windowed()}>
                <div class="app-drag-region bg-element h-12 w-full shrink-0" />
            </Show>
            {/* keyed: switching projects (opening one from an embedded project
                card, say) remounts the Hub, so editor state, tab and pending
                saves never leak across projects. */}
            <Show
                when={openProject()}
                keyed
                fallback={
                    <Portfolio
                        projects={projects}
                        loading={loading()}
                        loadError={loadError()}
                        view={pview()}
                        setView={setPview}
                        canManage={props.canManage}
                        onRetry={load}
                        onSchedule={scheduleWork}
                        onOpen={openProjectAt}
                        onOpenCard={setOpenCardId}
                        onComplete={completeWork}
                        onNew={newProject}
                        onRestore={(id) => patchProject(id, (p) => (p.archived = false), { archived: false })}
                        onDeleteForever={(id) => {
                            const p = projects.find((x) => x.id === id)
                            if (p) void deleteProjectForever(p)
                        }}
                        onClose={props.onClose}
                    />
                }
            >
                {(p) => (
                    <Hub
                        project={p}
                        canManage={props.canManage}
                        initialTab={openTab()}
                        initialDocumentId={docRequest()?.projectId === p.id ? docRequest()!.id : undefined}
                        onBack={() => setOpenId(null)}
                        onClose={props.onClose}
                        onArchive={() => {
                            patchProject(p.id, (x) => (x.archived = true), { archived: true })
                            setOpenId(null)
                            ui.toast('Project archived.', 'success')
                        }}
                        mutate={(fn) => mutate(p.id, fn)}
                        patchProject={(optimistic, body) => patchProject(p.id, optimistic, body)}
                        reload={load}
                        onOpenMoment={props.onOpenMoment}
                        onOpenTodo={props.onOpenTodo}
                        onOpenCanvas={props.onOpenCanvas}
                        onOpenProject={openProjectAt}
                        onOpenDoc={openDoc}
                    />
                )}
            </Show>

            {/* The portfolio's card modal. The same component the board opens,
                so a card is the same card wherever it was clicked; the undo
                stack is not out here, so dismissing says where the card went
                instead of offering to take it back. */}
            <Show when={openCard()}>
                {(found) => (
                    <CardModal
                        card={found().card}
                        project={found().project}
                        canManage={props.canManage}
                        patch={(optimistic, body) => patchOverviewCard(found().card.id, optimistic, body)}
                        onDismiss={() => {
                            const title = found().card.title
                            patchOverviewCard(found().card.id, (c) => (c.dismissed = true), { dismissed: true })
                            setOpenCardId(null)
                            ui.toast(`Dismissed "${title}". It is in the project's graveyard.`, 'success')
                        }}
                        onClose={() => setOpenCardId(null)}
                        onOpenMoment={props.onOpenMoment}
                        onOpenTodo={props.onOpenTodo}
                        onOpenCanvas={props.onOpenCanvas}
                        onOpenProject={openProjectAt}
                        onOpenDoc={openDoc}
                    />
                )}
            </Show>
            </div>
        </Modal>
    )
}

// ---- portfolio ----

// The overview leads: the question you open the module with is what is due and
// where everything stands, and the grid answers it one project at a time.
// "Catalog" for that grid, because a tab labelled "Projects" inside the
// Projects module named the module rather than the view.
const PORTFOLIO_TABS = [
    { key: 'overview', label: 'Overview', icon: 'insights' },
    { key: 'active', label: 'Catalog', icon: 'space_dashboard' },
    { key: 'archived', label: 'Archived', icon: 'inventory_2' },
] as const
type PortfolioView = (typeof PORTFOLIO_TABS)[number]['key']

const Portfolio: Component<{
    projects: Project[]
    loading: boolean
    loadError: boolean
    view: PortfolioView
    setView: (v: PortfolioView) => void
    canManage: boolean
    onRetry: () => void
    onSchedule: (item: PlannerRow, at: number | null) => void
    onOpen: (id: string, tab?: HubTab) => void
    onOpenCard: (id: string) => void
    onComplete: (item: PlannerRow) => void
    onNew: () => void
    onRestore: (id: string) => void
    onDeleteForever: (id: string) => void
    onClose: () => void
}> = (props) => {
    const shown = () => props.projects.filter((p) => (props.view === 'archived' ? p.archived : !p.archived))
    return (
        <div class="relative z-10 flex min-h-0 flex-1 flex-col">
            <div class="bg-element border-element-accent flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3 sm:px-5">
                {/* Leftmost control is always "up one level": here that is out
                    of the module, the way it is back to the portfolio in a
                    project's hub. */}
                <button onClick={props.onClose} class="text-sub hover:text-main transition-colors hover:cursor-pointer" title="Back to the library">
                    <span class="material-symbols-outlined">arrow_back</span>
                </button>
                <span class="material-symbols-outlined text-highlight text-xl">space_dashboard</span>
                <h1 class="text-main font-serif text-2xl font-semibold">Projects</h1>
                <div class="border-element-accent flex max-w-full overflow-x-auto rounded-md border sm:ml-4">
                    <For each={PORTFOLIO_TABS}>
                        {(t) => (
                            <button
                                onClick={() => props.setView(t.key)}
                                class="flex shrink-0 items-center gap-1 px-2.5 py-1.5 text-xs transition-colors hover:cursor-pointer"
                                classList={{ 'bg-highlight-strongest text-white': props.view === t.key, 'text-sub hover:text-main': props.view !== t.key }}
                                title={`${t.label} view`}
                            >
                                <span class="material-symbols-outlined text-sm">{t.icon}</span>
                                {t.label}
                                <Show when={t.key !== 'overview'}>
                                    <span class="opacity-60">{props.projects.filter((p) => (t.key === 'archived' ? p.archived : !p.archived)).length}</span>
                                </Show>
                            </button>
                        )}
                    </For>
                </div>
            </div>

            <Show when={!props.loading} fallback={<div class="flex flex-1 items-center justify-center"><p class="text-sub text-sm">Loading…</p></div>}>
                <Show
                    when={!props.loadError}
                    fallback={
                        <div class="flex flex-1 flex-col items-center justify-center gap-3">
                            <span class="material-symbols-outlined text-danger text-3xl">error</span>
                            <p class="text-sub text-sm">Could not load your projects.</p>
                            <button
                                onClick={props.onRetry}
                                class="border-element-accent text-sub hover:text-main flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs transition-colors hover:cursor-pointer"
                            >
                                <span class="material-symbols-outlined text-sm">refresh</span>
                                Retry
                            </button>
                        </div>
                    }
                >
                    <Show
                        when={props.view !== 'overview'}
                        fallback={
                            <Overview
                                projects={props.projects}
                                canManage={props.canManage}
                                onSchedule={props.onSchedule}
                                onOpen={props.onOpen}
                                onOpenCard={props.onOpenCard}
                                onComplete={props.onComplete}
                            />
                        }
                    >
                    <div class="animate-fade-in min-h-0 flex-1 overflow-y-auto p-5">
                        <Show
                            when={shown().length > 0 || (props.view === 'active' && props.canManage)}
                            fallback={
                                <div class="bg-element border-element-accent flex flex-col items-center gap-2 rounded-lg border border-dashed py-20">
                                    <span class="material-symbols-outlined text-sub/40 text-4xl">{props.view === 'archived' ? 'inventory_2' : 'space_dashboard'}</span>
                                    <p class="text-sub/60 text-sm italic">
                                        {props.view === 'archived' ? 'Nothing archived. Finished projects land here.' : 'No projects yet.'}
                                    </p>
                                </div>
                            }
                        >
                            <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
                                <For each={shown()}>
                                    {(p) => (
                                        <button
                                            onClick={() => props.onOpen(p.id)}
                                            class="bg-element border-element-accent hover:border-highlight/60 flex flex-col gap-3 rounded-lg border p-5 text-left transition-all duration-150 hover:-translate-y-0.5 hover:cursor-pointer hover:shadow-xl"
                                            style={{ 'border-top': `3px solid ${p.accent}` }}
                                        >
                                            <div class="flex items-start justify-between gap-3">
                                                <div class="min-w-0">
                                                    <div class="flex items-center gap-2">
                                                        <span class="material-symbols-outlined text-base" style={{ color: p.accent }}>{p.icon}</span>
                                                        <span class="font-mono text-[10px] font-bold" style={{ color: p.accent }}>{keyOf(p)}</span>
                                                        <HealthWord p={p} />
                                                    </div>
                                                    <h2 class="text-main font-serif mt-1 truncate text-xl font-semibold">{p.title}</h2>
                                                </div>
                                                <div class="shrink-0 text-right">
                                                    <p class="font-mono text-lg font-bold" style={{ color: p.accent }}>
                                                        {flatLive(p).length === 0 ? 0 : Math.round((doneCount(flatLive(p)) / flatLive(p).length) * 100)}%
                                                    </p>
                                                    <p class="text-sub text-[11px]">complete</p>
                                                </div>
                                            </div>
                                            <Show when={snippetOf(p)}>
                                                <p class="text-sub text-sm">{snippetOf(p)}</p>
                                            </Show>
                                            <SpineMeter p={p} color={p.accent} />
                                            <div class="flex items-end justify-between gap-4">
                                                <div class="min-w-0">
                                                    <p class="text-sub/70 text-xs font-medium">Milestones</p>
                                                    <For each={msOrder(p).slice(0, 3)}>
                                                        {(m, i) => (
                                                            <p class="text-sub truncate text-xs" classList={{ 'text-main': nextMilestone(p)?.id === m.id }}>
                                                                {i() + 1}. {m.title} · {doneCount(cardsOf(p, m.id))}/{cardsOf(p, m.id).length}
                                                            </p>
                                                        )}
                                                    </For>
                                                    <Show when={p.milestones.length > 3}>
                                                        <p class="text-sub/50 text-xs">+{p.milestones.length - 3} more</p>
                                                    </Show>
                                                    <Show when={p.milestones.length === 0}>
                                                        <p class="text-sub/50 text-xs italic">None yet.</p>
                                                    </Show>
                                                </div>
                                                <div class="shrink-0">
                                                    <p class="text-sub/70 mb-1 text-right text-xs font-medium">Momentum · 14d</p>
                                                    <MomentumBars days={momentum(p)} height={32} color={p.accent} />
                                                </div>
                                            </div>
                                            <div class="border-element-accent/60 text-sub flex items-center gap-4 border-t pt-2.5 text-xs">
                                                <span>
                                                    <span class="text-main font-mono font-bold">{flatLive(p).filter((c) => !c.done).length}</span> open
                                                </span>
                                                <span>
                                                    <span class="text-main font-mono font-bold">{doneCount(flatLive(p))}</span> done
                                                </span>
                                                <span>
                                                    <span class="font-mono font-bold" style={{ color: priorityColor(3) }}>
                                                        {flatLive(p).filter((c) => !c.done && c.priority === 3).length}
                                                    </span>{' '}
                                                    high
                                                </span>
                                                <span>
                                                    <span class="text-main font-mono font-bold">{p.cards.filter((c) => c.dismissed).length}</span> dismissed
                                                </span>
                                                <Show when={props.view === 'archived' && props.canManage}>
                                                    <span
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            props.onRestore(p.id)
                                                        }}
                                                        class="text-highlight ml-auto font-bold hover:cursor-pointer hover:brightness-125"
                                                    >
                                                        Restore
                                                    </span>
                                                    <span
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            props.onDeleteForever(p.id)
                                                        }}
                                                        class="text-danger/70 hover:text-danger font-bold hover:cursor-pointer"
                                                    >
                                                        Delete forever
                                                    </span>
                                                </Show>
                                            </div>
                                        </button>
                                    )}
                                </For>
                                {/* Ghost card: New project lives in the grid it
                                    adds to, drawn as the outline of the cover it
                                    will become. */}
                                <Show when={props.view === 'active' && props.canManage}>
                                    <button
                                        onClick={props.onNew}
                                        class="bg-element border-element-accent hover:border-highlight text-sub hover:text-main flex min-h-56 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors hover:cursor-pointer"
                                    >
                                        <span class="material-symbols-outlined text-3xl">add</span>
                                        <span class="text-sm font-bold">New project</span>
                                        <span class="text-sub/60 text-xs">Start a long-running effort</span>
                                    </button>
                                </Show>
                            </div>
                        </Show>
                    </div>
                    </Show>
                </Show>
            </Show>
        </div>
    )
}

// ---- overview ----
// Every live project at once: what is due across all of them, how much is
// moving, and which ones have stopped. The Catalog answers "how is this
// project doing" one card at a time; nothing answered "what is due first" until
// this, which is the question you have when you own more than two projects.
//
// Deadlines come from the same projectAgenda module the Tasks agenda reads, so
// both screens agree on what counts as due.

// A panel on the overview, cut to the same pattern as a project's own:
// a serif heading, an optional note to its right, and the content under it.
// Boxed rows inside a boxed card inside a boxed tile read as clutter, so the
// box stops here and the rows below are plain until they are hovered.
// A panel on the overview, cut to the same pattern as a project's own:
// a serif heading, an optional note to its right, and the content under it.
// Boxed rows inside a boxed card inside a boxed tile read as clutter, so the
// box stops here and the rows below are plain until they are hovered.
const OverviewCard: Component<{
    title: string
    note?: JSX.Element
    actions?: JSX.Element
    pad?: string
    class?: string
    // The content, separated from the heading so a card can hand its own
    // scrolling to the part under the title rather than to the screen.
    body?: string
    bodyRef?: (el: HTMLDivElement) => void
    bodyProps?: JSX.HTMLAttributes<HTMLDivElement>
    children: JSX.Element
}> = (props) => (
    <div class={`bg-element border-element-accent/60 min-w-0 rounded-lg border ${props.pad ?? 'p-4'} ${props.class ?? ''}`}>
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
            <h3 class="text-main font-serif text-xl font-semibold">{props.title}</h3>
            <div class="flex items-center gap-3">
                <Show when={props.note}>{props.note}</Show>
                <Show when={props.actions}>{props.actions}</Show>
            </div>
        </div>
        <div ref={props.bodyRef} {...(props.bodyProps ?? {})} class={props.body ?? ''}>
            {props.children}
        </div>
    </div>
)

// One segment per live project, filling with that project's completion: the
// portfolio's echo of the spine a project draws across its own milestones.
const PortfolioSpine: Component<{ projects: Project[] }> = (props) => (
    <div class="flex h-2 w-full gap-0.5">
        <For each={props.projects}>
            {(p) => {
                const cards = () => flatLive(p)
                return (
                    <div class="bg-element-accent h-full flex-1 overflow-hidden rounded-sm" title={`${p.title}: ${doneCount(cards())}/${cards().length}`}>
                        <div
                            class="h-full transition-all"
                            style={{
                                width: `${cards().length === 0 ? 0 : Math.round((doneCount(cards()) / cards().length) * 100)}%`,
                                'background-color': p.accent,
                            }}
                        />
                    </div>
                )
            }}
        </For>
    </div>
)

// ---- the agenda ----

// Dragging a deadline is how a date is changed from here: the timeline is a
// picture of the fortnight, and moving something to Thursday is the whole
// gesture. This carries the drag across the timeline's parts, which are
// separate components but one drop surface.
//
// Same mechanism as the board's card drag (HTML5, not pointer events), so a
// touch screen cannot do it. The card's own date field still can, which is
// why nothing here is the only way to set a date.
const Overview: Component<{
    projects: Project[]
    canManage: boolean
    onSchedule: (item: PlannerRow, at: number | null) => void
    onOpen: (id: string, tab?: HubTab) => void
    onOpenCard: (id: string) => void
    onComplete: (item: PlannerRow) => void
}> = (props) => {
    const liveProjects = createMemo(() => props.projects.filter((p) => !p.archived))
    const deadlines = createMemo(() => projectDeadlines(props.projects))
    const unscheduledSort = () => prefs().projectsUnscheduledSort
    // Every live project's work as planner rows, which is what the shared
    // surface draws. The panels below still read projectDeadlines, because
    // they ask project questions rather than calendar ones.
    const work = createMemo(() => plannerFromProjects(props.projects))
    const dated = createMemo(() => datedRows(work()))
    const unscheduled = createMemo(() => undatedRows(work(), unscheduledSort()))
    const drag = createPlannerDrag({ enabled: () => props.canManage, schedule: (item, at) => props.onSchedule(item, at) })
    // A card opens the card. A milestone opens the board: a milestone is a
    // column, and a column has no modal of its own.
    const openRow = (row: PlannerRow) =>
        row.kind === 'card' ? props.onOpenCard(row.id) : props.onOpen(row.homeId, 'board')
    // Undefined rather than a no-op for a reader who cannot write, so the row
    // draws no control it would have to refuse.
    const completeRow = () => (props.canManage ? props.onComplete : undefined)
    const handlers = (): PlannerHandlers => ({
        drag,
        onOpen: openRow,
        onComplete: completeRow(),
        openTitle: (row) => (row.kind === 'card' ? 'Open the card' : `Open ${row.homeTitle} on the board`),
    })
    const overdue = createMemo(() => deadlines().filter((d) => dueMs(d.dueAt) < startOfToday()))
    const dueThisWeek = createMemo(() => {
        const weekEnd = startOfToday() + 7 * 86400000
        return deadlines().filter((d) => dueMs(d.dueAt) >= startOfToday() && dueMs(d.dueAt) <= weekEnd)
    })
    const openCards = createMemo(() => liveProjects().flatMap((p) => flatLive(p).filter((c) => !c.done)))
    const doneCards = createMemo(() => liveProjects().flatMap((p) => flatLive(p).filter((c) => c.done)))
    const completion = createMemo(() => {
        const total = openCards().length + doneCards().length
        return total === 0 ? 0 : Math.round((doneCards().length / total) * 100)
    })
    // The fourteen-day momentum of every project summed into one series, so a
    // quiet fortnight across the whole portfolio is visible as one shape.
    const allMomentum = createMemo(() => {
        const days = Array(14).fill(0) as number[]
        for (const p of liveProjects()) momentum(p).forEach((n, i) => (days[i] += n))
        return days
    })
    // Stalled: work outstanding, nothing finished in the fourteen days the
    // momentum graph covers. Overdue is louder, so it is said first.
    const attention = createMemo(() =>
        liveProjects()
            .filter((p) => health(p).danger || (flatLive(p).some((c) => !c.done) && momentum(p).every((n) => n === 0)))
            .map((p) => ({ project: p, reason: health(p).danger ? 'Overdue milestone' : 'No cards finished in 14 days' })),
    )
    const recentlyFinished = createMemo(() =>
        liveProjects()
            .flatMap((p) => flatLive(p).filter((c) => c.done && c.completed_at).map((c) => ({ card: c, project: p })))
            .sort((a, b) => (b.card.completed_at ?? '').localeCompare(a.card.completed_at ?? ''))
            .slice(0, 12),
    )
    // Every live project on one line, in the order they will come due. A
    // project with nothing dated sorts last rather than first: it is not
    // urgent, it is unplanned.
    const glance = createMemo(() =>
        liveProjects()
            .map((p) => {
                const cards = flatLive(p)
                const nextDue = cards
                    .filter((c) => !c.done && c.due_at)
                    .sort((a, b) => dueMs(a.due_at) - dueMs(b.due_at))[0]?.due_at
                return { project: p, done: doneCount(cards), total: cards.length, nextDue }
            })
            .sort((a, b) => dueMs(a.nextDue) - dueMs(b.nextDue) || a.project.title.localeCompare(b.project.title)),
    )
    // Highest first: the question a priority breakdown answers is how much of
    // the pile is urgent, and that reads better from the top down.
    const priorityCounts = createMemo(() =>
        [...PRIORITIES].reverse().map((pr) => ({ ...pr, count: openCards().filter((c) => c.priority === pr.v).length })),
    )
    const labelCounts = createMemo(() => {
        const counts = new Map<string, number>()
        for (const card of openCards()) for (const label of splitLabels(card.labels)) counts.set(label, (counts.get(label) ?? 0) + 1)
        return [...counts.entries()]
            .map(([label, count]) => ({ label, count }))
            .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
            .slice(0, 8)
    })
    // The one milestone each project is working towards, which is a shorter
    // and more useful list than every milestone anyone has ever written down.
    const milestonesAhead = createMemo(() =>
        liveProjects()
            .flatMap((p) => {
                const milestone = nextMilestone(p)
                if (!milestone) return []
                const cards = cardsOf(p, milestone.id)
                return [{ project: p, milestone, done: doneCount(cards), total: cards.length }]
            })
            .sort((a, b) => dueMs(a.milestone.due_at) - dueMs(b.milestone.due_at)),
    )
    const view = () => prefs().projectsAgendaView
    const vertical = () => prefs().projectsAgendaVertical
    // The screen is the scroller, so a drag held near the top or bottom of
    // it walks down the run of days rather than stopping at the fold.
    const pageScroll = edgeAutoScroll('y')

    return (
        // Nothing on this screen scrolls the screen: the masthead and the
        // three panels take what they need and the agenda takes the rest,
        // scrolling inside its own box. Below lg the parts are taller than any
        // window they would fit in, so there the page scrolls as usual.
        <div data-testid="projects-overview" ref={pageScroll.ref}
            onDragOver={pageScroll.onDragOver}
            onDragLeave={pageScroll.stop}
            onDrop={pageScroll.stop}
            onDragEnd={pageScroll.stop}
            class="animate-fade-in min-h-0 flex-1 overflow-y-auto">
            <Show
                when={liveProjects().length > 0}
                fallback={
                    <div class="p-5">
                        <div class="bg-element border-element-accent flex flex-col items-center gap-2 rounded-lg border border-dashed py-20">
                            <span class="material-symbols-outlined text-sub/40 text-4xl">insights</span>
                            <p class="text-sub/60 italic">No live projects yet. Start one in the Catalog.</p>
                        </div>
                    </div>
                }
            >
                {/* Same masthead as a project's overview, one level up: what
                    this is, what it is called, where it stands, and the spine.
                    The counts read as a sentence rather than six tiles, which
                    is what made this screen feel like a dashboard. */}
                <div class="px-4 py-5 sm:px-6 sm:py-6">
                    <div class="flex shrink-0 items-center gap-2">
                        <span class="material-symbols-outlined text-highlight text-xl">insights</span>
                        <span class="text-sub font-mono text-sm font-bold tracking-widest">PORTFOLIO</span>
                        <Show when={overdue().length > 0}>
                            <span class="bg-danger/20 text-danger rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wide">
                                {overdue().length} overdue
                            </span>
                        </Show>
                    </div>
                    <div class="mt-0.5 flex shrink-0 flex-wrap items-end justify-between gap-x-10 gap-y-2">
                        <h2 class="text-main font-serif text-3xl font-bold">Every project</h2>
                        <p class="text-sub pb-1 text-base">
                            <span class="text-main font-mono font-bold">{liveProjects().length}</span> live
                            · <span class="text-main font-mono font-bold">{completion()}%</span> complete
                            · <span class="text-main font-mono font-bold">{openCards().length}</span> open
                            · <span class="text-main font-mono font-bold">{doneCards().length}</span> done
                            · <span class="text-main font-mono font-bold">{dueThisWeek().length}</span> due in 7 days
                            · <span class="text-main font-mono font-bold">{openCards().filter((c) => c.priority === 3).length}</span> high priority
                        </p>
                    </div>
                    <div class="mt-3 shrink-0">
                        <PortfolioSpine projects={liveProjects()} />
                    </div>

                    {/* The agenda takes the full width: a fortnight of days
                        needs every pixel, and the three panels under it read
                        fine side by side. */}
                    <OverviewCard
                        title="Agenda"
                        class="mt-5"
                        pad="p-4 sm:p-5"
                        note={
                            <span class="text-sub text-sm">
                                <span class="text-main font-mono font-bold">{deadlines().length}</span> dated across{' '}
                                <span class="text-main font-mono font-bold">{new Set(deadlines().map((d) => d.projectId)).size}</span>{' '}
                                {new Set(deadlines().map((d) => d.projectId)).size === 1 ? 'project' : 'projects'}
                            </span>
                        }
                        actions={
                            <PlannerViewSwitch
                                view={view()}
                                setView={(v) => setPref('projectsAgendaView', v)}
                                vertical={vertical()}
                                setVertical={(v) => setPref('projectsAgendaVertical', v)}
                            />
                        }
                    >
                        <PlannerBody
                            rows={dated()}
                            view={view()}
                            vertical={vertical()}
                            handlers={handlers()}
                            emptyNote="Nothing dated. Give a card or a milestone a due date to see it here."
                        />
                    </OverviewCard>

                    {/* Its own card under the agenda, not a strip inside it:
                        undated work is a list in its own right, and a drawer
                        squeezed under the days was too shallow to read and
                        too shallow to aim at. */}
                    <Show when={view() !== 'list'}>
                        <PlannerTray
                            rows={unscheduled()}
                            sort={unscheduledSort()}
                            setSort={(sort) => setPref('projectsUnscheduledSort', sort)}
                            homeWord="Project"
                            handlers={handlers()}
                        />
                    </Show>

                    {/* Under the agenda: the standing picture of the
                        portfolio. Six panels rather than three, each large
                        enough that scrolling down to it is worth the trip.
                        items-start, so each is as tall as its own content;
                        stretching panels of different lengths to match the
                        longest only buys a matched pair of empty halves. */}
                    <OverviewCard
                        title="Projects at a glance"
                        class="mt-5"
                        pad="p-4 sm:p-6"
                        note={<span class="text-sub text-sm">soonest deadline first</span>}
                    >
                        <div class="flex flex-col gap-1">
                            <For each={glance()}>
                                {(row) => (
                                    <button
                                        onClick={() => props.onOpen(row.project.id)}
                                        class="hover:bg-element-matte/40 -mx-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-2 py-2.5 text-left transition-colors hover:cursor-pointer"
                                        title={`Open ${row.project.title}`}
                                        style={{ 'border-left': `3px solid ${row.project.accent}` }}
                                    >
                                        <span class="material-symbols-outlined shrink-0 text-[19px]" style={{ color: row.project.accent }}>
                                            {row.project.icon}
                                        </span>
                                        <span class="font-mono text-xs font-bold" style={{ color: row.project.accent }}>{keyOf(row.project)}</span>
                                        <span class="text-main min-w-0 flex-1 truncate text-base">{row.project.title}</span>
                                        <HealthWord p={row.project} />
                                        <span class="text-sub shrink-0 font-mono text-xs">
                                            {row.done}/{row.total}
                                        </span>
                                        <div class="flex w-40 shrink-0 items-center gap-2">
                                            <Meter done={row.done} total={row.total} class="w-28" color={row.project.accent} />
                                        </div>
                                        <span
                                            class="w-20 shrink-0 rounded px-1.5 py-0.5 text-right text-xs font-bold"
                                            classList={{
                                                'bg-danger/20 text-danger': !!row.nextDue && dueMs(row.nextDue) < startOfToday(),
                                                'bg-element-accent text-sub': !!row.nextDue && dueMs(row.nextDue) >= startOfToday(),
                                                'text-sub/40': !row.nextDue,
                                            }}
                                        >
                                            {row.nextDue ? fmtDue(row.nextDue) : 'no date'}
                                        </span>
                                    </button>
                                )}
                            </For>
                        </div>
                    </OverviewCard>

                    {/* Two columns, each packing its own cards, rather
                        than a grid: a grid lays panels out in rows, and a
                        row is only as short as its tallest member, so a
                        short panel beside a long one leaves a hole under
                        itself that the next row cannot rise into. */}
                    <div class="mt-5 flex flex-col gap-5 xl:flex-row xl:items-start">
                        <div class="flex min-w-0 flex-1 flex-col gap-5">
                            <OverviewCard
                                title="Needs attention"
                                pad="p-4 sm:p-6"
                                body="max-h-96 overflow-y-auto"
                                note={<span class="text-sub text-sm">overdue or gone quiet</span>}
                            >
                                <Show when={attention().length > 0} fallback={<p class="text-sub/50 italic">Nothing overdue or stalled. Every project is moving.</p>}>
                                    <div class="flex flex-col gap-1">
                                        <For each={attention()}>
                                            {(row) => (
                                                <button
                                                    onClick={() => props.onOpen(row.project.id)}
                                                    class="hover:bg-element-matte/40 -mx-2 flex items-center gap-2.5 rounded-md px-2 py-2.5 text-left transition-colors hover:cursor-pointer"
                                                    title={`Open ${row.project.title}`}
                                                >
                                                    <span class="material-symbols-outlined shrink-0 text-[19px]" style={{ color: row.project.accent }}>
                                                        {row.project.icon}
                                                    </span>
                                                    <div class="min-w-0 flex-1">
                                                        <p class="text-main truncate text-base">{row.project.title}</p>
                                                        <p class="text-sub/80 truncate text-xs">{row.reason}</p>
                                                    </div>
                                                    <HealthWord p={row.project} />
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </OverviewCard>

                            <OverviewCard title="Momentum" pad="p-4 sm:p-6" note={<span class="text-sub text-sm">cards finished per day · 14d</span>}>
                                <MomentumBars days={allMomentum()} height={168} barClass="min-w-0 flex-1" />
                                <div class="text-sub/60 mt-2 flex justify-between text-xs">
                                    <span>2 weeks ago</span>
                                    <span class="text-main font-mono">
                                        {allMomentum().reduce((a, b) => a + b, 0)} finished · best day {Math.max(0, ...allMomentum())}
                                    </span>
                                    <span>today</span>
                                </div>
                            </OverviewCard>

                            <OverviewCard
                                title="Recently finished"
                                pad="p-4 sm:p-6"
                                body="max-h-96 overflow-y-auto"
                                note={<span class="text-sub text-sm">newest first</span>}
                            >
                                <Show when={recentlyFinished().length > 0} fallback={<p class="text-sub/50 italic">Nothing finished yet.</p>}>
                                    <div class="flex flex-col gap-1">
                                        <For each={recentlyFinished()}>
                                            {(row) => (
                                                <button
                                                    onClick={() => props.onOpenCard(row.card.id)}
                                                    class="hover:bg-element-matte/40 -mx-2 flex items-center gap-2.5 rounded-md px-2 py-2.5 text-left transition-colors hover:cursor-pointer"
                                                    title="Open the card"
                                                >
                                                    <span class="material-symbols-outlined shrink-0 text-[17px]" style={{ color: row.project.accent }}>check_circle</span>
                                                    <div class="min-w-0 flex-1">
                                                        <p class="text-sub truncate text-base line-through">{row.card.title}</p>
                                                        <p class="text-sub/80 truncate text-xs">
                                                            {row.project.title} · {fmtWhen(row.card.completed_at!)}
                                                        </p>
                                                    </div>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </OverviewCard>
                        </div>
                        <div class="flex min-w-0 flex-1 flex-col gap-5">
                            <OverviewCard
                                title="Milestones ahead"
                                pad="p-4 sm:p-6"
                                body="max-h-96 overflow-y-auto"
                                note={<span class="text-sub text-sm">the next one in each project</span>}
                            >
                                <Show when={milestonesAhead().length > 0} fallback={<p class="text-sub/50 italic">No milestones yet. Projects grow them on the board.</p>}>
                                    <div class="flex flex-col gap-1">
                                        <For each={milestonesAhead()}>
                                            {(row) => (
                                                <button
                                                    onClick={() => props.onOpen(row.project.id, 'board')}
                                                    class="hover:bg-element-matte/40 -mx-2 flex items-center gap-2.5 rounded-md px-2 py-2.5 text-left transition-colors hover:cursor-pointer"
                                                    title={`Open ${row.project.title} on the board`}
                                                >
                                                    <span class="material-symbols-outlined shrink-0 text-[19px]" style={{ color: row.project.accent }}>flag</span>
                                                    <div class="min-w-0 flex-1">
                                                        <p class="text-main truncate text-base">{row.milestone.title}</p>
                                                        <p class="text-sub/80 truncate text-xs">
                                                            {row.project.title} · {row.done}/{row.total} done
                                                        </p>
                                                    </div>
                                                    <Show when={row.milestone.due_at}>
                                                        <span
                                                            class="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold"
                                                            classList={{
                                                                'bg-danger/20 text-danger': dueMs(row.milestone.due_at) < startOfToday(),
                                                                'bg-element-accent text-sub': dueMs(row.milestone.due_at) >= startOfToday(),
                                                            }}
                                                        >
                                                            {fmtDue(row.milestone.due_at!)}
                                                        </span>
                                                    </Show>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </OverviewCard>

                            <OverviewCard title="Open work" pad="p-4 sm:p-6" note={<span class="text-sub text-sm">{openCards().length} cards, by priority</span>}>
                                <div class="flex flex-col gap-2">
                                    <For each={priorityCounts()}>
                                        {(pr) => (
                                            <div class="flex items-center gap-3">
                                                <span class="text-sub w-16 shrink-0 text-sm">{pr.label}</span>
                                                <div class="bg-element-accent h-4 flex-1 overflow-hidden rounded">
                                                    <div
                                                        class="h-full rounded transition-all"
                                                        style={{
                                                            width: `${Math.round((pr.count / Math.max(1, ...priorityCounts().map((x) => x.count))) * 100)}%`,
                                                            'background-color': pr.color || 'var(--theme-element-accent)',
                                                            'min-width': pr.count > 0 ? '4px' : '0',
                                                        }}
                                                    />
                                                </div>
                                                <span class="text-main w-8 shrink-0 text-right font-mono text-sm font-bold">{pr.count}</span>
                                            </div>
                                        )}
                                    </For>
                                </div>
                                <p class="text-sub/60 mt-4 text-xs">
                                    <span class="text-main font-mono">{unscheduled().length}</span> of them carry no date at all.
                                </p>
                            </OverviewCard>

                            <OverviewCard
                                title="Labels"
                                pad="p-4 sm:p-6"
                                body="max-h-96 overflow-y-auto"
                                note={<span class="text-sub text-sm">across the open work</span>}
                            >
                                <Show when={labelCounts().length > 0} fallback={<p class="text-sub/50 italic">No labels yet. Cards grow them on the board.</p>}>
                                    <div class="flex flex-col gap-2">
                                        <For each={labelCounts()}>
                                            {(row) => (
                                                <div class="flex items-center gap-3">
                                                    <span
                                                        class="w-24 shrink-0 truncate rounded px-1.5 py-0.5 text-center text-xs font-medium"
                                                        style={{ color: labelColor(row.label), border: `1px solid ${labelColor(row.label)}44` }}
                                                    >
                                                        {row.label}
                                                    </span>
                                                    <div class="bg-element-accent h-3 flex-1 overflow-hidden rounded">
                                                        <div
                                                            class="h-full rounded transition-all"
                                                            style={{
                                                                width: `${Math.round((row.count / Math.max(1, ...labelCounts().map((x) => x.count))) * 100)}%`,
                                                                'background-color': `${labelColor(row.label)}cc`,
                                                                'min-width': '4px',
                                                            }}
                                                        />
                                                    </div>
                                                    <span class="text-main w-8 shrink-0 text-right font-mono text-sm font-bold">{row.count}</span>
                                                </div>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </OverviewCard>
                        </div>
                    </div>
                </div>
            </Show>
        </div>
    )
}

// ---- hub ----

const HUB_TABS = [
    { key: 'overview', label: 'Overview', icon: 'description' },
    { key: 'board', label: 'Board', icon: 'view_kanban' },
    { key: 'documents', label: 'Documents', icon: 'folder_open' },
    { key: 'graveyard', label: 'Graveyard', icon: 'history' },
] as const
export type HubTab = (typeof HUB_TABS)[number]['key']

const Hub: Component<{
    project: Project
    canManage: boolean
    initialTab?: HubTab
    initialDocumentId?: string
    onBack: () => void
    onClose: () => void
    onArchive: () => void
    mutate: (fn: (p: Project) => void) => void
    patchProject: (optimistic: (p: Project) => void, body: Parameters<typeof api.updateProject>[1]) => void
    reload: () => Promise<void>
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
    onOpenDoc?: (id: string, projectId: string) => void
}> = (props) => {
    const ui = useUI()
    // Read once: the Hub is keyed on the project, so every way in mounts a
    // fresh one and asking for a tab is asking where this visit starts, not
    // where it stays.
    const [tab, setTab] = createSignal<HubTab>(props.initialTab ?? 'overview')
    const [editId, setEditId] = createSignal<string | null>(null)
    const [ovEditing, setOvEditing] = createSignal(false)
    const [showLook, setShowLook] = createSignal(false)
    const [dragCard, setDragCard] = createSignal<string | null>(null)
    const [dragCol, setDragCol] = createSignal<string | null>(null)

    const accent = () => props.project.accent
    const all = () => flatLive(props.project)

    // A stack, not a slot: Ctrl+Z walks back through every dismissal this
    // visit. The graveyard is the permanent record underneath.
    const [undoStack, setUndoStack] = createSignal<{ label: string; apply: () => void }[]>([])
    const [toastVisible, setToastVisible] = createSignal(false)
    let undoTimer: ReturnType<typeof setTimeout> | undefined
    const popUndo = () => {
        const stack = undoStack()
        if (!stack.length) return
        stack[stack.length - 1].apply()
        setUndoStack(stack.slice(0, -1))
        if (!undoStack().length) setToastVisible(false)
    }
    // One entry, one toast window. Every undoable action in the hub goes
    // through here so a dismissed card and a deleted folder queue in the same
    // stack and Ctrl+Z walks back through both.
    const pushUndo = (label: string, apply: () => void) => {
        setUndoStack([...undoStack(), { label, apply }])
        clearTimeout(undoTimer)
        setToastVisible(true)
        undoTimer = setTimeout(() => setToastVisible(false), 6000)
    }
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && undoStack().length) {
                e.preventDefault()
                popUndo()
            }
        }
        window.addEventListener('keydown', onKey)
        onCleanup(() => window.removeEventListener('keydown', onKey))
    })

    // --- the brief ---
    // The editor streams every keystroke; the store takes it immediately (so
    // the preview and portfolio snippet follow along) and the PATCH waits for
    // a pause in the typing. Leaving the editor, or the tab, flushes.
    let ovTimer: ReturnType<typeof setTimeout> | undefined
    let ovDirty = false
    const ovFlush = () => {
        clearTimeout(ovTimer)
        if (!ovDirty) return
        ovDirty = false
        api.updateProject(props.project.id, { overview: props.project.overview }).catch((err) => {
            console.error('Failed to save the brief:', err)
            ui.toast('Could not save the brief.', 'error')
            void props.reload()
        })
    }
    const ovChange = (v: string) => {
        props.mutate((p) => (p.overview = v))
        ovDirty = true
        clearTimeout(ovTimer)
        ovTimer = setTimeout(ovFlush, 800)
    }
    const ovDone = () => {
        ovFlush()
        setOvEditing(false)
    }
    onCleanup(ovFlush)

    // --- documents ---
    // Which folder the grid is showing (null is the tab root) and which
    // document is open on top of it. Both live here rather than in the tab so
    // a ::doc:id:: embed can land on one, and so walking to the board and back
    // returns to where the reader was.
    const [docFolderId, setDocFolderId] = createSignal<string | null>(null)
    const [docOpenId, setDocOpenId] = createSignal<string | null>(null)
    const documents = () => props.project.documents || []

    createEffect(() => {
        const wanted = props.initialDocumentId
        if (!wanted) return
        setTab('documents')
        setDocOpenId(wanted)
        // untracked: the grid should not jump back to the document's folder
        // every time anything in the tree changes.
        setDocFolderId(untrack(() => documents().find((d) => d.id === wanted)?.parent_id ?? null))
    })

    const withDoc = (id: string, fn: (d: ProjectDocument) => void) =>
        props.mutate((p) => {
            const d = p.documents.find((x) => x.id === id)
            if (d) fn(d)
        })

    // A locked document refuses title and body edits server-side. The status
    // control makes that state visible and the editor read-only, so a 409 here
    // means the lock landed from another session: say so and put the stored
    // text back.
    const docError = (err: unknown, fallback: string) => {
        console.error(fallback, err)
        ui.toast(err instanceof APIError && err.status === 409 ? 'That document is locked. Unlock it to edit.' : fallback, 'error')
        void props.reload()
    }

    const patchDoc = (id: string, optimistic: (d: ProjectDocument) => void, body: Parameters<typeof api.updateProjectDocument>[1]) => {
        withDoc(id, optimistic)
        clearProjectDocumentCache()
        api.updateProjectDocument(id, body)
            .then((updated) => withDoc(id, (d) => Object.assign(d, updated)))
            .catch((err) => docError(err, 'Could not update the document.'))
    }

    // Which tile is showing its rename field. One at a time, so the grid never
    // has two open inputs competing for the Enter key.
    const [docRenameId, setDocRenameId] = createSignal<string | null>(null)

    const newDocumentRow = async (kind: 'folder' | 'document', template?: DocumentTemplate) => {
        const parent = docFolderId()
        try {
            const created = await api.createProjectDocument(props.project.id, {
                kind,
                title: template ? template.title : kind === 'folder' ? 'New folder' : 'New document',
                body: template?.body,
                parent_id: parent ?? undefined,
                position: nextDocumentPosition(childDocuments(documents(), parent)),
            })
            props.mutate((p) => p.documents.push(created))
            clearProjectDocumentCache()
            // A document opens to be written in; a folder only needs a name, so
            // it opens its rename field instead.
            if (kind === 'document') setDocOpenId(created.id)
            else setDocRenameId(created.id)
        } catch (err) {
            console.error('Failed to create a document:', err)
            ui.toast(kind === 'folder' ? 'Could not add the folder.' : 'Could not add the document.', 'error')
        }
    }

    // The open document's body, saved on the same mechanics as the brief: the
    // store takes every keystroke so the outline and word count follow along,
    // and the PATCH waits for a pause. Leaving the editor, closing the
    // document, or leaving the hub flushes.
    let docBodyTimer: ReturnType<typeof setTimeout> | undefined
    let docBodyPending: { id: string; body: string } | null = null
    const docBodyFlush = () => {
        clearTimeout(docBodyTimer)
        const pending = docBodyPending
        if (!pending) return
        docBodyPending = null
        clearProjectDocumentCache()
        api.updateProjectDocument(pending.id, { body: pending.body })
            .then((updated) => withDoc(pending.id, (d) => Object.assign(d, updated)))
            .catch((err) => docError(err, 'Could not save the document.'))
    }
    const docBodyChange = (id: string, value: string) => {
        withDoc(id, (d) => (d.body = value))
        docBodyPending = { id, body: value }
        clearTimeout(docBodyTimer)
        docBodyTimer = setTimeout(docBodyFlush, 800)
    }
    createEffect(on(docOpenId, (_id, prev) => prev !== undefined && docBodyFlush()))
    onCleanup(docBodyFlush)

    // Delete is hard and recursive (ADR-0020). The server answers with the
    // whole removed subtree under its original ids, which is exactly what the
    // restore endpoint takes back, so the undo entry is that payload.
    const deleteDocumentRow = async (row: ProjectDocument) => {
        const inside = documentSubtree(documents(), row.id).length - 1
        const ok = await ui.confirm({
            title: row.kind === 'folder' ? 'Delete folder?' : 'Delete document?',
            message:
                row.kind === 'folder'
                    ? inside === 0
                        ? `"${row.title}" is empty. It goes for good.`
                        : `Delete folder and ${inside} item${inside === 1 ? '' : 's'} inside?`
                    : `"${row.title}" goes, and its saved versions with it.`,
            confirmLabel: 'Delete',
            danger: true,
        })
        if (!ok) return
        try {
            const removed = (await api.deleteProjectDocument(row.id)).documents ?? []
            const gone = new Set(removed.map((d) => d.id))
            // A save still waiting for a row that has just been deleted would
            // 404 and report a failure for an edit the delete already threw
            // away.
            if (docBodyPending && gone.has(docBodyPending.id)) docBodyPending = null
            props.mutate((p) => {
                p.documents = p.documents.filter((d) => !gone.has(d.id))
            })
            clearProjectDocumentCache()
            const openId = docOpenId()
            if (openId && gone.has(openId)) setDocOpenId(null)
            const folderId = docFolderId()
            if (folderId && gone.has(folderId)) setDocFolderId(row.parent_id ?? null)
            pushUndo(`Deleted "${row.title}"`, () => {
                api.restoreProjectDocuments(props.project.id, removed)
                    .then((res) =>
                        props.mutate((p) => {
                            const have = new Set(p.documents.map((d) => d.id))
                            p.documents.push(...(res.documents ?? removed).filter((d) => !have.has(d.id)))
                        }),
                    )
                    .catch((err) => {
                        console.error('Failed to restore documents:', err)
                        ui.toast('Could not restore what was deleted.', 'error')
                        void props.reload()
                    })
                clearProjectDocumentCache()
            })
        } catch (err) {
            console.error('Failed to delete document:', err)
            ui.toast('Could not delete it.', 'error')
        }
    }

    // --- card mutations (optimistic; the server's answer overwrites) ---

    const withCard = (id: string, fn: (c: ProjectCard) => void) =>
        props.mutate((p) => {
            const c = p.cards.find((x) => x.id === id)
            if (c) fn(c)
        })
    const patchCard = (id: string, optimistic: (c: ProjectCard) => void, body: Parameters<typeof api.updateProjectCard>[1]) => {
        withCard(id, optimistic)
        api.updateProjectCard(id, body)
            .then((updated) => withCard(id, (c) => Object.assign(c, updated)))
            .catch((err) => {
                console.error('Failed to update card:', err)
                ui.toast('Could not update the card.', 'error')
                void props.reload()
            })
    }

    const addCards = (msId: string, titles: string[]) => {
        api.createProjectCards(props.project.id, msId, titles)
            .then((cards) => props.mutate((p) => p.cards.push(...(cards ?? []))))
            .catch((err) => {
                console.error('Failed to add cards:', err)
                ui.toast('Could not add the card.', 'error')
            })
    }

    const dismissCard = (c: ProjectCard) => {
        if (editId() === c.id) setEditId(null)
        patchCard(c.id, (x) => (x.dismissed = true), { dismissed: true })
        pushUndo(`Dismissed "${c.title}"`, () => patchCard(c.id, (x) => (x.dismissed = false), { dismissed: false }))
    }

    const deleteCardForever = async (c: ProjectCard) => {
        const ok = await ui.confirm({
            title: 'Delete card forever?',
            message: `"${c.title}" leaves the graveyard for good.`,
            confirmLabel: 'Delete',
            danger: true,
        })
        if (!ok) return
        try {
            await api.deleteProjectCard(c.id)
            props.mutate((p) => {
                const i = p.cards.findIndex((x) => x.id === c.id)
                if (i >= 0) p.cards.splice(i, 1)
            })
        } catch (err) {
            console.error('Failed to delete card:', err)
            ui.toast('Could not delete the card.', 'error')
        }
    }

    // A drop is one PATCH: milestone + midpoint position together.
    const moveCard = (cardId: string, toMs: string, beforeId?: string) => {
        const target = cardsOf(props.project, toMs).filter((c) => c.id !== cardId)
        let pos: number
        if (beforeId) {
            const at = target.findIndex((c) => c.id === beforeId)
            const before = target[at]
            const prev = target[at - 1]
            pos = prev ? (prev.position + before.position) / 2 : before.position - 1
        } else {
            pos = target.length ? target[target.length - 1].position + 1 : 0
        }
        patchCard(
            cardId,
            (c) => {
                c.milestone_id = toMs
                c.position = pos
            },
            { milestone_id: toMs, position: pos },
        )
    }

    // --- milestone mutations ---

    const withMs = (id: string, fn: (m: ProjectMilestone) => void) =>
        props.mutate((p) => {
            const m = p.milestones.find((x) => x.id === id)
            if (m) fn(m)
        })
    const patchMs = (id: string, optimistic: (m: ProjectMilestone) => void, body: Parameters<typeof api.updateProjectMilestone>[1]) => {
        withMs(id, optimistic)
        api.updateProjectMilestone(id, body).catch((err) => {
            console.error('Failed to update milestone:', err)
            ui.toast('Could not update the milestone.', 'error')
            void props.reload()
        })
    }

    const newMilestone = () => {
        api.createProjectMilestone(props.project.id, 'New milestone')
            .then((m) => props.mutate((p) => p.milestones.push(m)))
            .catch((err) => {
                console.error('Failed to create milestone:', err)
                ui.toast('Could not add a milestone.', 'error')
            })
    }

    const deleteMilestone = async (m: ProjectMilestone) => {
        const count = allCardsOf(props.project, m.id).length
        const others = props.project.milestones.length > 1
        const ok = await ui.confirm({
            title: 'Delete milestone?',
            message:
                count === 0
                    ? `"${m.title}" is removed from the roadmap.`
                    : others
                      ? `Its ${count} card${count === 1 ? '' : 's'} move to the neighbouring milestone; nothing is lost.`
                      : `This is the last milestone: its ${count} card${count === 1 ? ' goes' : 's go'} with it.`,
            confirmLabel: 'Delete',
            danger: !others && count > 0,
        })
        if (!ok) return
        try {
            await api.deleteProjectMilestone(m.id)
            // The server rehomed the cards; refetch rather than guess where.
            await props.reload()
        } catch (err) {
            console.error('Failed to delete milestone:', err)
            ui.toast('Could not delete the milestone.', 'error')
        }
    }

    // Drop onto a panel: join its track, stacked directly under it.
    const stackInto = (fromId: string, targetId: string) => {
        if (fromId === targetId) return
        const p = props.project
        const target = p.milestones.find((m) => m.id === targetId)
        if (!target) return
        const ordered = msOrder(p)
        const after = ordered[ordered.findIndex((m) => m.id === targetId) + 1]
        const pos = after && after.id !== fromId ? (target.position + after.position) / 2 : target.position + 1
        patchMs(
            fromId,
            (m) => {
                m.track = target.track
                m.position = pos
            },
            { track: target.track, position: pos },
        )
    }

    // Drop into a gap: the panel gets a track of its own there. Tracks are
    // integers, so the sequence renumbers and every changed milestone is
    // patched (last-write-wins, like Tasks column reorder).
    const toOwnTrack = (fromId: string, beforeTrack?: number) => {
        const p = props.project
        const from = p.milestones.find((m) => m.id === fromId)
        if (!from) return
        const soloAlready = inTrack(p, from.track).length === 1
        if (soloAlready && beforeTrack === from.track) return
        const remaining = trackList(p).filter((t) => !(soloAlready && t === from.track))
        const insertAt = beforeTrack === undefined ? remaining.length : Math.max(0, remaining.indexOf(beforeTrack))
        const seq: (number | 'moved')[] = [...remaining]
        seq.splice(insertAt, 0, 'moved')
        for (const m of msOrder(p)) {
            const t = m.id === fromId ? seq.indexOf('moved') : seq.indexOf(m.track)
            if (t !== m.track) {
                withMs(m.id, (x) => (x.track = t))
                void api.updateProjectMilestone(m.id, { track: t }).catch(() => {})
            }
        }
    }

    // --- board view state ---

    // Board order: open work first (priority, then nearest due), completed
    // pooled at the bottom. Stable, so manual order survives within a group.
    const sortCards = (cards: ProjectCard[]) =>
        [...cards].sort((a, b) => Number(a.done) - Number(b.done) || b.priority - a.priority || dueMs(a.due_at) - dueMs(b.due_at))
    // Per-milestone "hide completed", plus a global switch that sets them all.
    const [hiddenDone, setHiddenDone] = createStore<Record<string, boolean>>({})
    const allHidden = () => props.project.milestones.length > 0 && props.project.milestones.every((m) => hiddenDone[m.id])
    const setAllHidden = (v: boolean) => setHiddenDone(produce((h) => props.project.milestones.forEach((m) => (h[m.id] = v))))
    const panelCards = (ms: ProjectMilestone) => {
        const sorted = sortCards(cardsOf(props.project, ms.id))
        return hiddenDone[ms.id] ? sorted.filter((c) => !c.done) : sorted
    }

    const editCard = () => props.project.cards.find((c) => c.id === editId()) || null
    const graveyard = () => props.project.cards.filter((c) => c.dismissed)

    return (
        <div class="relative z-10 flex min-h-0 flex-1 flex-col" style={{ background: `radial-gradient(80rem 24rem at 15% -5%, ${accent()}14, transparent)` }}>
            <div class="bg-element border-element-accent flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3 sm:px-5" style={{ 'border-top': `2px solid ${accent()}b3` }}>
                <button onClick={props.onBack} class="text-sub hover:text-main hover:cursor-pointer" title="Back to all projects">
                    <span class="material-symbols-outlined">arrow_back</span>
                </button>
                <span class="text-sub text-xs">Projects /</span>
                <span class="material-symbols-outlined text-base" style={{ color: accent() }}>{props.project.icon}</span>
                <span class="font-mono text-xs font-bold" style={{ color: accent() }}>{keyOf(props.project)}</span>
                <Show when={props.canManage} fallback={<span class="text-main font-serif text-xl font-semibold">{props.project.title}</span>}>
                    <input
                        type="text"
                        value={props.project.title}
                        onChange={(e) => props.patchProject((p) => (p.title = e.currentTarget.value), { title: e.currentTarget.value })}
                        title="Rename project"
                        class="text-main font-serif hover:border-element-accent focus:border-highlight w-36 min-w-0 rounded-md border border-transparent bg-transparent px-1 text-xl font-semibold transition-colors focus:outline-none sm:w-56"
                    />
                </Show>
                {/* Scrolls rather than clips: four tabs are wider than a
                    390px shell, and a clipped tab is a tab nobody can reach. */}
                <div class="border-element-accent flex max-w-full overflow-x-auto rounded-md border">
                    <For each={HUB_TABS}>
                        {(t) => (
                            <button
                                onClick={() => setTab(t.key)}
                                class="flex shrink-0 items-center gap-1 px-2.5 py-1.5 text-xs transition-colors hover:cursor-pointer"
                                classList={{ 'text-sub hover:text-main': tab() !== t.key }}
                                style={tab() === t.key ? { 'background-color': `${accent()}2b`, color: accent(), 'font-weight': '700' } : {}}
                                title={`${t.label} view`}
                            >
                                <span class="material-symbols-outlined text-sm">{t.icon}</span>
                                {t.label}
                            </button>
                        )}
                    </For>
                </div>
                <div class="ml-auto flex items-center gap-2">
                    <span class="text-sub whitespace-nowrap text-xs">{doneCount(all())}/{all().length} done</span>
                    <Meter done={doneCount(all())} total={all().length} class="w-32" color={accent()} />
                </div>
                <Show when={tab() === 'board'}>
                    <button
                        onClick={() => setAllHidden(!allHidden())}
                        title={allHidden() ? 'Show completed on every milestone' : 'Hide completed on every milestone'}
                        class="transition-colors hover:cursor-pointer"
                        classList={{ 'text-highlight': allHidden(), 'text-sub hover:text-main': !allHidden() }}
                    >
                        <span class="material-symbols-outlined">{allHidden() ? 'visibility_off' : 'visibility'}</span>
                    </button>
                </Show>
                <Show when={props.canManage}>
                    <div class="relative">
                        <button onClick={() => setShowLook(!showLook())} title="Color and icon" class="text-sub hover:text-main hover:cursor-pointer">
                            <span class="material-symbols-outlined">palette</span>
                        </button>
                        <Show when={showLook()}>
                            <div class="bg-element-matte border-element-accent absolute right-0 top-8 z-40 w-72 rounded-lg border p-4 shadow-2xl">
                                <p class="text-sub mb-2 text-xs font-medium">Accent</p>
                                <div class="flex flex-wrap gap-2">
                                    <For each={ACCENTS}>
                                        {(a) => (
                                            <button
                                                onClick={() => props.patchProject((p) => (p.accent = a), { accent: a })}
                                                class="h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 hover:cursor-pointer"
                                                classList={{ 'border-white': accent() === a, 'border-transparent': accent() !== a }}
                                                style={{ 'background-color': a }}
                                                title={a}
                                            />
                                        )}
                                    </For>
                                </div>
                                <p class="text-sub mb-2 mt-4 text-xs font-medium">Icon</p>
                                <div class="flex flex-wrap gap-1.5">
                                    <For each={ICONS}>
                                        {(ic) => (
                                            <button
                                                onClick={() => props.patchProject((p) => (p.icon = ic), { icon: ic })}
                                                class="rounded p-1 transition-colors hover:cursor-pointer"
                                                classList={{ 'bg-element-accent text-main': props.project.icon === ic, 'text-sub hover:text-main': props.project.icon !== ic }}
                                                title={ic}
                                            >
                                                <span class="material-symbols-outlined text-lg">{ic}</span>
                                            </button>
                                        )}
                                    </For>
                                </div>
                            </div>
                        </Show>
                    </div>
                    <button onClick={props.onArchive} title="Archive project" class="text-sub hover:text-main hover:cursor-pointer">
                        <span class="material-symbols-outlined">inventory_2</span>
                    </button>
                </Show>
                <button onClick={props.onClose} class="text-sub hover:text-main transition-colors hover:cursor-pointer" title="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>

            <Show when={tab() === 'overview'}>
                <div class="animate-fade-in min-h-0 flex-1 overflow-y-auto">
                    <div class="px-4 py-5 sm:px-8 sm:py-6">
                        <div class="flex items-center gap-2">
                            <span class="material-symbols-outlined text-lg" style={{ color: accent() }}>{props.project.icon}</span>
                            <span class="font-mono text-xs font-bold tracking-widest" style={{ color: accent() }}>{keyOf(props.project)}</span>
                            <HealthWord p={props.project} />
                        </div>
                        <div class="mt-1 flex flex-wrap items-end justify-between gap-x-10 gap-y-3">
                            <h2 class="text-main font-serif text-4xl font-bold">{props.project.title}</h2>
                            <p class="text-sub pb-1 text-sm">
                                <span class="text-main font-mono font-bold">{all().length === 0 ? 0 : Math.round((doneCount(all()) / all().length) * 100)}%</span> complete
                                · <span class="text-main font-mono font-bold">{all().filter((c) => !c.done).length}</span> open
                                · <span class="text-main font-mono font-bold">{doneCount(all())}</span> done
                                <Show when={nextMilestone(props.project)}>
                                    {(ms) => (
                                        <>
                                            {' '}· next <span class="text-main">{ms().title}</span>
                                            <Show when={ms().due_at}> · {fmtDue(ms().due_at!)}</Show>
                                        </>
                                    )}
                                </Show>
                            </p>
                        </div>
                        <div class="mt-4">
                            <SpineMeter p={props.project} color={accent()} />
                        </div>

                        <div class="mt-8 grid grid-cols-1 items-start gap-x-12 gap-y-10 xl:grid-cols-[minmax(0,1fr)_19rem]">
                            <div class="min-w-0">
                                <div class="bg-element border-element-accent/60 rounded-lg border p-7">
                                    <div class="mb-5 flex items-center justify-between">
                                        <h3 class="text-main font-serif text-xl font-semibold">Brief</h3>
                                        <Show when={props.canManage}>
                                            <button
                                                onClick={() => (ovEditing() ? ovDone() : setOvEditing(true))}
                                                class="border-element-accent flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs transition-colors hover:cursor-pointer"
                                                classList={{ 'bg-highlight-strongest text-white': ovEditing(), 'text-sub hover:text-main': !ovEditing() }}
                                            >
                                                <span class="material-symbols-outlined text-sm">{ovEditing() ? 'done' : 'edit'}</span>
                                                {ovEditing() ? 'Done' : 'Edit'}
                                            </button>
                                        </Show>
                                    </div>
                                    <Show
                                        when={!ovEditing()}
                                        fallback={
                                            <Editor
                                                chrome="body"
                                                initialContent={props.project.overview}
                                                placeholder="The project brief. Markdown; [[ embeds a moment, to-do, canvas, project, document or your agenda; paste or drop images."
                                                onChange={ovChange}
                                                onSubmit={async () => ovDone()}
                                            />
                                        }
                                    >
                                        <Show
                                            when={props.project.overview.trim()}
                                            fallback={
                                                <p class="text-sub/60 text-sm italic">
                                                    {props.canManage ? 'No brief yet. Edit starts it.' : 'No brief yet.'}
                                                </p>
                                            }
                                        >
                                            <MomentBody
                                                content={props.project.overview}
                                                onOpenMoment={props.onOpenMoment}
                                                onOpenTodo={props.onOpenTodo}
                                                onOpenCanvas={props.onOpenCanvas}
                                                onOpenProject={props.onOpenProject}
                                                onOpenDoc={props.onOpenDoc}
                                            />
                                        </Show>
                                    </Show>
                                </div>

                                <div class="bg-element border-element-accent/60 mt-8 rounded-lg border p-7">
                                    <h3 class="text-main font-serif mb-6 text-xl font-semibold">Signals</h3>
                                    <div class="grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-2">
                                        <div>
                                            <p class="text-sub mb-3 text-xs font-medium">Momentum · finished per day · 14d</p>
                                            <MomentumBars days={momentum(props.project)} height={110} barClass="min-w-0 flex-1" color={accent()} />
                                            <div class="text-sub/60 mt-1 flex justify-between text-[10px]">
                                                <span>2 weeks ago</span>
                                                <span class="text-main font-mono">best day: {Math.max(0, ...momentum(props.project))}</span>
                                                <span>today</span>
                                            </div>
                                        </div>
                                        <div>
                                            <p class="text-sub mb-3 text-xs font-medium">Open by priority</p>
                                            <For each={[...PRIORITIES].reverse()}>
                                                {(pr) => {
                                                    const count = () => all().filter((c) => !c.done && c.priority === pr.v).length
                                                    const maxCount = () => Math.max(1, ...PRIORITIES.map((x) => all().filter((c) => !c.done && c.priority === x.v).length))
                                                    return (
                                                        <div class="flex items-center gap-3 py-1.5">
                                                            <span class="text-sub w-10 shrink-0 text-xs">{pr.label}</span>
                                                            <div class="bg-element-accent h-3 flex-1 overflow-hidden rounded">
                                                                <div
                                                                    class="h-full rounded transition-all"
                                                                    style={{
                                                                        width: `${Math.round((count() / maxCount()) * 100)}%`,
                                                                        'background-color': pr.color || 'var(--theme-element-accent)',
                                                                        'min-width': count() > 0 ? '4px' : '0',
                                                                    }}
                                                                />
                                                            </div>
                                                            <span class="text-main w-5 shrink-0 text-right font-mono text-sm font-bold">{count()}</span>
                                                        </div>
                                                    )
                                                }}
                                            </For>
                                        </div>
                                        <div>
                                            <p class="text-sub mb-3 text-xs font-medium">Open by label</p>
                                            <Show
                                                when={[...new Set(all().flatMap((c) => splitLabels(c.labels)))].length > 0}
                                                fallback={<p class="text-sub/50 text-xs italic">No labels yet. Add them from a card.</p>}
                                            >
                                                <For each={[...new Set(all().flatMap((c) => splitLabels(c.labels)))].slice(0, 6)}>
                                                    {(l) => {
                                                        const count = () => all().filter((c) => !c.done && splitLabels(c.labels).includes(l)).length
                                                        const maxCount = () =>
                                                            Math.max(
                                                                1,
                                                                ...[...new Set(all().flatMap((c) => splitLabels(c.labels)))].map(
                                                                    (x) => all().filter((c) => !c.done && splitLabels(c.labels).includes(x)).length,
                                                                ),
                                                            )
                                                        return (
                                                            <div class="flex items-center gap-3 py-1.5">
                                                                <span
                                                                    class="w-14 shrink-0 truncate rounded px-1.5 text-center text-[10px] font-medium"
                                                                    style={{ color: labelColor(l), border: `1px solid ${labelColor(l)}44` }}
                                                                >
                                                                    {l}
                                                                </span>
                                                                <div class="bg-element-accent h-2 flex-1 overflow-hidden rounded">
                                                                    <div
                                                                        class="h-full rounded transition-all"
                                                                        style={{
                                                                            width: `${Math.round((count() / maxCount()) * 100)}%`,
                                                                            'background-color': `${labelColor(l)}cc`,
                                                                            'min-width': count() > 0 ? '4px' : '0',
                                                                        }}
                                                                    />
                                                                </div>
                                                                <span class="text-main w-4 shrink-0 text-right font-mono text-xs font-bold">{count()}</span>
                                                            </div>
                                                        )
                                                    }}
                                                </For>
                                            </Show>
                                        </div>
                                        <div>
                                            <p class="text-sub mb-3 text-xs font-medium">Recently finished</p>
                                            <Show when={doneCount(all()) > 0} fallback={<p class="text-sub/50 text-xs italic">Nothing finished yet.</p>}>
                                                <For
                                                    each={all()
                                                        .filter((c) => c.done)
                                                        .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))
                                                        .slice(0, 4)}
                                                >
                                                    {(c) => (
                                                        <div
                                                            class="hover:bg-element-matte/40 -mx-1.5 flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:cursor-pointer"
                                                            title="Open card"
                                                            onClick={() => setEditId(c.id)}
                                                        >
                                                            <span class="material-symbols-outlined text-[15px]" style={{ color: accent() }}>check_circle</span>
                                                            <span class="text-sub min-w-0 flex-1 truncate text-sm line-through">{c.title}</span>
                                                        </div>
                                                    )}
                                                </For>
                                            </Show>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="min-w-0">
                                <div class="bg-element border-element-accent/60 rounded-lg border p-5">
                                <h3 class="text-main font-serif text-xl font-semibold">Up next</h3>
                                <div class="mt-3">
                                    <Show
                                        when={all().filter((c) => !c.done && c.due_at).length > 0}
                                        fallback={<p class="text-sub/50 text-sm italic">Nothing dated. The board decides what is next.</p>}
                                    >
                                        <For each={all().filter((c) => !c.done && c.due_at).sort((a, b) => dueMs(a.due_at) - dueMs(b.due_at)).slice(0, 5)}>
                                            {(c) => (
                                                <div
                                                    class="hover:bg-element-matte/40 -mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:cursor-pointer"
                                                    title="Open card"
                                                    onClick={() => setEditId(c.id)}
                                                >
                                                    <Show when={priorityIcon(c.priority)}>
                                                        <span class="material-symbols-outlined text-[15px]" style={{ color: priorityColor(c.priority) }}>
                                                            {priorityIcon(c.priority)}
                                                        </span>
                                                    </Show>
                                                    <span class="text-main min-w-0 flex-1 truncate text-sm">{c.title}</span>
                                                    <span
                                                        class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold"
                                                        classList={{ 'bg-danger/20 text-danger': cardOverdue(c), 'bg-element-accent text-sub': !cardOverdue(c) }}
                                                    >
                                                        {fmtDue(c.due_at!)}
                                                    </span>
                                                </div>
                                            )}
                                        </For>
                                    </Show>
                                </div>

                                </div>

                                <div class="bg-element border-element-accent/60 mt-6 rounded-lg border p-5">
                                <h3 class="text-main font-serif text-xl font-semibold">Roadmap</h3>
                                <div class="mt-4">
                                    <Show when={props.project.milestones.length > 0} fallback={<p class="text-sub/50 text-sm italic">No milestones yet. Add them on the board.</p>}>
                                        <For each={msOrder(props.project)}>
                                            {(ms, i) => {
                                                const complete = () => msComplete(props.project, ms)
                                                const active = () => nextMilestone(props.project)?.id === ms.id
                                                const cards = () => cardsOf(props.project, ms.id)
                                                return (
                                                    <div
                                                        class="hover:bg-element-matte/40 -mx-2 flex gap-3 rounded-md px-2 transition-colors hover:cursor-pointer"
                                                        title="Open on the board"
                                                        onClick={() => setTab('board')}
                                                    >
                                                        <div class="flex w-3 flex-col items-center">
                                                            <div
                                                                class="mt-1 h-3 w-3 shrink-0 rounded-full border-2"
                                                                classList={{ 'border-element-accent': !complete() && !active() }}
                                                                style={
                                                                    complete()
                                                                        ? { 'background-color': accent(), 'border-color': accent() }
                                                                        : active()
                                                                          ? { 'border-color': accent(), 'box-shadow': `0 0 0 3px ${accent()}33` }
                                                                          : {}
                                                                }
                                                            />
                                                            <Show when={i() < props.project.milestones.length - 1}>
                                                                <div class="bg-element-accent w-px flex-1" />
                                                            </Show>
                                                        </div>
                                                        <div class="min-w-0 flex-1 pb-5">
                                                            <div class="flex items-center gap-2">
                                                                <span class="text-main truncate text-sm" classList={{ 'text-sub': complete(), 'font-semibold': active() }}>{ms.title}</span>
                                                                <Show when={ms.due_at}>
                                                                    <span class="text-sub shrink-0 text-[10px]" classList={{ 'text-danger': msOverdue(props.project, ms) }}>
                                                                        {fmtDue(ms.due_at!)}
                                                                    </span>
                                                                </Show>
                                                                <span class="text-sub ml-auto shrink-0 font-mono text-[10px]">{doneCount(cards())}/{cards().length}</span>
                                                            </div>
                                                            <div class="bg-element-accent mt-1.5 h-1 overflow-hidden rounded-full">
                                                                <div
                                                                    class="h-full rounded-full transition-all"
                                                                    style={{
                                                                        width: `${cards().length === 0 ? 0 : Math.round((doneCount(cards()) / cards().length) * 100)}%`,
                                                                        'background-color': accent(),
                                                                    }}
                                                                />
                                                            </div>
                                                        </div>
                                                    </div>
                                                )
                                            }}
                                        </For>
                                    </Show>
                                </div>

                                <button
                                    onClick={() => setTab('graveyard')}
                                    class="text-sub hover:text-main border-element-accent/60 mt-4 flex w-full items-center gap-1.5 border-t pt-4 text-xs transition-colors hover:cursor-pointer"
                                >
                                    <span class="material-symbols-outlined text-base">history</span>
                                    <span class="text-main font-mono font-bold">{graveyard().length}</span> dismissed · open the graveyard
                                </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </Show>

            <Show when={tab() === 'graveyard'}>
                <div class="animate-fade-in min-h-0 flex-1 overflow-y-auto p-6">
                    <div class="mb-4 flex items-baseline gap-3">
                        <h2 class="text-main font-serif text-2xl font-semibold">Graveyard</h2>
                        <span class="text-sub text-xs">Dismissed cards never die; restore them any time, or let them rest as a record of roads not taken.</span>
                    </div>
                    <Show
                        when={graveyard().length > 0}
                        fallback={
                            <div class="bg-element border-element-accent flex flex-col items-center gap-2 rounded-lg border border-dashed py-16">
                                <span class="material-symbols-outlined text-sub/40 text-4xl">history</span>
                                <p class="text-sub/60 text-sm italic">Nothing dismissed. The X on a card sends it here, never into the void.</p>
                            </div>
                        }
                    >
                        <For each={msOrder(props.project).filter((m) => allCardsOf(props.project, m.id).some((c) => c.dismissed))}>
                            {(ms) => (
                                <div class="mb-4">
                                    <p class="text-sub/70 mb-1.5 text-xs font-medium">from {ms.title}</p>
                                    <For each={allCardsOf(props.project, ms.id).filter((c) => c.dismissed)}>
                                        {(c) => (
                                            <div class="bg-element border-element-accent mb-1.5 flex items-center gap-3 rounded-md border px-4 py-2.5">
                                                <span class="text-sub text-sm line-through">{c.title}</span>
                                                <div class="flex flex-wrap gap-1">
                                                    <For each={splitLabels(c.labels)}>{(l) => <LabelChip name={l} dim />}</For>
                                                </div>
                                                <Show when={props.canManage}>
                                                    <button
                                                        onClick={() => patchCard(c.id, (x) => (x.dismissed = false), { dismissed: false })}
                                                        class="text-highlight ml-auto text-xs font-bold hover:cursor-pointer hover:brightness-125"
                                                    >
                                                        Restore
                                                    </button>
                                                    <button onClick={() => void deleteCardForever(c)} class="text-danger/70 hover:text-danger text-xs font-bold hover:cursor-pointer">
                                                        Delete forever
                                                    </button>
                                                </Show>
                                            </div>
                                        )}
                                    </For>
                                </div>
                            )}
                        </For>
                    </Show>
                </div>
            </Show>

            <Show when={tab() === 'board'}>
                <div class="animate-fade-in flex min-h-0 flex-1">
                    <div class="flex min-h-0 min-w-0 flex-1 items-stretch overflow-x-auto p-5 pr-2">
                        <For each={trackList(props.project)}>
                            {(t) => (
                                <>
                                    {/* Gap between tracks: while a panel is in flight this is a
                                        visible slot that gives it a track of its own here. */}
                                    <div
                                        class="mx-0.5 w-3 shrink-0 self-stretch rounded transition-colors"
                                        classList={{ 'bg-highlight/15': !!dragCol() }}
                                        onDragOver={(e) => {
                                            if (dragCol()) e.preventDefault()
                                        }}
                                        onDrop={(e) => {
                                            e.preventDefault()
                                            if (dragCol()) toOwnTrack(dragCol()!, t)
                                            setDragCol(null)
                                        }}
                                    />
                                    <div class="flex h-full w-80 shrink-0 flex-col gap-3">
                                        <For each={inTrack(props.project, t)}>
                                            {(ms) => {
                                                let panelEl: HTMLDivElement | undefined
                                                const num = () => msOrder(props.project).findIndex((m) => m.id === ms.id) + 1
                                                return (
                                                    <div
                                                        ref={(el) => (panelEl = el)}
                                                        class="bg-element border-element-accent flex min-h-0 w-full flex-1 flex-col rounded-lg border transition-opacity"
                                                        classList={{ 'opacity-40': dragCol() === ms.id }}
                                                        onDragOver={(e) => {
                                                            if (dragCard() || (dragCol() && dragCol() !== ms.id)) e.preventDefault()
                                                        }}
                                                        onDrop={(e) => {
                                                            e.preventDefault()
                                                            if (dragCard()) moveCard(dragCard()!, ms.id)
                                                            else if (dragCol() && dragCol() !== ms.id) stackInto(dragCol()!, ms.id)
                                                            setDragCard(null)
                                                            setDragCol(null)
                                                        }}
                                                    >
                                                        <div class="border-element-accent flex flex-col gap-2 border-b p-3">
                                                            <div class="flex items-center gap-2">
                                                                <Show when={props.canManage}>
                                                                    <span
                                                                        draggable={true}
                                                                        onDragStart={(e) => {
                                                                            e.dataTransfer?.setData('text/plain', ms.id)
                                                                            // The whole panel rides the cursor, not the grip icon.
                                                                            if (panelEl && e.dataTransfer) e.dataTransfer.setDragImage(panelEl, 30, 20)
                                                                            setDragCol(ms.id)
                                                                        }}
                                                                        onDragEnd={() => setDragCol(null)}
                                                                        title="Drag to move: drop on a panel to stack, in a gap for its own column"
                                                                        class="material-symbols-outlined text-sub/40 hover:text-sub cursor-grab text-base"
                                                                    >
                                                                        drag_indicator
                                                                    </span>
                                                                </Show>
                                                                <span class="text-sub/50 shrink-0 font-mono text-[11px] font-bold">{num()}</span>
                                                                <Show
                                                                    when={props.canManage}
                                                                    fallback={<span class="text-main font-serif min-w-0 flex-1 truncate text-sm font-semibold">{ms.title}</span>}
                                                                >
                                                                    <input
                                                                        type="text"
                                                                        value={ms.title}
                                                                        onChange={(e) => patchMs(ms.id, (m) => (m.title = e.currentTarget.value), { title: e.currentTarget.value })}
                                                                        class="bg-element-matte text-main font-serif border-element-accent focus:border-highlight min-w-0 flex-1 rounded-md border px-2 py-1 text-sm font-semibold focus:outline-none"
                                                                    />
                                                                    <button onClick={() => void deleteMilestone(ms)} class="text-sub hover:text-danger shrink-0 hover:cursor-pointer" title="Delete milestone">
                                                                        <span class="material-symbols-outlined text-base">delete</span>
                                                                    </button>
                                                                </Show>
                                                            </div>
                                                            <div class="flex items-center gap-2">
                                                                <Show
                                                                    when={props.canManage}
                                                                    fallback={
                                                                        <Show when={ms.due_at} fallback={<span class="text-sub/50 text-xs">No date</span>}>
                                                                            <span class="bg-element-accent text-sub rounded px-1.5 py-0.5 text-[10px] font-bold">{fmtDue(ms.due_at!)}</span>
                                                                        </Show>
                                                                    }
                                                                >
                                                                    <input
                                                                        type="date"
                                                                        value={isoToDateInput(ms.due_at)}
                                                                        onChange={(e) =>
                                                                            patchMs(
                                                                                ms.id,
                                                                                (m) => (m.due_at = e.currentTarget.value ? dateInputToIso(e.currentTarget.value) : undefined),
                                                                                { due_at: e.currentTarget.value ? dateInputToIso(e.currentTarget.value) : '' },
                                                                            )
                                                                        }
                                                                        title="Milestone due date"
                                                                        class="bg-element-matte border-element-accent focus:border-highlight rounded border px-1 py-0.5 text-[11px] focus:outline-none hover:cursor-pointer"
                                                                        classList={{ 'text-danger': msOverdue(props.project, ms), 'text-sub': !msOverdue(props.project, ms) }}
                                                                    />
                                                                </Show>
                                                                <span class="text-sub whitespace-nowrap text-xs">
                                                                    {doneCount(cardsOf(props.project, ms.id))}/{cardsOf(props.project, ms.id).length} done
                                                                </span>
                                                                <div class="ml-auto flex items-center gap-2">
                                                                    <Meter done={doneCount(cardsOf(props.project, ms.id))} total={cardsOf(props.project, ms.id).length} color={accent()} />
                                                                    <button
                                                                        onClick={() => setHiddenDone(ms.id, !hiddenDone[ms.id])}
                                                                        title={hiddenDone[ms.id] ? `Show ${doneCount(cardsOf(props.project, ms.id))} completed` : 'Hide completed'}
                                                                        class="shrink-0 transition-colors hover:cursor-pointer"
                                                                        classList={{ 'text-highlight': hiddenDone[ms.id], 'text-sub/50 hover:text-sub': !hiddenDone[ms.id] }}
                                                                    >
                                                                        <span class="material-symbols-outlined text-base">{hiddenDone[ms.id] ? 'visibility_off' : 'visibility'}</span>
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                                                            <Show
                                                                when={panelCards(ms).length > 0}
                                                                fallback={
                                                                    <div class="border-element-accent/60 flex flex-col items-center gap-1 rounded-md border border-dashed py-6">
                                                                        <span class="material-symbols-outlined text-sub/30 text-xl">post_add</span>
                                                                        <p class="text-sub/50 text-xs italic">
                                                                            {hiddenDone[ms.id] && cardsOf(props.project, ms.id).length > 0
                                                                                ? 'All done and hidden.'
                                                                                : 'Nothing here yet. Type below, Enter adds.'}
                                                                        </p>
                                                                    </div>
                                                                }
                                                            >
                                                                <For each={panelCards(ms)}>
                                                                    {(c) => (
                                                                        <div
                                                                            draggable={props.canManage}
                                                                            onDragStart={(e) => {
                                                                                e.dataTransfer?.setData('text/plain', c.id)
                                                                                setDragCard(c.id)
                                                                            }}
                                                                            onDragEnd={() => setDragCard(null)}
                                                                            onDragOver={(e) => {
                                                                                if (dragCard() && dragCard() !== c.id) {
                                                                                    e.preventDefault()
                                                                                    e.stopPropagation()
                                                                                }
                                                                            }}
                                                                            onDrop={(e) => {
                                                                                e.preventDefault()
                                                                                e.stopPropagation()
                                                                                if (dragCard() && dragCard() !== c.id) moveCard(dragCard()!, ms.id, c.id)
                                                                                setDragCard(null)
                                                                            }}
                                                                            onClick={() => setEditId(editId() === c.id ? null : c.id)}
                                                                            classList={{
                                                                                'opacity-40': dragCard() === c.id,
                                                                                'ring-1 ring-highlight': editId() === c.id,
                                                                                'cursor-grab': props.canManage,
                                                                            }}
                                                                            class="group bg-element-matte border-element-accent hover:border-highlight/40 flex flex-col gap-1.5 rounded-md border p-2 transition-all duration-150 hover:-translate-y-px hover:shadow-md"
                                                                            style={priorityColor(c.priority) ? { 'border-left': `3px solid ${priorityColor(c.priority)}` } : {}}
                                                                        >
                                                                            <div class="flex items-start gap-2">
                                                                                <input
                                                                                    type="checkbox"
                                                                                    checked={c.done}
                                                                                    disabled={!props.canManage}
                                                                                    onClick={(e) => e.stopPropagation()}
                                                                                    onChange={() => patchCard(c.id, (x) => (x.done = !x.done), { done: !c.done })}
                                                                                    class="mt-0.5 h-4 w-4 shrink-0"
                                                                                />
                                                                                <span class="flex-1 break-words text-sm" classList={{ 'text-sub line-through': c.done, 'text-main': !c.done }}>
                                                                                    {c.title}
                                                                                </span>
                                                                                <Show when={props.canManage}>
                                                                                    <button
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation()
                                                                                            dismissCard(c)
                                                                                        }}
                                                                                        title="Dismiss (undoable)"
                                                                                        class="text-sub hover:text-danger no-hover:opacity-100 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:cursor-pointer"
                                                                                    >
                                                                                        <span class="material-symbols-outlined text-base">close</span>
                                                                                    </button>
                                                                                </Show>
                                                                            </div>
                                                                            <Show when={cardNote(c)}>
                                                                                {(text) => <p class="text-sub/60 line-clamp-2 pl-6 text-xs">{text()}</p>}
                                                                            </Show>
                                                                            <div class="flex items-center gap-1.5 pl-6">
                                                                                <span class="text-sub/50 font-mono text-[10px] font-bold">{keyOf(props.project)}-{cardNum(props.project, c.id)}</span>
                                                                                <Show when={priorityIcon(c.priority)}>
                                                                                    <span
                                                                                        class="material-symbols-outlined text-[14px]"
                                                                                        style={{ color: priorityColor(c.priority) }}
                                                                                        title={`${PRIORITIES.find((p) => p.v === c.priority)?.label} priority`}
                                                                                    >
                                                                                        {priorityIcon(c.priority)}
                                                                                    </span>
                                                                                </Show>
                                                                                <div class="flex flex-wrap gap-1">
                                                                                    <For each={splitLabels(c.labels)}>{(l) => <LabelChip name={l} />}</For>
                                                                                </div>
                                                                                <div class="ml-auto flex shrink-0 items-center gap-1">
                                                                                    <Show when={c.body.trim()}>
                                                                                        <Show
                                                                                            when={prefs().projectCardNoteHint === 'label'}
                                                                                            fallback={<span class="material-symbols-outlined text-sub text-[14px]" title="Has a body">notes</span>}
                                                                                        >
                                                                                            <span class="text-sub/70 whitespace-nowrap text-[10px] italic">Contains notes</span>
                                                                                        </Show>
                                                                                    </Show>
                                                                                    <Show when={c.due_at}>
                                                                                        <span
                                                                                            class="rounded px-1.5 py-0.5 text-[10px] font-bold"
                                                                                            classList={{ 'bg-danger/20 text-danger': cardOverdue(c), 'bg-element-accent text-sub': !cardOverdue(c) }}
                                                                                        >
                                                                                            {fmtDue(c.due_at!)}
                                                                                        </span>
                                                                                    </Show>
                                                                                </div>
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                </For>
                                                            </Show>
                                                        </div>
                                                        <Show when={props.canManage}>
                                                            <div class="p-3 pt-0">
                                                                <QuickAdd placeholder="Add a card…" onAdd={(titles) => addCards(ms.id, titles)} />
                                                            </div>
                                                        </Show>
                                                    </div>
                                                )
                                            }}
                                        </For>
                                    </div>
                                </>
                            )}
                        </For>
                        {/* Trailing gap: drop here for a new rightmost column. */}
                        <div
                            class="mx-0.5 w-3 shrink-0 self-stretch rounded transition-colors"
                            classList={{ 'bg-highlight/15': !!dragCol() }}
                            onDragOver={(e) => {
                                if (dragCol()) e.preventDefault()
                            }}
                            onDrop={(e) => {
                                e.preventDefault()
                                if (dragCol()) toOwnTrack(dragCol()!)
                                setDragCol(null)
                            }}
                        />
                        <Show when={props.canManage}>
                            <div
                                class="bg-element border-element-accent flex w-72 shrink-0 flex-col gap-2 self-start rounded-lg border border-dashed p-3"
                                onDragOver={(e) => {
                                    if (dragCol()) e.preventDefault()
                                }}
                                onDrop={(e) => {
                                    e.preventDefault()
                                    if (dragCol()) toOwnTrack(dragCol()!)
                                    setDragCol(null)
                                }}
                            >
                                <p class="text-sub font-serif text-sm">Add a milestone</p>
                                <button
                                    onClick={newMilestone}
                                    class="bg-highlight-strongest flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-xs text-white transition-[filter] hover:brightness-110 hover:cursor-pointer"
                                >
                                    <span class="material-symbols-outlined text-sm">add</span>
                                    New milestone
                                </button>
                            </div>
                        </Show>
                    </div>
                </div>
            </Show>

            <Show when={tab() === 'documents'}>
                <DocumentsTab
                    project={props.project}
                    canManage={props.canManage}
                    accent={accent()}
                    folderId={docFolderId()}
                    setFolderId={setDocFolderId}
                    openId={docOpenId()}
                    setOpenId={setDocOpenId}
                    renameId={docRenameId()}
                    setRenameId={setDocRenameId}
                    onRename={(id, title) => patchDoc(id, (d) => (d.title = title), { title })}
                    onNew={(kind, template) => void newDocumentRow(kind, template)}
                    onDelete={(row) => void deleteDocumentRow(row)}
                    onBodyChange={docBodyChange}
                    onBodyFlush={docBodyFlush}
                    onStatus={(id, status) => patchDoc(id, (d) => (d.status = status), { status })}
                    onCommentsChanged={(id, open) => withDoc(id, (d) => (d.open_comments = open))}
                    onRestored={(doc) => withDoc(doc.id, (d) => Object.assign(d, doc))}
                    onOpenMoment={props.onOpenMoment}
                    onOpenTodo={props.onOpenTodo}
                    onOpenCanvas={props.onOpenCanvas}
                    onOpenProject={props.onOpenProject}
                    onOpenDoc={props.onOpenDoc}
                />
            </Show>

            <Show when={toastVisible() && undoStack().length > 0}>
                <div class="bg-element-matte border-element-accent fixed bottom-6 left-4 z-50 flex items-center gap-3 rounded-lg border px-4 py-2 shadow-2xl">
                    <span class="text-main max-w-72 truncate text-sm">{undoStack()[undoStack().length - 1].label}</span>
                    <Show when={undoStack().length > 1}>
                        <span class="text-sub text-xs">+{undoStack().length - 1} more</span>
                    </Show>
                    <button onClick={popUndo} class="text-highlight-strongest text-sm font-bold hover:cursor-pointer hover:brightness-125">
                        Undo
                    </button>
                    <span class="text-sub/50 text-[10px]">Ctrl+Z repeats</span>
                </div>
            </Show>

            <Show when={editCard()}>
                {(c) => (
                    <CardModal
                        card={c()}
                        project={props.project}
                        canManage={props.canManage}
                        patch={(optimistic, body) => patchCard(c().id, optimistic, body)}
                        onDismiss={() => dismissCard(c())}
                        onClose={() => setEditId(null)}
                        onOpenMoment={props.onOpenMoment}
                        onOpenTodo={props.onOpenTodo}
                        onOpenCanvas={props.onOpenCanvas}
                        onOpenProject={props.onOpenProject}
                        onOpenDoc={props.onOpenDoc}
                    />
                )}
            </Show>
        </div>
    )
}

// ---- documents ----

// The tab root name in the breadcrumb. The tree has no row for it, so it is
// spelled once here rather than at each of the places that draw the trail.
const DOCUMENTS_ROOT = 'Documents'

interface DocumentsHandlers {
    onRename: (id: string, title: string) => void
    onNew: (kind: 'folder' | 'document', template?: DocumentTemplate) => void
    onDelete: (row: ProjectDocument) => void
    onBodyChange: (id: string, value: string) => void
    onBodyFlush: () => void
    onStatus: (id: string, status: ProjectDocumentStatus) => void
    // The open-thread count the tile badges. The document view owns the
    // comments it loaded, so it is the only thing that knows the number
    // changed; the store keeps it so the grid behind is right on the way out.
    onCommentsChanged: (id: string, open: number) => void
    onRestored: (doc: ProjectDocument) => void
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
    onOpenDoc?: (id: string, projectId: string) => void
}

// The Documents tab: a folder's children as a grid of tiles, or one document
// open on top of it. The tree arrives flat in the project payload and every
// question about its shape is answered by ../projectDocuments.
const DocumentsTab: Component<
    DocumentsHandlers & {
        project: Project
        canManage: boolean
        accent: string
        folderId: string | null
        setFolderId: (id: string | null) => void
        openId: string | null
        setOpenId: (id: string | null) => void
        renameId: string | null
        setRenameId: (id: string | null) => void
    }
> = (props) => {
    const rows = () => props.project.documents || []
    const trail = () => documentPath(rows(), props.folderId)
    const shown = () => childDocuments(rows(), props.folderId)
    const open = () => rows().find((d) => d.id === props.openId && d.kind === 'document') || null
    const [templatesOpen, setTemplatesOpen] = createSignal(false)

    // A folder deleted from another tab (or by an undo that never landed)
    // leaves the grid pointed at nothing. Falling back to the root beats an
    // empty grid with a breadcrumb that names a folder nobody can reach.
    createEffect(() => {
        if (props.folderId && !rows().some((d) => d.id === props.folderId)) props.setFolderId(null)
    })

    return (
        <div data-testid="documents-tab" class="animate-fade-in flex min-h-0 flex-1 flex-col">
            <Show
                when={open()}
                fallback={
                    <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                        <div data-testid="documents-breadcrumb" class="mb-4 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                            <span class="material-symbols-outlined text-base" style={{ color: props.accent }}>
                                folder_open
                            </span>
                            <button
                                onClick={() => props.setFolderId(null)}
                                class="text-sub hover:text-main text-sm transition-colors hover:cursor-pointer"
                                classList={{ 'text-main font-semibold': trail().length === 0 }}
                            >
                                {DOCUMENTS_ROOT}
                            </button>
                            <For each={trail()}>
                                {(folder, i) => (
                                    <>
                                        <span class="text-sub/40 text-sm">/</span>
                                        <button
                                            onClick={() => props.setFolderId(folder.id)}
                                            class="text-sub hover:text-main max-w-48 truncate text-sm transition-colors hover:cursor-pointer"
                                            classList={{ 'text-main font-semibold': i() === trail().length - 1 }}
                                        >
                                            {folder.title || 'Untitled folder'}
                                        </button>
                                    </>
                                )}
                            </For>
                            <span class="text-sub/60 ml-1 text-xs">
                                {shown().length} item{shown().length === 1 ? '' : 's'}
                            </span>
                        </div>

                        <Show
                            when={shown().length > 0 || props.canManage}
                            fallback={
                                <div class="bg-element border-element-accent flex flex-col items-center gap-2 rounded-lg border border-dashed py-20">
                                    <span class="material-symbols-outlined text-sub/40 text-4xl">folder_open</span>
                                    <p class="text-sub/60 text-sm italic">Nothing here.</p>
                                </div>
                            }
                        >
                            <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
                                <For each={shown()}>
                                    {(row) => (
                                        <DocumentTile
                                            row={row}
                                            documents={rows()}
                                            canManage={props.canManage}
                                            accent={props.accent}
                                            renaming={props.renameId === row.id}
                                            onStartRename={() => props.setRenameId(row.id)}
                                            onRename={(title) => {
                                                props.setRenameId(null)
                                                if (title && title !== row.title) props.onRename(row.id, title)
                                            }}
                                            onOpen={() => (row.kind === 'folder' ? props.setFolderId(row.id) : props.setOpenId(row.id))}
                                            onDelete={() => props.onDelete(row)}
                                        />
                                    )}
                                </For>
                                {/* Two ghost tiles, drawn as the outline of what
                                    they add, the way the portfolio draws New
                                    project into the grid it joins. */}
                                <Show when={props.canManage}>
                                    <GhostTile
                                        testid="new-document"
                                        icon="article"
                                        label="New document"
                                        hint="Durable reference content"
                                        onClick={() => props.onNew('document')}
                                        secondaryLabel="From a template"
                                        onSecondary={() => setTemplatesOpen(true)}
                                    />
                                    <GhostTile
                                        testid="new-folder"
                                        icon="create_new_folder"
                                        label="New folder"
                                        hint="Group what belongs together"
                                        onClick={() => props.onNew('folder')}
                                    />
                                </Show>
                            </div>
                        </Show>

                        <Show when={templatesOpen()}>
                            <DocumentTemplatePicker
                                accent={props.accent}
                                onClose={() => setTemplatesOpen(false)}
                                onPick={(template) => {
                                    setTemplatesOpen(false)
                                    props.onNew('document', template)
                                }}
                            />
                        </Show>
                    </div>
                }
            >
                {(doc) => (
                    <DocumentView
                        document={doc()}
                        project={props.project}
                        canManage={props.canManage}
                        accent={props.accent}
                        trail={documentPath(rows(), doc().parent_id ?? null)}
                        onClose={() => props.setOpenId(null)}
                        onOpenFolder={(id) => {
                            props.setOpenId(null)
                            props.setFolderId(id)
                        }}
                        onRename={props.onRename}
                        onNew={props.onNew}
                        onDelete={props.onDelete}
                        onBodyChange={props.onBodyChange}
                        onBodyFlush={props.onBodyFlush}
                        onStatus={props.onStatus}
                        onCommentsChanged={props.onCommentsChanged}
                        onRestored={props.onRestored}
                        onOpenMoment={props.onOpenMoment}
                        onOpenTodo={props.onOpenTodo}
                        onOpenCanvas={props.onOpenCanvas}
                        onOpenProject={props.onOpenProject}
                        onOpenDoc={props.onOpenDoc}
                    />
                )}
            </Show>
        </div>
    )
}

// A ghost tile is the outline of what it adds. The optional second action is a
// quieter line under the first, never a competing button: the plain path stays
// one tap and anything else is one more.
const GhostTile: Component<{
    testid: string
    icon: string
    label: string
    hint: string
    onClick: () => void
    secondaryLabel?: string
    onSecondary?: () => void
}> = (props) => (
    <div
        data-testid={props.testid}
        role="button"
        tabindex={0}
        onClick={props.onClick}
        onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                props.onClick()
            }
        }}
        class="bg-element border-element-accent hover:border-highlight text-sub hover:text-main flex min-h-32 flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed transition-colors hover:cursor-pointer"
    >
        <span class="material-symbols-outlined text-2xl">{props.icon}</span>
        <span class="text-sm font-bold">{props.label}</span>
        <span class="text-sub/60 text-xs">{props.hint}</span>
        <Show when={props.secondaryLabel && props.onSecondary}>
            <button
                data-testid={`${props.testid}-template`}
                onClick={(e) => {
                    e.stopPropagation()
                    props.onSecondary!()
                }}
                class="text-highlight mt-1 text-xs font-bold hover:cursor-pointer hover:brightness-125"
            >
                {props.secondaryLabel}
            </button>
        </Show>
    </div>
)

// The template choice. A template is a first draft of a body and nothing more,
// so the picker says what each one lays out and then gets out of the way.
const DocumentTemplatePicker: Component<{
    accent: string
    onClose: () => void
    onPick: (template: DocumentTemplate) => void
}> = (props) => (
    <Modal onClose={props.onClose} layer="editor" scrim="heavy" class="animate-fade-in p-4 backdrop-blur-sm">
        <div
            data-testid="document-templates"
            class="bg-element-matte border-element-accent flex w-full max-w-md flex-col gap-3 rounded-xl border p-5 shadow-2xl"
        >
            <div class="flex items-center gap-2">
                <span class="material-symbols-outlined" style={{ color: props.accent }}>
                    article
                </span>
                <h3 class="text-main font-serif flex-1 text-lg font-semibold">Start from a template</h3>
                <button onClick={props.onClose} class="text-sub hover:text-main hover:cursor-pointer" title="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <For each={DOCUMENT_TEMPLATES}>
                {(template) => (
                    <button
                        onClick={() => props.onPick(template)}
                        class="border-element-accent hover:border-highlight flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined text-sub text-xl">{template.icon}</span>
                        <span class="min-w-0 flex-1">
                            <span class="text-main block text-sm font-bold">{template.label}</span>
                            <span class="text-sub/70 block text-xs">{template.hint}</span>
                        </span>
                    </button>
                )}
            </For>
            <p class="text-sub/60 text-xs">
                A template only writes the first draft of the body. Everything in it is yours to rewrite or delete.
            </p>
        </div>
    </Modal>
)

// One tile in the grid. A div rather than a button, the way an embed card is,
// because it holds its own rename field and delete control and a button cannot
// contain either.
const DocumentTile: Component<{
    row: ProjectDocument
    documents: ProjectDocument[]
    canManage: boolean
    accent: string
    renaming: boolean
    onStartRename: () => void
    onRename: (title: string) => void
    onOpen: () => void
    onDelete: () => void
}> = (props) => {
    const isFolder = () => props.row.kind === 'folder'
    const counts = () => folderCounts(props.documents, props.row.id)
    const summary = () => excerpt(props.row.body || '', 160)
    return (
        <div
            data-testid={isFolder() ? 'folder-tile' : 'document-tile'}
            role="button"
            tabindex={0}
            onClick={() => !props.renaming && props.onOpen()}
            onKeyDown={(e) => {
                if (!props.renaming && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    props.onOpen()
                }
            }}
            class="group bg-element border-element-accent hover:border-highlight/60 flex min-h-32 flex-col gap-2 rounded-lg border p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:cursor-pointer hover:shadow-xl"
        >
            <div class="flex items-start gap-2">
                <span class="material-symbols-outlined shrink-0 text-lg" style={{ color: props.accent }}>
                    {isFolder() ? 'folder' : 'article'}
                </span>
                <Show
                    when={props.renaming}
                    fallback={<h3 class="text-main font-serif min-w-0 flex-1 truncate text-lg font-semibold">{props.row.title || 'Untitled'}</h3>}
                >
                    <input
                        type="text"
                        value={props.row.title}
                        // Selected, not just focused: a new folder opens on the
                        // placeholder name, and typing should replace it.
                        ref={(el) => queueMicrotask(() => {
                            el.focus()
                            el.select()
                        })}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                            e.stopPropagation()
                            if (e.key === 'Enter') e.currentTarget.blur()
                            if (e.key === 'Escape') {
                                e.currentTarget.value = props.row.title
                                e.currentTarget.blur()
                            }
                        }}
                        onBlur={(e) => props.onRename(e.currentTarget.value.trim())}
                        class="bg-element-matte text-main font-serif border-element-accent focus:border-highlight min-w-0 flex-1 rounded-md border px-2 py-1 text-lg font-semibold focus:outline-none"
                    />
                </Show>
                {/* Draft carries no badge. Every document starts there, so a
                    chip on each one would say nothing and cost the title its
                    room; Final and Locked are the states worth spotting from
                    the grid. */}
                <Show when={!isFolder() && !props.renaming && props.row.status !== 'draft'}>
                    <DocumentStatusBadge status={props.row.status} />
                </Show>
                <Show when={props.canManage && !props.renaming}>
                    <span class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 no-hover:opacity-100">
                        <span
                            onClick={(e) => {
                                e.stopPropagation()
                                props.onStartRename()
                            }}
                            title="Rename"
                            class="material-symbols-outlined text-sub hover:text-main text-base hover:cursor-pointer"
                        >
                            edit
                        </span>
                        <span
                            onClick={(e) => {
                                e.stopPropagation()
                                props.onDelete()
                            }}
                            title={isFolder() ? 'Delete folder and everything in it' : 'Delete document'}
                            class="material-symbols-outlined text-sub hover:text-danger text-base hover:cursor-pointer"
                        >
                            delete
                        </span>
                    </span>
                </Show>
            </div>
            <Show
                when={isFolder()}
                fallback={
                    <Show when={summary()} fallback={<p class="text-sub/50 flex-1 text-sm italic">Empty document.</p>}>
                        <p class="text-sub line-clamp-3 flex-1 text-sm">{summary()}</p>
                    </Show>
                }
            >
                <p class="text-sub flex-1 text-sm">
                    {counts().folders} folder{counts().folders === 1 ? '' : 's'} · {counts().documents} document
                    {counts().documents === 1 ? '' : 's'}
                </p>
            </Show>
            <p class="text-sub/60 border-element-accent/60 flex flex-wrap items-center gap-x-1 border-t pt-2 text-xs">
                <Show when={!isFolder()}>{documentWordCount(props.row.body || '')} words · </Show>
                <Show when={props.row.open_comments > 0}>
                    <span data-testid="document-tile-comments" class="text-highlight flex items-center gap-0.5 font-bold">
                        <span class="material-symbols-outlined text-[13px]">chat_bubble</span>
                        {props.row.open_comments}
                    </span>
                    <span> · </span>
                </Show>
                <span>updated {fmtWhen(props.row.updated_at)}</span>
            </p>
        </div>
    )
}

// The status badge, shared by the tile and the read-only header. Draft draws
// nothing, so this renders nothing for it. Locked is the only status with a
// color of its own: it is the one that changes what the reader can do, not just
// what the document is.
const DocumentStatusBadge: Component<{ status: ProjectDocumentStatus }> = (props) => (
    <Show when={documentStatusBadge(props.status)}>
        {(badge) => (
            <span
                data-testid="document-status-badge"
                class="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold"
                classList={{
                    'border-highlight/50 text-highlight': props.status === 'locked',
                    'border-element-accent text-sub': props.status !== 'locked',
                }}
                title={props.status === 'locked' ? 'Locked: the title and body are frozen until it is unlocked.' : undefined}
            >
                <span class="material-symbols-outlined text-[13px]">{badge().icon}</span>
                {badge().label}
            </span>
        )}
    </Show>
)

// The outline, shared by the desktop rail and the phone's collapsible panel.
// Indented by heading level, and the entry's index is the index of the heading
// element in the rendered body, which is how a click finds it without the
// renderer having to mint anchors.
const DocumentOutline: Component<{ headings: DocumentHeading[]; onPick: (index: number) => void }> = (props) => (
    <Show
        when={props.headings.length > 0}
        fallback={<p class="text-sub/50 text-xs italic">No headings yet. Start a line with # to make one.</p>}
    >
        <div data-testid="document-outline" class="flex flex-col gap-0.5">
            <For each={props.headings}>
                {(heading, i) => (
                    <button
                        onClick={() => props.onPick(i())}
                        class="text-sub hover:text-main truncate rounded px-1 py-0.5 text-left text-xs transition-colors hover:cursor-pointer"
                        classList={{ 'font-semibold': heading.level <= 2 }}
                        style={{ 'padding-left': `${(Math.min(heading.level, 4) - 1) * 10 + 4}px` }}
                        title={heading.text}
                    >
                        {heading.text}
                    </button>
                )}
            </For>
        </div>
    </Show>
)

// ---- comments ----

interface DocumentCommentsProps {
    threads: DocumentThread[]
    blocks: DocumentBlock[]
    canManage: boolean
    busy: boolean
    // The block a new thread is being written against, or null.
    draftBlock: number | null
    focus: string | null
    onFocus: (id: string | null) => void
    onCancelDraft: () => void
    onAdd: (body: string, parentId?: string) => void
    onResolved: (root: ProjectDocumentComment, resolved: boolean) => void
    onDelete: (comment: ProjectDocumentComment) => void
}

// The thread list, shared by the desktop rail and the phone's sheet the way the
// outline is. Resolved threads collapse behind a count: they are kept because a
// settled argument is worth reading later, and folded because an open question
// is what the reader came for.
const DocumentComments: Component<DocumentCommentsProps> = (props) => {
    const [showResolved, setShowResolved] = createSignal(false)
    const openThreads = () => props.threads.filter((t) => !t.root.resolved)
    const resolvedThreads = () => props.threads.filter((t) => t.root.resolved)
    const draftQuote = () => {
        const block = props.draftBlock === null ? undefined : props.blocks[props.draftBlock]
        return block ? excerpt(block.text, 90) : 'this block'
    }

    return (
        <div class="flex flex-col gap-2">
            <Show when={props.draftBlock !== null}>
                <div data-testid="comment-draft" class="border-highlight/50 flex flex-col gap-2 rounded-md border p-2.5">
                    <p class="text-sub/70 border-element-accent line-clamp-2 border-l-2 pl-2 text-[11px] italic">{draftQuote()}</p>
                    <CommentComposer
                        placeholder="What about this block?"
                        submitLabel="Comment"
                        busy={props.busy}
                        onSubmit={(body) => props.onAdd(body)}
                        onCancel={props.onCancelDraft}
                    />
                </div>
            </Show>

            <Show
                when={openThreads().length > 0}
                fallback={
                    <Show when={props.draftBlock === null}>
                        <p class="text-sub/50 text-xs italic">
                            {props.canManage ? 'No open comments. Hover a block and use the + to start one.' : 'No open comments.'}
                        </p>
                    </Show>
                }
            >
                <For each={openThreads()}>
                    {(thread) => (
                        <ThreadCard
                            thread={thread}
                            canManage={props.canManage}
                            busy={props.busy}
                            focused={props.focus === thread.root.id}
                            onFocus={() => props.onFocus(thread.root.id)}
                            onAdd={props.onAdd}
                            onResolved={props.onResolved}
                            onDelete={props.onDelete}
                        />
                    )}
                </For>
            </Show>

            <Show when={resolvedThreads().length > 0}>
                <button
                    data-testid="resolved-threads"
                    onClick={() => setShowResolved(!showResolved())}
                    class="text-sub hover:text-main flex items-center gap-1 text-xs hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-sm">{showResolved() ? 'expand_less' : 'expand_more'}</span>
                    {resolvedThreads().length} resolved
                </button>
                <Show when={showResolved()}>
                    <For each={resolvedThreads()}>
                        {(thread) => (
                            <ThreadCard
                                thread={thread}
                                canManage={props.canManage}
                                busy={props.busy}
                                focused={props.focus === thread.root.id}
                                onFocus={() => props.onFocus(thread.root.id)}
                                onAdd={props.onAdd}
                                onResolved={props.onResolved}
                                onDelete={props.onDelete}
                            />
                        )}
                    </For>
                </Show>
            </Show>
        </div>
    )
}

// One thread: the remark, its replies, and what to do about it. An anchor that
// no longer resolves says so out loud and keeps the text it was left against,
// because a remark whose subject is gone still says something and quietly
// re-hanging it on whatever now sits at that index would say something else.
const ThreadCard: Component<{
    thread: DocumentThread
    canManage: boolean
    busy: boolean
    focused: boolean
    onFocus: () => void
    onAdd: (body: string, parentId?: string) => void
    onResolved: (root: ProjectDocumentComment, resolved: boolean) => void
    onDelete: (comment: ProjectDocumentComment) => void
}> = (props) => {
    const [replying, setReplying] = createSignal(false)
    return (
        <div
            data-testid="comment-thread"
            onClick={props.onFocus}
            class="border-element-accent flex flex-col gap-1.5 rounded-md border p-2.5 transition-colors"
            classList={{ 'border-highlight': props.focused, 'opacity-70': props.thread.root.resolved }}
        >
            <Show when={props.thread.at.match === 'orphaned'}>
                <span data-testid="comment-orphaned" class="text-sub/70 flex items-start gap-1 text-[11px] font-bold">
                    <span class="material-symbols-outlined text-[13px]">link_off</span>
                    Orphaned: the text this was left on is gone
                </span>
                <Show when={props.thread.root.anchor_text}>
                    <p class="text-sub/50 border-element-accent line-clamp-2 border-l-2 pl-2 text-[11px] italic">
                        {props.thread.root.anchor_text}
                    </p>
                </Show>
            </Show>
            <Show when={props.thread.at.match === 'edited'}>
                <span class="text-sub/60 text-[11px]">Edited since this was written.</span>
            </Show>

            <CommentRow comment={props.thread.root} canManage={props.canManage} onDelete={props.onDelete} />
            <For each={props.thread.replies}>
                {(reply) => (
                    <div class="border-element-accent border-l pl-2">
                        <CommentRow comment={reply} canManage={props.canManage} onDelete={props.onDelete} />
                    </div>
                )}
            </For>

            <Show when={props.canManage}>
                <Show
                    when={replying()}
                    fallback={
                        <div class="flex items-center gap-3 pt-0.5">
                            <button
                                onClick={() => setReplying(true)}
                                class="text-highlight text-xs font-bold hover:cursor-pointer hover:brightness-125"
                            >
                                Reply
                            </button>
                            <button
                                onClick={() => props.onResolved(props.thread.root, !props.thread.root.resolved)}
                                disabled={props.busy}
                                class="text-sub hover:text-main text-xs font-bold hover:cursor-pointer disabled:opacity-50"
                            >
                                {props.thread.root.resolved ? 'Reopen' : 'Resolve'}
                            </button>
                        </div>
                    }
                >
                    <CommentComposer
                        placeholder="Reply"
                        submitLabel="Reply"
                        busy={props.busy}
                        onSubmit={(body) => {
                            props.onAdd(body, props.thread.root.id)
                            setReplying(false)
                        }}
                        onCancel={() => setReplying(false)}
                    />
                </Show>
            </Show>
        </div>
    )
}

// A comment is a remark, not a document: plain text, wrapped as written, and
// deliberately not run through the embed pipeline. A remark about a document
// that renders another document inside itself is a second document.
const CommentRow: Component<{
    comment: ProjectDocumentComment
    canManage: boolean
    onDelete: (comment: ProjectDocumentComment) => void
}> = (props) => (
    <div class="group/comment flex flex-col gap-0.5">
        <div class="flex items-baseline gap-2">
            <span class="text-main text-xs font-bold">{userName(props.comment.author_id)}</span>
            <span class="text-sub/60 text-[11px]">{fmtWhen(props.comment.created_at)}</span>
            <Show when={props.canManage}>
                <button
                    onClick={(e) => {
                        e.stopPropagation()
                        props.onDelete(props.comment)
                    }}
                    title="Delete"
                    class="text-sub/50 hover:text-danger ml-auto opacity-0 transition-opacity group-hover/comment:opacity-100 hover:cursor-pointer no-hover:opacity-100"
                >
                    <span class="material-symbols-outlined text-[15px]">delete</span>
                </button>
            </Show>
        </div>
        <p class="text-sub text-xs whitespace-pre-wrap">{props.comment.body}</p>
    </div>
)

const CommentComposer: Component<{
    placeholder: string
    submitLabel: string
    busy: boolean
    onSubmit: (body: string) => void
    onCancel: () => void
}> = (props) => {
    const [draft, setDraft] = createSignal('')
    const submit = () => {
        const body = draft().trim()
        if (!body) return
        setDraft('')
        props.onSubmit(body)
    }
    return (
        <div class="flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
            <textarea
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                // Enter commits, the way every other one-line composer in the
                // module does; a remark needing more than one paragraph wants
                // Shift+Enter and gets it.
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        submit()
                    }
                    if (e.key === 'Escape') props.onCancel()
                }}
                ref={(el) => queueMicrotask(() => el.focus())}
                placeholder={props.placeholder}
                rows={2}
                class="bg-element-matte text-main border-element-accent focus:border-highlight placeholder:text-sub/50 w-full resize-y rounded-md border px-2 py-1.5 text-xs focus:outline-none"
            />
            <div class="flex items-center gap-2">
                <button
                    onClick={submit}
                    disabled={props.busy || !draft().trim()}
                    class="bg-highlight-strongest rounded-md px-2.5 py-1 text-xs text-white transition-[filter] hover:brightness-110 hover:cursor-pointer disabled:opacity-40"
                >
                    {props.submitLabel}
                </button>
                <button onClick={props.onCancel} class="text-sub hover:text-main text-xs hover:cursor-pointer">
                    Cancel
                </button>
            </div>
        </div>
    )
}

// One document, read or written through the shared pipeline: MomentBody in read
// mode, the same Editor a moment uses in write mode, saved on the brief's
// debounce. The tools around it are the ones a reference document wants and a
// card does not: an outline, a size, version snapshots, and comments hung off
// the blocks of the body.
const DocumentView: Component<
    DocumentsHandlers & {
        document: ProjectDocument
        project: Project
        canManage: boolean
        accent: string
        trail: ProjectDocument[]
        onClose: () => void
        onOpenFolder: (id: string | null) => void
    }
> = (props) => {
    const ui = useUI()
    const [editing, setEditing] = createSignal(false)
    const [outlineOpen, setOutlineOpen] = createSignal(false)
    const [versionsOpen, setVersionsOpen] = createSignal(false)
    const [commentsOpen, setCommentsOpen] = createSignal(false)
    const [comments, setComments] = createSignal<ProjectDocumentComment[]>([])
    const [draftBlock, setDraftBlock] = createSignal<number | null>(null)
    const [focusThread, setFocusThread] = createSignal<string | null>(null)
    const [busy, setBusy] = createSignal(false)
    const headings = () => documentOutline(props.document.body || '')
    const words = () => documentWordCount(props.document.body || '')
    const locked = () => props.document.status === 'locked'
    // Draft is the writing state and the only one that opens the editor. Final
    // and Locked both read; the difference is that Final is one tap from being
    // written again and Locked is refused by the server until it is lifted.
    const editable = () => props.canManage && props.document.status === 'draft'
    const blocks = () => documentBlocks(props.document.body || '')
    let readEl: HTMLDivElement | undefined
    // The editor's own box, which is what "outside the text" is measured
    // against. The column around it is not: the padding under a short editor
    // is as much outside the writing as the header is.
    let editorEl: HTMLDivElement | undefined
    // A press away finishes the writing, and the click that completes that
    // press lands on the read view a moment later. It was aimed at leaving,
    // not at the paragraph underneath, so it must not open the editor again.
    // Recomputed on every press and consumed by the click, so it cannot go
    // stale in either direction.
    let leavingOnClick = false

    // Embeds render their own headings inside a card; those are not this
    // document's outline, so they are skipped on the way to the nth one.
    //
    // Scrolled by hand rather than with scrollIntoView, which moves every
    // scrollable ancestor until the heading is in view. The panel root is
    // overflow-hidden, which script can scroll perfectly well and the reader
    // has no scrollbar to put back, so the outline used to slide the whole
    // module up under its own clipped edge. Only the column should move.
    const scrollToHeading = (index: number) => {
        setOutlineOpen(false)
        const found = [...(readEl?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? [])].filter((h) => !h.closest('[data-embed-card]'))
        const heading = found[index]
        if (!heading || !readEl) return
        const top = heading.getBoundingClientRect().top - readEl.getBoundingClientRect().top + readEl.scrollTop
        // A little room above it, so the heading does not sit on the edge.
        readEl.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' })
    }

    const stopEditing = () => {
        props.onBodyFlush()
        setEditing(false)
    }

    // A draft is written by clicking it, which is the whole of what the Edit
    // button used to do. A click that lands on something with a job of its own
    // (a link, an embed card, a comment control) does that job instead, and a
    // click that finished a selection leaves the selection alone rather than
    // swapping the text out from under it.
    const startEditing = (e: MouseEvent) => {
        if (leavingOnClick) {
            leavingOnClick = false
            return
        }
        if (!editable() || editing()) return
        const target = e.target as HTMLElement | null
        if (target?.closest('a, button, input, textarea, select, [role="button"], [data-embed-card]')) return
        if (window.getSelection()?.toString()) return
        setEditing(true)
    }

    // Locking is a status-only write, which is the one thing the server accepts
    // from a locked document. Anything still in flight has to land first, or
    // the lock would arrive ahead of the edit it was meant to freeze.
    const setStatus = (status: ProjectDocumentStatus) => {
        if (status === props.document.status) return
        props.onBodyFlush()
        if (status === 'locked') setEditing(false)
        props.onStatus(props.document.id, status)
    }
    // The lock is enforced server-side; refusing to open the editor is what
    // keeps a reader from typing into text that will not be saved. Final is
    // refused here alone, which is the point of it.
    createEffect(() => !editable() && setEditing(false))

    // --- comments ---
    // Loaded with the open document rather than with the project: a tab full of
    // tiles pays only for the open_comments count in the payload.
    const loadComments = async (documentId: string) => {
        try {
            setComments((await api.listProjectDocumentComments(documentId)) ?? [])
        } catch (err) {
            console.error('Failed to load the comments:', err)
            ui.toast('Could not load the comments.', 'error')
            setComments([])
        }
    }
    onMount(() => void loadUsers())
    createEffect(
        on(
            () => props.document.id,
            (id) => {
                setComments([])
                setDraftBlock(null)
                setFocusThread(null)
                void loadComments(id)
            },
        ),
    )

    // The tile behind the open document badges the open threads, so every
    // change here has to reach the store the grid reads from.
    const commit = (next: ProjectDocumentComment[]) => {
        setComments(next)
        props.onCommentsChanged(
            props.document.id,
            next.filter((c) => !c.parent_id && !c.resolved).length,
        )
    }

    const threads = () => documentThreads(comments(), blocks())
    const threadsAt = (index: number) => threads().filter((t) => t.at.index === index)

    const startDraft = (index: number) => {
        setCommentsOpen(true)
        setFocusThread(null)
        setDraftBlock(index)
    }
    const focusBlock = (index: number) => {
        setCommentsOpen(true)
        setDraftBlock(null)
        setFocusThread(threadsAt(index)[0]?.root.id ?? null)
    }

    const addComment = async (body: string, parentId?: string) => {
        const index = parentId ? 0 : (draftBlock() ?? 0)
        setBusy(true)
        try {
            const created = await api.createProjectDocumentComment(props.document.id, {
                body,
                parent_id: parentId,
                anchor_index: index,
                anchor_text: blocks()[index]?.fingerprint ?? '',
            })
            commit([...comments(), created])
            setDraftBlock(null)
            setFocusThread(created.parent_id || created.id)
        } catch (err) {
            console.error('Failed to add the comment:', err)
            ui.toast('Could not add the comment.', 'error')
        } finally {
            setBusy(false)
        }
    }

    const setResolved = async (root: ProjectDocumentComment, resolved: boolean) => {
        setBusy(true)
        try {
            const updated = await api.updateProjectDocumentComment(root.id, { resolved })
            commit(comments().map((c) => (c.id === updated.id ? updated : c)))
        } catch (err) {
            console.error('Failed to resolve the thread:', err)
            ui.toast('Could not update the thread.', 'error')
        } finally {
            setBusy(false)
        }
    }

    const removeComment = async (comment: ProjectDocumentComment) => {
        const ok = await ui.confirm({
            title: comment.parent_id ? 'Delete this reply?' : 'Delete this thread?',
            message: comment.parent_id ? 'It goes for good.' : 'The comment and every reply to it go for good.',
            confirmLabel: 'Delete',
            danger: true,
        })
        if (!ok) return
        setBusy(true)
        try {
            const removed = (await api.deleteProjectDocumentComment(comment.id)).comments ?? [comment]
            const gone = new Set(removed.map((c) => c.id))
            commit(comments().filter((c) => !gone.has(c.id)))
        } catch (err) {
            console.error('Failed to delete the comment:', err)
            ui.toast('Could not delete it.', 'error')
        } finally {
            setBusy(false)
        }
    }

    const commentsProps = () => ({
        threads: threads(),
        blocks: blocks(),
        canManage: props.canManage,
        busy: busy(),
        draftBlock: draftBlock(),
        focus: focusThread(),
        onFocus: setFocusThread,
        onCancelDraft: () => setDraftBlock(null),
        onAdd: (body: string, parentId?: string) => void addComment(body, parentId),
        onResolved: (root: ProjectDocumentComment, resolved: boolean) => void setResolved(root, resolved),
        onDelete: (comment: ProjectDocumentComment) => void removeComment(comment),
    })

    return (
        // Plain ground. The panel's bookcase watermark is a -z-10 layer under
        // everything it holds; the tiles in the grid cover it because they are
        // bg-element, but the reading column has no background of its own and
        // the editor's textarea is transparent, so the shelves ran straight
        // under the text. A document is a page, and pages are not textured.
        <div
            data-testid="document-view"
            class="flex min-h-0 flex-1 flex-col"
            style={{ 'background-color': 'var(--theme-bg)' }}
            // A press on anything outside the editor finishes the writing:
            // the header, the outline rail, the footer, the room around the
            // text. Bound to this root rather than to the window so the
            // editor's own portalled menus (the embed picker, the slash
            // dialog) are never mistaken for a press away.
            onPointerDown={(e) => {
                leavingOnClick = editing() && !editorEl?.contains(e.target as Node)
                if (leavingOnClick) stopEditing()
            }}
        >
            <div class="border-element-accent flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-3 sm:px-5">
                {/* The icon-only buttons along this row are flex boxes, not
                    the inline-block a bare button would be: a button inherits
                    the look's line height, and an inline icon inside that line
                    box sits on its baseline with the half-leading below it, so
                    the glyph rides a few pixels above the padded controls it
                    sits beside. Flex makes the button the height of the icon,
                    and the row centres what you can actually see. */}
                <button
                    onClick={props.onClose}
                    class="text-sub hover:text-main flex shrink-0 items-center hover:cursor-pointer"
                    title="Back to the folder"
                >
                    <span class="material-symbols-outlined">arrow_back</span>
                </button>
                <button
                    onClick={() => props.onOpenFolder(null)}
                    class="text-sub hover:text-main shrink-0 text-xs transition-colors hover:cursor-pointer"
                >
                    {DOCUMENTS_ROOT}
                </button>
                <For each={props.trail}>
                    {(folder) => (
                        <>
                            <span class="text-sub/40 text-xs">/</span>
                            <button
                                onClick={() => props.onOpenFolder(folder.id)}
                                class="text-sub hover:text-main max-w-32 shrink-0 truncate text-xs transition-colors hover:cursor-pointer"
                            >
                                {folder.title || 'Untitled folder'}
                            </button>
                        </>
                    )}
                </For>
                <Show
                    when={props.canManage && !locked()}
                    fallback={<span class="text-main font-serif min-w-0 flex-1 truncate text-xl font-semibold">{props.document.title}</span>}
                >
                    <input
                        type="text"
                        value={props.document.title}
                        onChange={(e) => props.onRename(props.document.id, e.currentTarget.value.trim() || 'Untitled document')}
                        title="Rename document"
                        class="text-main font-serif hover:border-element-accent focus:border-highlight min-w-0 flex-1 basis-40 rounded-md border border-transparent bg-transparent px-2 py-1 text-xl font-semibold transition-colors focus:outline-none"
                    />
                </Show>
                {/* The status control follows the module's segmented idiom, the
                    one the card modal writes and previews with, and it is also
                    the read/write switch: Draft types, Final and Locked read.
                    Leaving Locked is a tap on Draft or Final and nothing else:
                    the server refuses a patch that unlocks and edits at once,
                    and hiding that behind an edit would only move the refusal. */}
                <Show when={props.canManage} fallback={<DocumentStatusBadge status={props.document.status} />}>
                    <div data-testid="document-status" class="border-element-accent flex shrink-0 overflow-hidden rounded-md border">
                        <For each={DOCUMENT_STATUSES}>
                            {(status) => (
                                <button
                                    onClick={() => setStatus(status.v)}
                                    title={locked() && status.v !== 'locked' ? `Unlock, back to ${status.label}.` : status.hint}
                                    class="flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors hover:cursor-pointer"
                                    classList={{
                                        'bg-highlight-strongest text-white': props.document.status === status.v,
                                        'text-sub hover:text-main': props.document.status !== status.v,
                                    }}
                                >
                                    {/* The ligature text is decoration; leaving
                                        it in the accessible name would make
                                        "Draft" read as "edit_note Draft". */}
                                    <span aria-hidden="true" class="material-symbols-outlined text-sm">
                                        {status.icon}
                                    </span>
                                    {status.label}
                                </button>
                            )}
                        </For>
                    </div>
                </Show>
                <button
                    onClick={() => setOutlineOpen(!outlineOpen())}
                    title="Outline"
                    class="flex shrink-0 items-center transition-colors hover:cursor-pointer xl:hidden"
                    classList={{ 'text-highlight': outlineOpen(), 'text-sub hover:text-main': !outlineOpen() }}
                >
                    <span class="material-symbols-outlined">toc</span>
                </button>
                {/* The rail carries the comments on a wide screen, so this is
                    the phone's way in, exactly as the outline button is. */}
                <button
                    onClick={() => setCommentsOpen(!commentsOpen())}
                    title="Comments"
                    class="relative flex shrink-0 items-center transition-colors hover:cursor-pointer xl:hidden"
                    classList={{ 'text-highlight': commentsOpen(), 'text-sub hover:text-main': !commentsOpen() }}
                >
                    <span class="material-symbols-outlined">chat_bubble</span>
                    <Show when={openThreadCount(threads()) > 0}>
                        <span class="bg-highlight-strongest absolute -top-1 -right-1 min-w-4 rounded-full px-1 text-[10px] font-bold text-white">
                            {openThreadCount(threads())}
                        </span>
                    </Show>
                </button>
                <button
                    onClick={() => {
                        props.onBodyFlush()
                        setVersionsOpen(true)
                    }}
                    title="Versions"
                    class="text-sub hover:text-main flex shrink-0 items-center transition-colors hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined">history</span>
                </button>
                {/* No Edit button: the status is the mode. What stood here was
                    a second answer to the same question, and the one the
                    document did not remember. */}
                <Show when={props.canManage}>
                    <button
                        onClick={() => props.onDelete(props.document)}
                        title="Delete document"
                        class="text-sub hover:text-danger flex shrink-0 items-center transition-colors hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                </Show>
            </div>

            {/* The phone has no room for a rail, so the outline is a panel the
                toc button drops down over the top of the body. */}
            <Show when={outlineOpen()}>
                <div class="border-element-accent bg-element border-b px-4 py-3 xl:hidden">
                    <DocumentOutline headings={headings()} onPick={scrollToHeading} />
                </div>
            </Show>

            {/* The phone's comments sheet. The rail below carries the same
                threads on a screen wide enough to hold one. */}
            <Show when={commentsOpen()}>
                <div
                    data-testid="document-comments-sheet"
                    class="border-element-accent bg-element max-h-80 overflow-y-auto border-b px-4 py-3 xl:hidden"
                >
                    <DocumentComments {...commentsProps()} />
                </div>
            </Show>

            <div class="flex min-h-0 flex-1 flex-col xl:flex-row">
                <div
                    ref={readEl}
                    data-testid="document-body"
                    class="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8"
                    classList={{ 'cursor-text': editable() && !editing() }}
                    onClick={startEditing}
                    // Escape finishes. Claimed with preventDefault, the way
                    // every layer inside a modal claims it, so the panel behind
                    // does not read the same key as a request to close; skipped
                    // when a menu in the editor has already answered it.
                    onKeyDown={(e) => {
                        if (e.key !== 'Escape' || e.defaultPrevented || !editing()) return
                        e.preventDefault()
                        stopEditing()
                    }}
                >
                    <Show when={locked()}>
                        <p
                            data-testid="document-locked"
                            class="border-highlight/40 text-sub bg-element mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
                        >
                            <span class="material-symbols-outlined text-highlight text-base">lock</span>
                            {props.canManage
                                ? 'Locked. Only commenting is allowed.'
                                : 'Locked. This document may not be edited.'}
                        </p>
                    </Show>
                    <Show
                        when={!editing()}
                        fallback={
                            <div ref={editorEl} data-testid="document-editor">
                                <Editor
                                    chrome="body"
                                    initialContent={props.document.body}
                                    placeholder="The document. Markdown; [[ embeds a moment, to-do, canvas, project, document or your agenda; paste or drop images."
                                    onChange={(value) => props.onBodyChange(props.document.id, value)}
                                    onSubmit={async () => stopEditing()}
                                />
                            </div>
                        }
                    >
                        <Show
                            when={props.document.body.trim()}
                            fallback={
                                <p class="text-sub/60 text-sm italic">
                                    {editable() ? 'Empty document. Click here to start writing.' : 'Empty document.'}
                                </p>
                            }
                        >
                            {/* Read mode draws the body a block at a time so a
                                comment has something to hang off. Each block
                                still runs the whole moment pipeline, so embeds,
                                code and images render exactly as they do in a
                                moment. */}
                            <div class="flex w-full flex-col gap-2">
                                <For each={blocks()}>
                                    {(block) => (
                                        <div class="group/block flex items-start gap-1">
                                            <div class="min-w-0 flex-1">
                                                <MomentBody
                                                    content={block.text}
                                                    onOpenMoment={props.onOpenMoment}
                                                    onOpenTodo={props.onOpenTodo}
                                                    onOpenCanvas={props.onOpenCanvas}
                                                    onOpenProject={props.onOpenProject}
                                                    onOpenDoc={props.onOpenDoc}
                                                />
                                            </div>
                                            <div class="flex w-7 shrink-0 flex-col items-center gap-1 pt-1">
                                                <Show when={threadsAt(block.index).length > 0}>
                                                    <button
                                                        data-testid="comment-marker"
                                                        onClick={() => focusBlock(block.index)}
                                                        title={`${threadsAt(block.index).length} comment${threadsAt(block.index).length === 1 ? '' : 's'} on this block`}
                                                        class="flex flex-col items-center hover:cursor-pointer"
                                                        classList={{
                                                            'text-highlight': threadsAt(block.index).some((t) => !t.root.resolved),
                                                            'text-sub/40': threadsAt(block.index).every((t) => t.root.resolved),
                                                        }}
                                                    >
                                                        <span class="material-symbols-outlined text-base">chat_bubble</span>
                                                        <span class="text-[10px] font-bold">{threadsAt(block.index).length}</span>
                                                    </button>
                                                </Show>
                                                <Show when={props.canManage}>
                                                    <button
                                                        data-testid="add-comment"
                                                        onClick={() => startDraft(block.index)}
                                                        title="Comment on this block"
                                                        class="text-sub/50 hover:text-main opacity-0 transition-opacity group-hover/block:opacity-100 hover:cursor-pointer focus:opacity-100 no-hover:opacity-100"
                                                    >
                                                        <span class="material-symbols-outlined text-base">add_comment</span>
                                                    </button>
                                                </Show>
                                            </div>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </Show>
                </div>
                <aside class="border-element-accent hidden w-72 shrink-0 overflow-y-auto border-l p-4 xl:block">
                    <p class="text-sub mb-2 text-xs font-medium">Outline</p>
                    <DocumentOutline headings={headings()} onPick={scrollToHeading} />
                    <p class="text-sub mt-6 mb-2 text-xs font-medium">Comments</p>
                    <div data-testid="document-comments-rail">
                        <DocumentComments {...commentsProps()} />
                    </div>
                </aside>
            </div>

            <div class="border-element-accent text-sub/70 flex flex-wrap items-center gap-x-3 border-t px-4 py-2 text-xs sm:px-5">
                <span data-testid="document-word-count">
                    {words()} word{words() === 1 ? '' : 's'}
                </span>
                <Show when={words() > 0}>
                    <span>{readingMinutes(words())} min read</span>
                </Show>
                {/* The only place either instruction is written down, now that
                    the mode is the status and the way in is the text itself. */}
                <Show when={editable()}>
                    <span data-testid="document-edit-hint">{editing() ? 'Esc finishes' : 'Click the text to write'}</span>
                </Show>
                <span class="ml-auto">Updated {fmtWhen(props.document.updated_at)}</span>
            </div>

            <Show when={versionsOpen()}>
                <DocumentVersionsModal
                    document={props.document}
                    canManage={props.canManage}
                    locked={locked()}
                    onClose={() => setVersionsOpen(false)}
                    onRestored={(doc) => {
                        props.onRestored(doc)
                        setEditing(false)
                    }}
                    onOpenMoment={props.onOpenMoment}
                    onOpenTodo={props.onOpenTodo}
                    onOpenCanvas={props.onOpenCanvas}
                    onOpenProject={props.onOpenProject}
                    onOpenDoc={props.onOpenDoc}
                />
            </Show>
        </div>
    )
}

// The version history: snapshots taken by hand and automatically (at most once
// an hour, server-side) on a meaningful edit. Restoring snapshots the current
// state first, which is what makes a restore itself undoable and why the panel
// says so out loud.
const DocumentVersionsModal: Component<{
    document: ProjectDocument
    canManage: boolean
    // A restore rewrites the title and body, so a locked document refuses it
    // for the same reason it refuses an edit. Snapshotting is still allowed:
    // taking a copy of a frozen document changes nothing about it.
    locked: boolean
    onClose: () => void
    onRestored: (doc: ProjectDocument) => void
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
    onOpenDoc?: (id: string, projectId: string) => void
}> = (props) => {
    const ui = useUI()
    const [versions, setVersions] = createSignal<ProjectDocumentVersion[] | null>(null)
    const [viewing, setViewing] = createSignal<ProjectDocumentVersion | null>(null)
    const [busy, setBusy] = createSignal(false)

    const load = async () => {
        try {
            setVersions((await api.listProjectDocumentVersions(props.document.id)) ?? [])
        } catch (err) {
            console.error('Failed to list versions:', err)
            ui.toast('Could not load the versions.', 'error')
            setVersions([])
        }
    }
    onMount(() => {
        void loadUsers()
        void load()
    })

    const saveVersion = async () => {
        setBusy(true)
        try {
            await api.createProjectDocumentVersion(props.document.id)
            await load()
            ui.toast('Version saved.', 'success')
        } catch (err) {
            console.error('Failed to save a version:', err)
            ui.toast('Could not save a version.', 'error')
        } finally {
            setBusy(false)
        }
    }

    const view = async (version: ProjectDocumentVersion) => {
        try {
            setViewing((await api.getProjectDocumentVersion(version.id)) ?? null)
        } catch (err) {
            console.error('Failed to open a version:', err)
            ui.toast('Could not open that version.', 'error')
        }
    }

    const restore = async (version: ProjectDocumentVersion) => {
        const ok = await ui.confirm({
            title: 'Restore this version?',
            message: 'The document as it stands is saved as a version first, so this is undoable from this list.',
            confirmLabel: 'Restore',
        })
        if (!ok) return
        setBusy(true)
        try {
            const restored = await api.restoreProjectDocumentVersion(version.id)
            props.onRestored(restored)
            clearProjectDocumentCache()
            setViewing(null)
            await load()
            ui.toast('Version restored.', 'success')
        } catch (err) {
            console.error('Failed to restore a version:', err)
            ui.toast(
                err instanceof APIError && err.status === 409
                    ? 'That document is locked. Unlock it to restore a version.'
                    : 'Could not restore that version.',
                'error',
            )
        } finally {
            setBusy(false)
        }
    }

    return (
        <Modal onClose={props.onClose} layer="editor" scrim="heavy" class="animate-fade-in p-4 backdrop-blur-sm">
            <div
                data-testid="document-versions"
                class="bg-element-matte border-element-accent flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border shadow-2xl"
            >
                <div class="bg-element border-element-accent flex items-center gap-3 border-b px-4 py-3 sm:px-6">
                    <span class="material-symbols-outlined text-sub">history</span>
                    {/* The name goes under the heading rather than into it:
                        one line holding both truncates to "Versions of ..." on
                        a phone, which names neither thing. */}
                    <div class="min-w-0 flex-1">
                        <h3 class="text-main font-serif text-lg font-semibold">Versions</h3>
                        <p class="text-sub/70 truncate text-xs">{props.document.title}</p>
                    </div>
                    <Show when={props.locked}>
                        <span
                            data-testid="versions-locked"
                            class="border-highlight/50 text-highlight flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-bold"
                        >
                            <span class="material-symbols-outlined text-[13px]">lock</span>
                            Locked
                        </span>
                    </Show>
                    <Show when={props.canManage}>
                        <button
                            onClick={() => void saveVersion()}
                            disabled={busy()}
                            class="bg-highlight-strongest flex shrink-0 items-center gap-1 rounded-md px-3 py-1.5 text-xs text-white transition-[filter] hover:brightness-110 hover:cursor-pointer disabled:opacity-50"
                        >
                            <span class="material-symbols-outlined text-sm">bookmark_add</span>
                            Save version
                        </button>
                    </Show>
                    <button onClick={props.onClose} class="text-sub hover:text-main shrink-0 hover:cursor-pointer" title="Close">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>

                <div class="flex min-h-0 flex-1 flex-col overflow-y-auto sm:flex-row sm:overflow-hidden">
                    <div class="border-element-accent flex w-full shrink-0 flex-col gap-1.5 p-3 sm:w-72 sm:overflow-y-auto sm:border-r">
                        <Show when={versions()} fallback={<p class="text-sub/60 p-2 text-sm">Loading…</p>}>
                            {(list) => (
                                <Show
                                    when={list().length > 0}
                                    fallback={
                                        <p class="text-sub/60 p-2 text-sm italic">
                                            No versions yet. Save one, or let an edit take its own snapshot.
                                        </p>
                                    }
                                >
                                    <For each={list()}>
                                        {(version) => (
                                            <div
                                                class="border-element-accent hover:border-highlight/60 flex flex-col gap-1 rounded-md border p-2.5 transition-colors"
                                                classList={{ 'border-highlight': viewing()?.id === version.id }}
                                            >
                                                <span class="text-main truncate text-sm">{version.title || 'Untitled'}</span>
                                                <span class="text-sub/70 text-xs">
                                                    {fmtWhen(version.created_at)} · {userName(version.author_id)}
                                                </span>
                                                <div class="flex items-center gap-3 pt-0.5">
                                                    <button
                                                        onClick={() => void view(version)}
                                                        class="text-highlight text-xs font-bold hover:cursor-pointer hover:brightness-125"
                                                    >
                                                        View
                                                    </button>
                                                    <Show when={props.canManage}>
                                                        <button
                                                            onClick={() => void restore(version)}
                                                            disabled={busy() || props.locked}
                                                            title={props.locked ? 'Locked. Unlock the document to restore a version.' : undefined}
                                                            class="text-sub hover:text-main text-xs font-bold hover:cursor-pointer disabled:cursor-default disabled:opacity-40"
                                                        >
                                                            Restore
                                                        </button>
                                                    </Show>
                                                </div>
                                            </div>
                                        )}
                                    </For>
                                </Show>
                            )}
                        </Show>
                    </div>

                    <div class="min-w-0 flex-1 p-4 sm:overflow-y-auto sm:p-6">
                        <Show
                            when={viewing()}
                            fallback={
                                <p class="text-sub/60 text-sm italic">
                                    <Show
                                        when={props.locked}
                                        fallback="Pick a version to read it here. Restoring one saves the current state first, so nothing is lost either way."
                                    >
                                        Pick a version to read it here. Restoring is off while the document is locked, since a restore rewrites the
                                        title and body: unlock it first.
                                    </Show>
                                </p>
                            }
                        >
                            {(version) => (
                                <>
                                    <p class="text-sub/70 mb-3 text-xs">
                                        {fmtWhen(version().created_at)} · {userName(version().author_id)} · read only
                                    </p>
                                    <Show
                                        when={(version().body || '').trim()}
                                        fallback={<p class="text-sub/60 text-sm italic">This version was empty.</p>}
                                    >
                                        <MomentBody
                                            content={version().body || ''}
                                            onOpenMoment={props.onOpenMoment}
                                            onOpenTodo={props.onOpenTodo}
                                            onOpenCanvas={props.onOpenCanvas}
                                            onOpenProject={props.onOpenProject}
                                            onOpenDoc={props.onOpenDoc}
                                        />
                                    </Show>
                                </>
                            )}
                        </Show>
                    </div>
                </div>
            </div>
        </Modal>
    )
}

// ---- card modal ----

const CardModal: Component<{
    card: ProjectCard
    project: Project
    canManage: boolean
    patch: (optimistic: (c: ProjectCard) => void, body: Parameters<typeof api.updateProjectCard>[1]) => void
    onDismiss: () => void
    onClose: () => void
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
    onOpenDoc?: (id: string, projectId: string) => void
}> = (props) => {
    // A card with a body opens on the rendered page; an empty one opens ready
    // to write.
    const [preview, setPreview] = createSignal(props.card.body.trim().length > 0 || !props.canManage)
    const [labelDraft, setLabelDraft] = createSignal('')

    // The editor owns the text while writing; it lands in the store and the
    // API together after a pause in the typing, and always before a preview
    // switch or close.
    let bodyTimer: ReturnType<typeof setTimeout> | undefined
    let bodyDraft: string | null = null
    const bodyFlush = () => {
        clearTimeout(bodyTimer)
        if (bodyDraft === null) return
        const v = bodyDraft
        bodyDraft = null
        props.patch((c) => (c.body = v), { body: v })
    }
    const bodyChange = (v: string) => {
        bodyDraft = v
        clearTimeout(bodyTimer)
        bodyTimer = setTimeout(bodyFlush, 800)
    }
    onCleanup(bodyFlush)

    const addLabel = () => {
        const name = labelDraft().trim()
        if (!name) return
        const labels = [...new Set([...splitLabels(props.card.labels), name])].join(',')
        props.patch((c) => (c.labels = labels), { labels })
        setLabelDraft('')
    }
    const removeLabel = (name: string) => {
        const labels = splitLabels(props.card.labels)
            .filter((l) => l !== name)
            .join(',')
        props.patch((c) => (c.labels = labels), { labels })
    }

    // A rail control's label. Structure over decoration: the rail reads as a
    // labelled form column, like Linear's issue sidebar.
    const RailLabel: Component<{ text: string }> = (l) => <p class="text-sub mb-1.5 text-xs font-medium">{l.text}</p>

    return (
        <Modal onClose={props.onClose} layer="editor" scrim="heavy" class="animate-fade-in p-4 backdrop-blur-sm">
            <div
                data-testid="project-card-modal"
                class={`bg-element-matte border-element-accent flex h-[88vh] w-full flex-col overflow-hidden rounded-xl border shadow-2xl ${MODAL_WIDTH_CLASS[prefs().projectCardWidth]}`}
            >
                <div class="bg-element border-element-accent flex items-center gap-2 border-b px-4 py-3 sm:gap-3 sm:px-6 sm:py-4">
                    <span class="shrink-0 font-mono text-xs font-bold" style={{ color: props.project.accent }}>
                        {keyOf(props.project)}-{cardNum(props.project, props.card.id)}
                    </span>
                    <Show
                        when={props.canManage}
                        fallback={<span class="text-main font-serif min-w-0 flex-1 truncate text-xl font-semibold">{props.card.title}</span>}
                    >
                        <input
                            type="text"
                            value={props.card.title}
                            onChange={(e) => props.patch((c) => (c.title = e.currentTarget.value), { title: e.currentTarget.value })}
                            class="text-main font-serif hover:border-element-accent focus:border-highlight min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-xl font-semibold transition-colors focus:outline-none"
                        />
                    </Show>
                    <Show when={props.canManage}>
                        <div class="border-element-accent flex shrink-0 overflow-hidden rounded-md border">
                            <button
                                onClick={() => {
                                    bodyFlush()
                                    setPreview(false)
                                }}
                                class="px-3 py-1.5 text-xs transition-colors hover:cursor-pointer"
                                classList={{ 'bg-highlight-strongest text-white': !preview(), 'text-sub hover:text-main': preview() }}
                            >
                                Write
                            </button>
                            <button
                                onClick={() => {
                                    bodyFlush()
                                    setPreview(true)
                                }}
                                class="px-3 py-1.5 text-xs transition-colors hover:cursor-pointer"
                                classList={{ 'bg-highlight-strongest text-white': preview(), 'text-sub hover:text-main': !preview() }}
                            >
                                Preview
                            </button>
                        </div>
                    </Show>
                    <button onClick={props.onClose} class="text-sub hover:text-main shrink-0 hover:cursor-pointer" title="Close">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>

                {/* Side-by-side panes on desktop; on a phone the rail stacks
                    under the body and the whole modal scrolls as one page. */}
                <div class="flex min-h-0 flex-1 flex-col overflow-y-auto sm:flex-row sm:overflow-hidden">
                    <div class="flex min-w-0 flex-col p-4 sm:flex-1 sm:overflow-y-auto sm:p-6">
                        <Show
                            when={!preview()}
                            fallback={
                                <Show
                                    when={props.card.body.trim()}
                                    fallback={
                                        <p class="text-sub/60 text-sm italic">
                                            {props.canManage
                                                ? 'No body yet. Write starts it; / embeds a to-do, canvas, moment, project or document.'
                                                : 'No body.'}
                                        </p>
                                    }
                                >
                                    <MomentBody
                                        content={props.card.body}
                                        onOpenMoment={props.onOpenMoment}
                                        onOpenTodo={props.onOpenTodo}
                                        onOpenCanvas={props.onOpenCanvas}
                                        onOpenProject={props.onOpenProject}
                                        onOpenDoc={props.onOpenDoc}
                                    />
                                </Show>
                            }
                        >
                            <Editor
                                chrome="body"
                                initialContent={props.card.body}
                                placeholder="The card's body. Markdown; [[ embeds a moment, to-do, canvas, project, document or your agenda; paste or drop images."
                                onChange={bodyChange}
                                onSubmit={async () => {
                                    bodyFlush()
                                    setPreview(true)
                                }}
                            />
                        </Show>
                    </div>

                    <div class="border-element-accent bg-element/40 flex w-full shrink-0 flex-col gap-5 border-t p-5 sm:w-72 sm:overflow-y-auto sm:border-t-0 sm:border-l">
                        <div>
                            <RailLabel text="Status" />
                            <button
                                onClick={() => props.canManage && props.patch((c) => (c.done = !c.done), { done: !props.card.done })}
                                disabled={!props.canManage}
                                class="border-element-accent flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:cursor-pointer disabled:cursor-default"
                                classList={{ 'hover:border-highlight': props.canManage }}
                            >
                                <span
                                    class="material-symbols-outlined text-lg"
                                    style={props.card.done ? { color: props.project.accent } : {}}
                                    classList={{ 'text-sub': !props.card.done }}
                                >
                                    {props.card.done ? 'check_circle' : 'radio_button_unchecked'}
                                </span>
                                <span class="text-main">{props.card.done ? 'Done' : 'Open'}</span>
                                <Show when={props.canManage}>
                                    <span class="text-sub/60 ml-auto text-xs">{props.card.done ? 'reopen' : 'finish'}</span>
                                </Show>
                            </button>
                        </div>

                        <div>
                            <RailLabel text="Priority" />
                            <div class="grid grid-cols-4 gap-1.5">
                                <For each={PRIORITIES}>
                                    {(p) => (
                                        <button
                                            onClick={() => props.canManage && props.patch((c) => (c.priority = p.v), { priority: p.v })}
                                            disabled={!props.canManage}
                                            class="rounded-md px-1 py-1.5 text-xs font-bold hover:cursor-pointer disabled:cursor-default"
                                            style={{
                                                'background-color': props.card.priority === p.v && p.color ? p.color : 'transparent',
                                                color: props.card.priority === p.v ? (p.color ? '#1a1a2e' : 'var(--theme-text-main)') : p.color || 'var(--theme-text-sub)',
                                                border: `1px solid ${p.color || 'var(--theme-element-accent)'}`,
                                            }}
                                        >
                                            {p.label}
                                        </button>
                                    )}
                                </For>
                            </div>
                        </div>

                        <div>
                            <RailLabel text="Due" />
                            <input
                                type="date"
                                value={isoToDateInput(props.card.due_at)}
                                disabled={!props.canManage}
                                onChange={(e) =>
                                    props.patch(
                                        (c) => (c.due_at = e.currentTarget.value ? dateInputToIso(e.currentTarget.value) : undefined),
                                        { due_at: e.currentTarget.value ? dateInputToIso(e.currentTarget.value) : '' },
                                    )
                                }
                                class="bg-element text-main border-element-accent focus:border-highlight w-full rounded-md border px-3 py-2 text-sm focus:outline-none"
                                classList={{ 'text-danger': cardOverdue(props.card) }}
                            />
                        </div>

                        <div>
                            <RailLabel text="Milestone" />
                            <Show
                                when={props.canManage}
                                fallback={
                                    <span class="text-main text-sm">{props.project.milestones.find((m) => m.id === props.card.milestone_id)?.title}</span>
                                }
                            >
                                <select
                                    value={props.card.milestone_id}
                                    onChange={(e) => {
                                        const msId = e.currentTarget.value
                                        props.patch((c) => (c.milestone_id = msId), { milestone_id: msId })
                                    }}
                                    class="bg-element text-main border-element-accent focus:border-highlight w-full rounded-md border px-3 py-2 text-sm focus:outline-none hover:cursor-pointer"
                                >
                                    <For each={msOrder(props.project)}>
                                        {(m) => (
                                            <option value={m.id} selected={m.id === props.card.milestone_id}>
                                                {m.title}
                                            </option>
                                        )}
                                    </For>
                                </select>
                            </Show>
                        </div>

                        <div>
                            <RailLabel text="Labels" />
                            <div class="flex flex-wrap items-center gap-1.5">
                                <For each={splitLabels(props.card.labels)}>
                                    {(l) => (
                                        <span class="flex items-center gap-0.5">
                                            <LabelChip name={l} />
                                            <Show when={props.canManage}>
                                                <button onClick={() => removeLabel(l)} class="text-sub/50 hover:text-danger hover:cursor-pointer" title={`Remove ${l}`}>
                                                    <span class="material-symbols-outlined text-[12px]">close</span>
                                                </button>
                                            </Show>
                                        </span>
                                    )}
                                </For>
                            </div>
                            <Show when={props.canManage}>
                                <input
                                    type="text"
                                    value={labelDraft()}
                                    onInput={(e) => setLabelDraft(e.currentTarget.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && addLabel()}
                                    placeholder="Add label, Enter commits"
                                    class="bg-element text-main border-element-accent focus:border-highlight placeholder:text-sub/50 mt-2 w-full rounded-md border px-3 py-2 text-sm focus:outline-none"
                                />
                            </Show>
                        </div>

                        <div class="mt-auto flex flex-col gap-3 pt-2">
                            <p class="text-sub/60 text-xs">
                                Created {fmtDue(props.card.created_at)}
                                <Show when={props.card.completed_at}> · finished {fmtDue(props.card.completed_at!)}</Show>
                            </p>
                            <Show when={props.canManage}>
                                <button
                                    onClick={() => {
                                        props.onDismiss()
                                        props.onClose()
                                    }}
                                    class="border-danger/40 text-danger/80 hover:border-danger hover:text-danger flex w-full items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-bold transition-colors hover:cursor-pointer"
                                >
                                    <span class="material-symbols-outlined text-base">close</span>
                                    Dismiss card
                                </button>
                            </Show>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    )
}

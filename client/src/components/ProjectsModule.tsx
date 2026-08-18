import { createSignal, createEffect, For, Show, onMount, onCleanup, type Component } from 'solid-js'
import { createStore, produce, reconcile } from 'solid-js/store'
import { api, type Project, type ProjectMilestone, type ProjectCard } from '../api'
import { useUI } from '../ui'
import { MomentBody } from './MomentBody'
import { Editor } from './Editor'
import { BookcaseDrift } from './BookcaseDrift'
import { prefs } from '../prefs'

// Projects module: a portfolio of long-horizon efforts. Each project is a
// tabbed hub (overview document, milestone board, graveyard) with an identity
// color and icon. Milestones are board columns; columns sharing a track stack
// vertically and split the height. Cards dismiss (never silently delete) into
// a graveyard with a deep Ctrl+Z stack. Overview and card bodies render
// through the moment pipeline, so ::todo:id::, ::canvas:id::, ::project:id::
// and [[moment]] embeds are live, and are written through the same Editor a
// moment uses (slash menu, [[ autocomplete, paste-to-attach).
//
// Mutations are optimistic: state first, request after, refetch on failure.
// Requires ManageProjects for writes; read-only otherwise.

interface ProjectsModuleProps {
    onClose: () => void
    canManage: boolean
    // A ::project:id:: embed elsewhere in the app asked for this project;
    // open straight onto it instead of the portfolio.
    initialProjectId?: string
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
}

// ---- vocabulary ----

const PRIORITIES = [
    { v: 0, label: 'None', color: '', icon: '' },
    { v: 1, label: 'Low', color: '#7ed6df', icon: 'keyboard_arrow_down' },
    { v: 2, label: 'Med', color: '#ffbe76', icon: 'keyboard_arrow_up' },
    { v: 3, label: 'High', color: '#ff7979', icon: 'keyboard_double_arrow_up' },
]
const priorityColor = (v: number) => PRIORITIES.find((p) => p.v === v)?.color || ''
const priorityIcon = (v: number) => PRIORITIES.find((p) => p.v === v)?.icon || ''

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
const fmtDue = (iso: string) => new Intl.DateTimeFormat(navigator.language, { month: 'short', day: 'numeric' }).format(new Date(iso))
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

// The first meaningful non-heading line of the overview, stripped of markup.
const snippetOf = (p: Project) => {
    const line = p.overview
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && !l.startsWith('::') && !l.startsWith('- ') && !l.startsWith('!'))
    return line ? line.replace(/\*\*|\*|`/g, '').replace(/\[\[([^\]]+)\]\]/g, '$1') : ''
}

// ---- shared bits ----

const Meter: Component<{ done: number; total: number; class?: string; color?: string }> = (props) => (
    <>
        <div class={`bg-element-accent h-1.5 overflow-hidden rounded-full ${props.class || 'w-16'}`}>
            <div
                class="bg-highlight-strongest h-full rounded-full transition-all"
                style={{ width: `${props.total === 0 ? 0 : Math.round((props.done / props.total) * 100)}%`, 'background-color': props.color }}
            />
        </div>
        <span class="text-sub font-mono text-[10px]">{props.total === 0 ? 0 : Math.round((props.done / props.total) * 100)}%</span>
    </>
)

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

const MomentumBars: Component<{ p: Project; height?: number; barClass?: string; color?: string }> = (props) => {
    const days = () => momentum(props.p)
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
    const [pview, setPview] = createSignal<'active' | 'archived'>('active')
    // An effect, not a mount-time read: a project embed clicked while the
    // module is already open (from the focused reader above it) retargets it.
    createEffect(() => {
        if (props.initialProjectId) setOpenId(props.initialProjectId)
    })
    // For the editors' `[[` autocomplete; best-effort, the slash menu's picker
    // self-fetches either way.
    const [momentIndex, setMomentIndex] = createSignal<{ id: string; title: string }[]>([])
    onMount(() => {
        api.listMoments({ limit: 100 })
            .then((data) => setMomentIndex((data ?? []).map((m) => ({ id: m.id, title: m.title || 'Untitled' }))))
            .catch(() => {})
    })

    const load = async () => {
        setLoading(true)
        setLoadError(false)
        try {
            const data = await api.listProjects()
            setProjects(reconcile((data ?? []).map((p) => ({ ...p, milestones: p.milestones ?? [], cards: p.cards ?? [] }))))
        } catch (err) {
            console.error('Failed to load projects:', err)
            setLoadError(true)
            ui.toast('Could not load projects.', 'error')
        } finally {
            setLoading(false)
        }
    }
    onMount(load)

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

    const newProject = async () => {
        try {
            const created = await api.createProject('New project')
            setProjects(produce((arr) => arr.push({ ...created, milestones: created.milestones ?? [], cards: created.cards ?? [] })))
            setOpenId(created.id)
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
        <div
            class="animate-fade-in text-main isolate fixed inset-0 z-50 flex flex-col overflow-hidden"
            style={{ 'background-color': 'var(--theme-bg)' }}
            // Solid surfaces while the texture is on; see index.css.
            data-solid-surfaces={prefs().bookcaseProjects ? '' : undefined}
        >
            {/* The login page's drifting bookcase, quieter: a working surface
                wants texture, not a statement. Toggleable per surface in
                Settings (Appearance, Background texture). */}
            <Show when={prefs().bookcaseProjects}>
                <BookcaseDrift class="opacity-[0.04]" />
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
                        onOpen={setOpenId}
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
                        momentIndex={momentIndex()}
                        onOpenMoment={props.onOpenMoment}
                        onOpenTodo={props.onOpenTodo}
                        onOpenCanvas={props.onOpenCanvas}
                        onOpenProject={setOpenId}
                    />
                )}
            </Show>
        </div>
    )
}

// ---- portfolio ----

const PORTFOLIO_TABS = [
    { key: 'active', label: 'Projects', icon: 'space_dashboard' },
    { key: 'archived', label: 'Archived', icon: 'inventory_2' },
] as const

const Portfolio: Component<{
    projects: Project[]
    loading: boolean
    loadError: boolean
    view: 'active' | 'archived'
    setView: (v: 'active' | 'archived') => void
    canManage: boolean
    onRetry: () => void
    onOpen: (id: string) => void
    onNew: () => void
    onRestore: (id: string) => void
    onDeleteForever: (id: string) => void
    onClose: () => void
}> = (props) => {
    const shown = () => props.projects.filter((p) => (props.view === 'archived' ? p.archived : !p.archived))
    return (
        <div class="relative z-10 flex min-h-0 flex-1 flex-col">
            <div class="bg-element border-element-accent flex items-center gap-3 border-b px-5 py-3">
                <span class="material-symbols-outlined text-highlight text-xl">space_dashboard</span>
                <h1 class="text-main font-serif text-2xl font-semibold">Projects</h1>
                <div class="border-element-accent ml-4 flex overflow-hidden rounded-md border">
                    <For each={PORTFOLIO_TABS}>
                        {(t) => (
                            <button
                                onClick={() => props.setView(t.key)}
                                class="flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors hover:cursor-pointer"
                                classList={{ 'bg-highlight-strongest text-white': props.view === t.key, 'text-sub hover:text-main': props.view !== t.key }}
                                title={`${t.label} view`}
                            >
                                <span class="material-symbols-outlined text-sm">{t.icon}</span>
                                {t.label}
                                <span class="opacity-60">{props.projects.filter((p) => (t.key === 'archived' ? p.archived : !p.archived)).length}</span>
                            </button>
                        )}
                    </For>
                </div>
                <div class="ml-auto flex items-center gap-3">
                    <Show when={props.canManage}>
                        <button
                            onClick={props.onNew}
                            class="bg-highlight-strongest flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-bold text-white transition-[filter] hover:brightness-110 hover:cursor-pointer"
                        >
                            <span class="material-symbols-outlined text-sm">add</span>
                            New project
                        </button>
                    </Show>
                    <button onClick={props.onClose} class="text-sub hover:text-main transition-colors hover:cursor-pointer" title="Close">
                        <span class="material-symbols-outlined">close</span>
                    </button>
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
                    <div class="animate-fade-in min-h-0 flex-1 overflow-y-auto p-5">
                        <Show
                            when={shown().length > 0}
                            fallback={
                                <div class="border-element-accent flex flex-col items-center gap-2 rounded-lg border border-dashed py-20">
                                    <span class="material-symbols-outlined text-sub/40 text-4xl">{props.view === 'archived' ? 'inventory_2' : 'space_dashboard'}</span>
                                    <p class="text-sub/60 text-sm italic">
                                        {props.view === 'archived' ? 'Nothing archived. Finished projects land here.' : 'No projects yet. Start one with New project.'}
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
                                                    <MomentumBars p={p} height={32} color={p.accent} />
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
                            </div>
                        </Show>
                    </div>
                </Show>
            </Show>
        </div>
    )
}

// ---- hub ----

const HUB_TABS = [
    { key: 'overview', label: 'Overview', icon: 'description' },
    { key: 'board', label: 'Board', icon: 'view_kanban' },
    { key: 'graveyard', label: 'Graveyard', icon: 'history' },
] as const
type HubTab = (typeof HUB_TABS)[number]['key']

const Hub: Component<{
    project: Project
    canManage: boolean
    onBack: () => void
    onClose: () => void
    onArchive: () => void
    mutate: (fn: (p: Project) => void) => void
    patchProject: (optimistic: (p: Project) => void, body: Parameters<typeof api.updateProject>[1]) => void
    reload: () => Promise<void>
    momentIndex: { id: string; title: string }[]
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
}> = (props) => {
    const ui = useUI()
    const [tab, setTab] = createSignal<HubTab>('overview')
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

    // --- overview document ---
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
            console.error('Failed to save the document:', err)
            ui.toast('Could not save the document.', 'error')
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
        setUndoStack([...undoStack(), { label: `Dismissed "${c.title}"`, apply: () => patchCard(c.id, (x) => (x.dismissed = false), { dismissed: false }) }])
        clearTimeout(undoTimer)
        setToastVisible(true)
        undoTimer = setTimeout(() => setToastVisible(false), 6000)
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
            <div class="bg-element border-element-accent flex items-center gap-3 border-b px-5 py-3" style={{ 'border-top': `2px solid ${accent()}b3` }}>
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
                        class="text-main font-serif hover:border-element-accent focus:border-highlight w-56 min-w-0 rounded-md border border-transparent bg-transparent px-1 text-xl font-semibold transition-colors focus:outline-none"
                    />
                </Show>
                <div class="border-element-accent flex overflow-hidden rounded-md border">
                    <For each={HUB_TABS}>
                        {(t) => (
                            <button
                                onClick={() => setTab(t.key)}
                                class="flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors hover:cursor-pointer"
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
                    <div class="px-8 py-6">
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
                                        <h3 class="text-main font-serif text-xl font-semibold">Document</h3>
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
                                                momentIndex={props.momentIndex}
                                                placeholder="The project document. Markdown; / embeds a to-do, canvas, moment or project; [[ links a moment; paste or drop images."
                                                onChange={ovChange}
                                                onSubmit={async () => ovDone()}
                                            />
                                        }
                                    >
                                        <Show
                                            when={props.project.overview.trim()}
                                            fallback={
                                                <p class="text-sub/60 text-sm italic">
                                                    {props.canManage ? 'No document yet. Edit starts it.' : 'No document yet.'}
                                                </p>
                                            }
                                        >
                                            <MomentBody
                                                content={props.project.overview}
                                                onOpenMoment={props.onOpenMoment}
                                                onOpenTodo={props.onOpenTodo}
                                                onOpenCanvas={props.onOpenCanvas}
                                                onOpenProject={props.onOpenProject}
                                            />
                                        </Show>
                                    </Show>
                                </div>

                                <div class="bg-element border-element-accent/60 mt-8 rounded-lg border p-7">
                                    <h3 class="text-main font-serif mb-6 text-xl font-semibold">Signals</h3>
                                    <div class="grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-2">
                                        <div>
                                            <p class="text-sub mb-3 text-xs font-medium">Momentum · finished per day · 14d</p>
                                            <MomentumBars p={props.project} height={110} barClass="min-w-0 flex-1" color={accent()} />
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
                            <div class="border-element-accent flex flex-col items-center gap-2 rounded-lg border border-dashed py-16">
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
                                                                                        <span class="material-symbols-outlined text-sub text-[14px]" title="Has a body">notes</span>
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
                        momentIndex={props.momentIndex}
                        onOpenMoment={props.onOpenMoment}
                        onOpenTodo={props.onOpenTodo}
                        onOpenCanvas={props.onOpenCanvas}
                        onOpenProject={props.onOpenProject}
                    />
                )}
            </Show>
        </div>
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
    momentIndex: { id: string; title: string }[]
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
}> = (props) => {
    // A card with a body opens on the rendered page; an empty one opens ready
    // to write.
    const [preview, setPreview] = createSignal(props.card.body.trim().length > 0 || !props.canManage)
    const [labelDraft, setLabelDraft] = createSignal('')

    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                // The editor's own layers (slash menu, [[ menu, embed picker)
                // claim Escape first; this listener runs in the capture phase,
                // before theirs, so it has to check the DOM rather than
                // defaultPrevented.
                if (document.querySelector('[data-editor-menu]')) return
                e.stopPropagation()
                props.onClose()
            }
        }
        window.addEventListener('keydown', onKey, true)
        onCleanup(() => window.removeEventListener('keydown', onKey, true))
    })

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
        <div class="animate-fade-in fixed inset-0 z-[65] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={props.onClose}>
            <div
                onClick={(e) => e.stopPropagation()}
                class="bg-element-matte border-element-accent flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border shadow-2xl"
            >
                <div class="bg-element border-element-accent flex items-center gap-3 border-b px-6 py-4">
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

                <div class="flex min-h-0 flex-1">
                    <div class="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
                        <Show
                            when={!preview()}
                            fallback={
                                <Show
                                    when={props.card.body.trim()}
                                    fallback={
                                        <p class="text-sub/60 text-sm italic">
                                            {props.canManage ? 'No body yet. Write starts it; / embeds a to-do, canvas, moment or project.' : 'No body.'}
                                        </p>
                                    }
                                >
                                    <MomentBody
                                        content={props.card.body}
                                        onOpenMoment={props.onOpenMoment}
                                        onOpenTodo={props.onOpenTodo}
                                        onOpenCanvas={props.onOpenCanvas}
                                        onOpenProject={props.onOpenProject}
                                    />
                                </Show>
                            }
                        >
                            <Editor
                                chrome="body"
                                initialContent={props.card.body}
                                momentIndex={props.momentIndex}
                                placeholder="The card's document. Markdown; / embeds a to-do, canvas, moment or project; [[ links a moment; paste or drop images."
                                onChange={bodyChange}
                                onSubmit={async () => {
                                    bodyFlush()
                                    setPreview(true)
                                }}
                            />
                        </Show>
                    </div>

                    <div class="border-element-accent bg-element/40 flex w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l p-5">
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
                                    <For each={msOrder(props.project)}>{(m) => <option value={m.id}>{m.title}</option>}</For>
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
        </div>
    )
}

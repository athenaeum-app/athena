// PROTOTYPE, throwaway. Grilling round 8: which visual direction has a soul?
//
// Functionality is settled (rounds 1-7): own cards in draggable milestone
// columns; Covers portfolio; card modal with markdown body + embeds; Tasks
// priorities; dismiss with deep undo + graveyard; archive shelf; tabbed hub
// (Board / Overview / Stats / Graveyard). The bare version read as empty and
// soulless, so cards got denser (keys like NRG-12, priority arrows) and the
// columns now fill the viewport. The ?variant= switcher picks the direction:
//
//   A · Dense lanes   tinted full-height lanes, neutral ink, density is
//                     the aesthetic (Jira DNA)
//   B · Accent        every project has a color that threads through the
//                     portfolio, hub, tabs and meters
//
// State is memory only.
import { createSignal, For, Show, onMount, onCleanup, type Component } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { Switcher } from './Switcher'

let counter = 0
const uid = () => `p${++counter}`

// ---- model ------------------------------------------------------------------

interface Sub {
    id: string
    text: string
    done: boolean
}
interface Card {
    id: string
    title: string
    labels: string[]
    due: string
    done: boolean
    notes: string
    subs: Sub[]
    priority: number
    dismissed: boolean
    num: number
}

const PRIORITIES = [
    { v: 0, label: 'None', color: '', icon: '' },
    { v: 1, label: 'Low', color: '#7ed6df', icon: 'keyboard_arrow_down' },
    { v: 2, label: 'Med', color: '#ffbe76', icon: 'keyboard_arrow_up' },
    { v: 3, label: 'High', color: '#ff7979', icon: 'keyboard_double_arrow_up' },
]
const priorityColor = (v: number) => PRIORITIES.find((p) => p.v === v)?.color || ''
const priorityIcon = (v: number) => PRIORITIES.find((p) => p.v === v)?.icon || ''

// Jira-style card keys: the project's initials plus a stable number. Identity
// is half of what makes a board feel inhabited.
const keyOf = (p: Project) =>
    p.title
        .split(/[\s(]+/)
        .filter((w) => w && /[a-zA-Z0-9]/.test(w[0]))
        .map((w) => w[0].toUpperCase())
        .slice(0, 3)
        .join('')
interface Milestone {
    id: string
    title: string
    due: string
    overdue: boolean
    cards: Card[]
    // Board layout: milestones sharing a track stack vertically and split the
    // track's height. Track values are normalized to 0..n after every move.
    track: number
}
interface Project {
    id: string
    title: string
    milestones: Milestone[]
    // Cards finished per day, most recent last (fake, for the momentum chart).
    momentum: number[]
    archived: boolean
    overview: string
    accent: string
    // Material symbol used for the generative cover art; images without assets.
    icon: string
}

const LABELS: Record<string, string> = { design: '#c4b5fd', code: '#67e8f9', art: '#f9a8d4', biz: '#fcd34d' }

let cardNum = 0
const mkCard = (title: string, extra: Partial<Card> = {}): Card => ({
    id: uid(), title, labels: [], due: '', done: false, notes: '', subs: [], priority: 0, dismissed: false, num: ++cardNum, ...extra,
})

const seed = (): Project[] => [
    {
        id: uid(),
        title: 'New Roblox Game',
        archived: false,
        accent: '#67b8c7',
        icon: 'sports_esports',
        overview:
            '## The pitch\nA round-based dungeon crawler with **tycoon meta-progression**. Target: *playable slice by October*.\n\n### Pillars\n- Combat that reads in `0.2s`: light, heavy, dodge\n- Runs feed the base, the base feeds the runs\n- One session = one full loop, under 15 minutes\n\nDesign bible lives at [[gdd overview]]. Weekly goals feed from the shared list:\n\n::todo:weekly-goals::',
        momentum: [0, 1, 0, 2, 1, 0, 0, 3, 1, 2, 0, 1, 4, 2],
        milestones: [
            {
                id: uid(), title: 'Prototype', due: 'Aug 22', overdue: false, track: 0,
                cards: [
                    mkCard('Core movement', { done: true, labels: ['code'] }),
                    mkCard('Combat loop v1', {
                        done: true,
                        labels: ['code', 'design'],
                        notes: '## Combat loop\nLight/heavy/dodge triangle. Stamina gates heavies.\n\nSee [[combat notes]] for the design writeup.\n\n::todo:combat-checklist::\n\nOpen question: should dodge have i-frames or reposition only?',
                    }),
                    mkCard('Enemy AI: patrol + aggro', { labels: ['code'], priority: 3 }),
                    mkCard('Greybox the hub map', { labels: ['art'], due: 'Fri', priority: 2 }),
                    mkCard('Datastore schema v2', { labels: ['code'], priority: 1 }),
                    mkCard('Voxel art style test', { labels: ['art'], dismissed: true }),
                    mkCard('Pet companion system', { labels: ['design'], dismissed: true }),
                    mkCard('Grappling hook movement', { labels: ['code', 'design'], dismissed: true }),
                ],
            },
            {
                id: uid(), title: 'Vertical slice', due: 'Sep 12', overdue: false, track: 1,
                cards: [
                    mkCard('Art direction pass', { labels: ['art'], priority: 2 }),
                    mkCard('First boss fight', { labels: ['design', 'code'] }),
                    mkCard('Sound pass on combat'),
                    mkCard('Lobby and matchmaking UI', { labels: ['code'] }),
                ],
            },
            {
                id: uid(), title: 'Playtest', due: 'Oct 3', overdue: false, track: 2,
                cards: [mkCard('Invite 10 testers', { labels: ['biz'] }), mkCard('Feedback form')],
            },
            // Stacked with Playtest to demo tracks: two panels splitting one column.
            { id: uid(), title: 'Launch', due: '', overdue: false, track: 2, cards: [mkCard('Store page + icon', { labels: ['biz', 'art'] })] },
        ],
    },
    {
        id: uid(),
        title: 'Tycoon Legends (live)',
        archived: false,
        accent: '#c9a35c',
        icon: 'storefront',
        overview:
            '## Live ops\n**41k daily players.** The game earns while we sleep; the job is to keep it fresh without breaking it.\n\n### Cadence\n- Content drop every *3 weeks*\n- Balance pass every Monday from the analytics sheet\n- Community post with every update, no silent patches\n\nIncident log and revenue notes live at [[tycoon ops journal]].',
        momentum: [1, 0, 2, 0, 1, 0, 2, 1, 0, 1, 0, 2, 0, 1],
        milestones: [
            {
                id: uid(), title: 'Summer event', due: 'Aug 10', overdue: true, track: 0,
                cards: [
                    mkCard('Event map', { done: true, labels: ['art'] }),
                    mkCard('Limited pets', { labels: ['code'], priority: 3, due: 'Mon' }),
                    mkCard('Fix pet dupe exploit', { labels: ['code'], priority: 3, notes: 'Trade window race condition. Repro in [[dupe repro]] · patch server-side validation first.' }),
                    mkCard('Promo codes', { labels: ['biz'] }),
                ],
            },
            {
                id: uid(), title: 'QoL update', due: 'Sep 5', overdue: false, track: 1,
                cards: [
                    mkCard('Rebalance mid-game economy', { labels: ['design'], priority: 2 }),
                    mkCard('Settings menu rework', { labels: ['code'] }),
                    mkCard('New thumbnail A/B test', { labels: ['art', 'biz'] }),
                ],
            },
            {
                id: uid(), title: 'Anti-cheat pass', due: 'Sep 30', overdue: false, track: 2,
                cards: [
                    mkCard('Server validation audit', { labels: ['code'], priority: 2 }),
                    mkCard('Report tooling for mods'),
                    mkCard('Autoban tuning', { labels: ['code'], dismissed: true }),
                ],
            },
        ],
    },
    {
        id: uid(),
        title: 'Voidbreak (Steam)',
        archived: false,
        accent: '#9d8fd6',
        icon: 'joystick',
        overview:
            '## Shipped, not finished\nOut since March. **Mostly Positive** and stable; support patches only, no new content until the sequel decision.\n\n- Crash rate `0.3%`, target is under `0.2%`\n- Localization requests: pt-BR and ja lead the wishlist',
        momentum: [0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0],
        milestones: [
            {
                id: uid(), title: 'Patch 1.2', due: '', overdue: false, track: 0,
                cards: [
                    mkCard('Crash on alt-tab', { done: true, labels: ['code'] }),
                    mkCard('Controller rebinding', { done: true }),
                    mkCard('Localization pass: pt-BR', { labels: ['biz'], priority: 2 }),
                ],
            },
        ],
    },
    {
        id: uid(),
        title: 'Devlog Series',
        archived: false,
        accent: '#c98fae',
        icon: 'videocam',
        overview:
            '## Why post\nThe games market themselves badly; the *making of* markets them well. One episode per sprint, honest, under 8 minutes.\n\n- Hook in the first 15 seconds, no intros\n- Every episode ends on the next playable change\n- Reuse capture from playtests, never stage footage',
        momentum: [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0],
        milestones: [
            {
                id: uid(), title: 'Episode 5', due: 'Aug 24', overdue: false, track: 0,
                cards: [
                    mkCard('Script draft', { done: true }),
                    mkCard('Capture combat b-roll', { priority: 2, due: 'Wed' }),
                    mkCard('Edit pass', { priority: 1 }),
                    mkCard('Thumbnail options', { labels: ['art'] }),
                ],
            },
            {
                id: uid(), title: 'Channel rework', due: '', overdue: false, track: 1,
                cards: [mkCard('New banner', { labels: ['art'] }), mkCard('Playlist structure'), mkCard('Sponsor outreach', { labels: ['biz'], dismissed: true })],
            },
        ],
    },
    {
        id: uid(),
        title: 'Apartment Move',
        archived: false,
        accent: '#8fbf8f',
        icon: 'home',
        overview:
            '## The plan\nLease starts **Sep 1**. Everything boxed by the 30th, internet live before the desk is up. Proof this module is not only for software.',
        momentum: [0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 1, 0, 0, 0],
        milestones: [
            {
                id: uid(), title: 'Before the move', due: 'Aug 30', overdue: false, track: 0,
                cards: [
                    mkCard('Book the truck', { done: true, priority: 3 }),
                    mkCard('Box the studio', { priority: 2 }),
                    mkCard('Transfer utilities', { priority: 3, due: 'Aug 25' }),
                    mkCard('Change address everywhere'),
                ],
            },
            {
                id: uid(), title: 'Move day', due: 'Sep 1', overdue: false, track: 1,
                cards: [mkCard('Helpers confirmed'), mkCard('PC packed last, unpacked first', { priority: 3 })],
            },
            {
                id: uid(), title: 'Settle in', due: '', overdue: false, track: 1,
                cards: [mkCard('Internet installed'), mkCard('Desk + monitors up')],
            },
        ],
    },
    {
        id: uid(),
        title: 'CS2 Final Project',
        archived: true,
        accent: '#6fae93',
        icon: 'school',
        overview: '## Done\nSubmitted and graded. Kept for the record.',
        momentum: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        milestones: [
            {
                id: uid(), title: 'Submission', due: '', overdue: false, track: 0,
                cards: [mkCard('Report', { done: true }), mkCard('Demo video', { done: true }), mkCard('Code cleanup', { done: true })],
            },
        ],
    },
]

// ---- derived ----------------------------------------------------------------

// Dismissed cards leave every count and meter; they only exist in the
// graveyard. Lookups by id still need the full set.
const flatAll = (p: Project) => p.milestones.flatMap((m) => m.cards)
const flat = (p: Project) => flatAll(p).filter((c) => !c.dismissed)
const live = (cards: Card[]) => cards.filter((c) => !c.dismissed)
const doneCount = (cards: Card[]) => cards.filter((c) => c.done).length
const health = (p: Project): { word: string; icon: string; danger: boolean } => {
    const cards = flat(p)
    if (cards.length > 0 && doneCount(cards) === cards.length) return { word: 'Complete', icon: 'flag', danger: false }
    if (p.milestones.some((m) => m.overdue && doneCount(live(m.cards)) < live(m.cards).length)) return { word: 'Overdue', icon: 'warning', danger: true }
    if (p.milestones.length === 0) return { word: 'Unplanned', icon: 'explore', danger: false }
    return { word: 'On track', icon: 'route', danger: false }
}
const nextMilestone = (p: Project) => p.milestones.find((m) => doneCount(live(m.cards)) < live(m.cards).length || live(m.cards).length === 0)

// ---- shared bits ------------------------------------------------------------

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

// One segment per milestone, each filling with that milestone's completion:
// the project's plan and its progress in a single stripe.
const SpineMeter: Component<{ p: Project; color?: string }> = (props) => (
    <div class="flex h-2 w-full gap-0.5">
        <For each={props.p.milestones}>
            {(m) => (
                <div class="bg-element-accent h-full flex-1 overflow-hidden rounded-sm" title={`${m.title}: ${doneCount(live(m.cards))}/${live(m.cards).length}`}>
                    <div
                        class="bg-highlight-strongest h-full"
                        style={{ width: `${live(m.cards).length === 0 ? 0 : Math.round((doneCount(live(m.cards)) / live(m.cards).length) * 100)}%`, 'background-color': props.color }}
                    />
                </div>
            )}
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

const MomentumBars: Component<{ p: Project; height?: number; barClass?: string; color?: string; fill?: boolean }> = (props) => {
    const max = () => Math.max(1, ...props.p.momentum)
    return (
        <div
            class={`border-element-accent flex items-end gap-1 border-b pb-px ${props.fill ? 'min-h-0 w-full flex-1' : ''}`}
            style={props.fill ? {} : { height: `${props.height || 28}px` }}
            title="Cards finished per day, last 14 days"
        >
            <For each={props.p.momentum}>
                {(n, i) => (
                    <div
                        title={`${n} finished · ${13 - i() === 0 ? 'today' : `${13 - i()}d ago`}`}
                        class={`rounded-t-sm transition-[filter,height] duration-200 hover:brightness-150 ${props.barClass || 'w-2'} ${n > 0 ? 'bg-highlight-strongest' : 'bg-element-accent'}`}
                        style={{ height: n === 0 ? '2px' : `${Math.round((n / max()) * 100)}%`, 'background-color': n > 0 ? props.color : undefined }}
                    />
                )}
            </For>
        </div>
    )
}

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

const NewProjectButton: Component<{ onNew: () => void }> = (props) => (
    <button
        onClick={props.onNew}
        class="bg-highlight-strongest flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-bold text-white transition-[filter] hover:brightness-110 hover:cursor-pointer"
    >
        <span class="material-symbols-outlined text-sm">add</span>
        New project
    </button>
)

// ---- the hub (settled round 1: own cards, drag everywhere) ------------------

// Labels and due date, constant across the three modal variants so only the
// body model is under judgment.
const CardMeta: Component<{ card: Card; patch: (fn: (c: Card) => void) => void }> = (props) => (
    <>
        <div class="flex flex-wrap gap-1">
            <For each={Object.keys(LABELS)}>
                {(l) => (
                    <button
                        onClick={() =>
                            props.patch((c) => {
                                c.labels = c.labels.includes(l) ? c.labels.filter((y) => y !== l) : [...c.labels, l]
                            })
                        }
                        class="rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide hover:cursor-pointer"
                        style={{
                            'background-color': props.card.labels.includes(l) ? LABELS[l] : 'transparent',
                            color: props.card.labels.includes(l) ? '#1a1a2e' : LABELS[l],
                            border: `1px solid ${LABELS[l]}`,
                        }}
                    >
                        {l}
                    </button>
                )}
            </For>
        </div>
        <div class="flex items-center gap-2">
            <span class="text-sub w-10 text-[10px] font-bold uppercase tracking-wide">Due</span>
            <input
                type="text"
                value={props.card.due}
                onChange={(e) => props.patch((c) => (c.due = e.currentTarget.value))}
                placeholder="Fri / Aug 22"
                class="bg-element text-main border-element-accent focus:border-highlight min-w-0 flex-1 rounded border px-2 py-1 text-xs focus:outline-none"
            />
        </div>
        <div class="flex items-center gap-1">
            <span class="text-sub w-10 text-[10px] font-bold uppercase tracking-wide">Prio</span>
            <For each={PRIORITIES}>
                {(p) => (
                    <button
                        onClick={() => props.patch((c) => (c.priority = p.v))}
                        class="rounded px-2 py-0.5 text-[11px] font-bold hover:cursor-pointer"
                        style={{
                            'background-color': props.card.priority === p.v && p.color ? p.color : 'transparent',
                            color: props.card.priority === p.v ? (p.color ? '#1a1a2e' : 'var(--theme-text)') : p.color || 'var(--theme-text-sub)',
                            border: `1px solid ${p.color || 'var(--theme-element-accent)'}`,
                        }}
                    >
                        {p.label}
                    </button>
                )}
            </For>
        </div>
    </>
)

// A real (if small) markdown subset so previews behave like the final module,
// which renders through the full moment pipeline: headings, lists, bold,
// italic, inline code, [[links]], and ::todo:: embeds.
const inlineMd = (s: string) =>
    s
        .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-bold">$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code class="bg-element-accent rounded px-1 font-mono text-[0.85em]">$1</code>')
        .replace(/\[\[([^\]]+)\]\]/g, '<span class="text-highlight font-semibold hover:cursor-pointer">$1</span>')

const TodoEmbedFake: Component<{ line: string }> = (props) => (
    <div class="bg-element-matte border-element-accent max-w-md rounded-md border p-2.5">
        <div class="mb-1 flex items-center gap-1.5">
            <span class="material-symbols-outlined text-highlight text-sm">checklist</span>
            <span class="text-main flex-1 text-xs font-semibold capitalize">
                {(props.line.match(/^::todo:([^:]*)::/)?.[1] || 'checklist').replace(/-/g, ' ')}
            </span>
            <span class="text-sub font-mono text-[10px]">2/4</span>
        </div>
        <p class="text-sub text-xs line-through">Hit pause on connect</p>
        <p class="text-sub text-xs line-through">Camera shake pass</p>
        <p class="text-main text-xs">Hurtbox timing on heavy</p>
        <p class="text-main text-xs">Dodge cancel window</p>
        <p class="text-sub/50 mt-1 text-[10px]">A live embedded to-do list (like moments already embed)</p>
    </div>
)

const BodyPreview: Component<{ text: string; large?: boolean }> = (props) => {
    const p = () => (props.large ? 'text-main text-base leading-relaxed' : 'text-main text-sm')
    return (
        <div class={`flex flex-col ${props.large ? 'gap-3' : 'gap-2'}`}>
            <For each={props.text.split('\n').filter((l) => l.trim())}>
                {(raw) => {
                    const line = raw.trim()
                    if (line.startsWith('::todo:')) return <TodoEmbedFake line={line} />
                    if (line.startsWith('### ')) return <h4 class={`text-main font-serif font-semibold ${props.large ? 'text-lg' : 'text-sm'}`}>{line.slice(4)}</h4>
                    if (line.startsWith('## ')) return <h3 class={`text-main font-serif mt-1 font-semibold ${props.large ? 'text-2xl' : 'text-base'}`}>{line.slice(3)}</h3>
                    if (line.startsWith('# ')) return <h2 class={`text-main font-serif mt-1 font-semibold ${props.large ? 'text-3xl' : 'text-lg'}`}>{line.slice(2)}</h2>
                    if (line.startsWith('- '))
                        return (
                            <div class="flex gap-2 pl-1">
                                <span class="text-sub select-none">•</span>
                                <p class={p()} innerHTML={inlineMd(line.slice(2))} />
                            </div>
                        )
                    return <p class={p()} innerHTML={inlineMd(line)} />
                }}
            </For>
        </div>
    )
}

const HUB_TABS = [
    { key: 'overview', label: 'Overview', icon: 'description' },
    { key: 'board', label: 'Board', icon: 'view_kanban' },
    { key: 'graveyard', label: 'Graveyard', icon: 'history' },
] as const
type HubTab = (typeof HUB_TABS)[number]['key']

const Hub: Component<{
    project: Project
    removal: 'delete' | 'dismiss'
    look: 'lanes' | 'accent'
    onBack: () => void
    onArchive?: () => void
    mutate: (fn: (p: Project) => void) => void
}> = (props) => {
    const [tab, setTab] = createSignal<HubTab>('overview')
    const isAccent = () => props.look === 'accent'
    const accent = () => (isAccent() ? props.project.accent : undefined)
    const [ovEditing, setOvEditing] = createSignal(false)
    const [dragCard, setDragCard] = createSignal<string | null>(null)
    const [dragCol, setDragCol] = createSignal<string | null>(null)
    const [editId, setEditId] = createSignal<string | null>(null)
    // A stack, not a slot: Ctrl+Z walks back through every dismissal this
    // visit. The graveyard is the permanent record (a DB flag in the real
    // build), so undo depth costs nothing.
    const [undoStack, setUndoStack] = createSignal<{ label: string; apply: () => void }[]>([])
    const [toastVisible, setToastVisible] = createSignal(false)
    let undoTimer: ReturnType<typeof setTimeout> | undefined

    const editCard = () => flatAll(props.project).find((c) => c.id === editId()) || null
    const patchCard = (id: string) => (fn: (c: Card) => void) =>
        props.mutate((p) => {
            const card = flatAll(p).find((c) => c.id === id)
            if (card) fn(card)
        })

    const popUndo = () => {
        const stack = undoStack()
        if (!stack.length) return
        stack[stack.length - 1].apply()
        setUndoStack(stack.slice(0, -1))
        if (!undoStack().length) setToastVisible(false)
    }

    const removeCard = (c: Card) => {
        if (editId() === c.id) setEditId(null)
        if (props.removal === 'dismiss') {
            patchCard(c.id)((x) => (x.dismissed = true))
            setUndoStack([...undoStack(), { label: `Dismissed "${c.title}"`, apply: () => patchCard(c.id)((x) => (x.dismissed = false)) }])
            clearTimeout(undoTimer)
            setToastVisible(true)
            undoTimer = setTimeout(() => setToastVisible(false), 6000)
        } else {
            props.mutate((p) => {
                for (const m of p.milestones) {
                    const i = m.cards.findIndex((x) => x.id === c.id)
                    if (i >= 0) m.cards.splice(i, 1)
                }
            })
        }
    }

    const graveyard = () => flatAll(props.project).filter((c) => c.dismissed)

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

    const moveCard = (cardId: string, toMs: string, beforeId?: string) =>
        props.mutate((p) => {
            let card: Card | undefined
            for (const m of p.milestones) {
                const i = m.cards.findIndex((c) => c.id === cardId)
                if (i >= 0) [card] = m.cards.splice(i, 1)
            }
            if (!card) return
            const target = p.milestones.find((m) => m.id === toMs)
            if (!target) return
            const at = beforeId ? target.cards.findIndex((c) => c.id === beforeId) : -1
            if (at >= 0) target.cards.splice(at, 0, card)
            else target.cards.push(card)
        })

    // Track layout: tracks are the vertical slots; panels in the same track
    // stack and split its height. Values renumber to 0..n after every move,
    // sorted numerically, so "before track t" is just t - 0.5.
    const trackList = () => [...new Set(props.project.milestones.map((m) => m.track))].sort((a, b) => a - b)
    const inTrack = (t: number) => props.project.milestones.filter((m) => m.track === t)

    const normalizeTracks = (p: Project) => {
        const order = [...new Set(p.milestones.map((m) => m.track))].sort((a, b) => a - b)
        for (const m of p.milestones) m.track = order.indexOf(m.track)
    }

    // Drop onto a panel: join its track, stacked directly under it.
    const stackInto = (fromId: string, targetId: string) =>
        props.mutate((p) => {
            if (fromId === targetId) return
            const from = p.milestones.findIndex((m) => m.id === fromId)
            if (from < 0) return
            const [ms] = p.milestones.splice(from, 1)
            const at = p.milestones.findIndex((m) => m.id === targetId)
            if (at < 0) {
                p.milestones.push(ms)
            } else {
                ms.track = p.milestones[at].track
                p.milestones.splice(at + 1, 0, ms)
            }
            normalizeTracks(p)
        })

    // Drop into a gap: the panel gets a track of its own there.
    const toOwnTrack = (fromId: string, beforeTrack?: number) =>
        props.mutate((p) => {
            const ms = p.milestones.find((m) => m.id === fromId)
            if (!ms) return
            ms.track = beforeTrack === undefined ? Math.max(-1, ...p.milestones.map((m) => m.track)) + 1 : beforeTrack - 0.5
            normalizeTracks(p)
        })

    const all = () => flat(props.project)
    const liveMs = (ms: Milestone) => live(ms.cards)

    // Board order: open work first (priority, then dated cards), completed
    // pooled at the bottom. Stable, so manual order survives within a group.
    const sortCards = (cards: Card[]) =>
        [...cards].sort((a, b) => Number(a.done) - Number(b.done) || b.priority - a.priority || Number(!!b.due) - Number(!!a.due))

    // Per-milestone "hide completed", plus a global switch that sets them all.
    const [hiddenDone, setHiddenDone] = createStore<Record<string, boolean>>({})
    const allHidden = () => props.project.milestones.every((m) => hiddenDone[m.id])
    const setAllHidden = (v: boolean) =>
        setHiddenDone(produce((h) => props.project.milestones.forEach((m) => (h[m.id] = v))))
    const panelCards = (ms: Milestone) => {
        const sorted = sortCards(liveMs(ms))
        return hiddenDone[ms.id] ? sorted.filter((c) => !c.done) : sorted
    }

    return (
        <div
            class="flex min-h-0 flex-1 flex-col"
            style={accent() ? { background: `radial-gradient(80rem 24rem at 15% -5%, ${accent()}14, transparent)` } : {}}
        >
            <div class="bg-element border-element-accent flex items-center gap-3 border-b px-5 py-3" style={accent() ? { 'border-top': `2px solid ${accent()}b3` } : {}}>
                <button onClick={props.onBack} class="text-sub hover:text-main hover:cursor-pointer" title="Back to all projects">
                    <span class="material-symbols-outlined">arrow_back</span>
                </button>
                <span class="text-sub text-xs">Projects /</span>
                <span class="material-symbols-outlined text-base" style={{ color: accent() || 'var(--theme-highlight)' }}>{props.project.icon}</span>
                <span class="font-mono text-xs font-bold" style={{ color: accent() || 'var(--theme-highlight)' }}>{keyOf(props.project)}</span>
                <input
                    type="text"
                    value={props.project.title}
                    onChange={(e) => props.mutate((p) => (p.title = e.currentTarget.value))}
                    title="Rename project"
                    class="text-main font-serif hover:border-element-accent focus:border-highlight w-64 min-w-0 rounded-md border border-transparent bg-transparent px-1 text-xl font-semibold transition-colors focus:outline-none"
                />
                <div class="border-element-accent ml-4 flex overflow-hidden rounded-md border">
                    <For each={HUB_TABS}>
                        {(t) => (
                            <button
                                onClick={() => setTab(t.key)}
                                class="flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors hover:cursor-pointer"
                                classList={{ 'bg-highlight-strongest text-white': tab() === t.key && !accent(), 'text-sub hover:text-main': tab() !== t.key }}
                                style={tab() === t.key && accent() ? { 'background-color': `${accent()}2b`, color: accent(), 'font-weight': '700' } : {}}
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
                <Show when={props.onArchive}>
                    <button onClick={props.onArchive} title="Archive project" class="text-sub hover:text-main hover:cursor-pointer">
                        <span class="material-symbols-outlined">inventory_2</span>
                    </button>
                </Show>
            </div>

            <Show when={tab() === 'overview'}>
                <div class="animate-fade-in min-h-0 flex-1 overflow-y-auto">
                    <div class="px-8 py-6">
                        {/* Hero, then a main column whose document dominates, with the
                            numbers below it under a rule. The rail drops the card boxes:
                            hierarchy comes from serif section headings and whitespace. */}
                        <div class="flex items-center gap-2">
                            <span class="material-symbols-outlined text-lg" style={{ color: accent() || 'var(--theme-highlight)' }}>{props.project.icon}</span>
                            <span class="font-mono text-xs font-bold tracking-widest" style={{ color: accent() || 'var(--theme-highlight)' }}>
                                {keyOf(props.project)}
                            </span>
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
                                            <Show when={ms().due}> · {ms().due}</Show>
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
                                <div class="bg-element/70 border-element-accent/60 rounded-lg border p-7">
                                    <div class="mb-5 flex items-center justify-between">
                                        <h3 class="text-main font-serif text-xl font-semibold">Document</h3>
                                        <button
                                            onClick={() => setOvEditing(!ovEditing())}
                                            class="border-element-accent flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs transition-colors hover:cursor-pointer"
                                            classList={{ 'bg-highlight-strongest text-white': ovEditing(), 'text-sub hover:text-main': !ovEditing() }}
                                        >
                                            <span class="material-symbols-outlined text-sm">edit</span>
                                            {ovEditing() ? 'Done' : 'Edit'}
                                        </button>
                                    </div>
                                    <Show
                                        when={!ovEditing() && props.project.overview.trim()}
                                        fallback={
                                            <textarea
                                                value={props.project.overview}
                                                onChange={(e) => props.mutate((p) => (p.overview = e.currentTarget.value))}
                                                placeholder={'The project document. Markdown with embeds: ::todo:id::, [[moment]], canvases.'}
                                                rows={16}
                                                class="bg-element-matte text-main border-element-accent focus:border-highlight placeholder:text-sub/50 w-full resize-y rounded-md border px-4 py-3 font-mono text-sm leading-relaxed focus:outline-none"
                                            />
                                        }
                                    >
                                        <BodyPreview text={props.project.overview} large />
                                    </Show>
                                </div>

                                <div class="border-element-accent/60 mt-10 border-t pt-7">
                                    <h3 class="text-main font-serif mb-6 text-xl font-semibold">Signals</h3>
                                    <div class="grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-2">
                                        <div>
                                            <p class="text-sub mb-3 text-xs font-medium">Momentum · finished per day · 14d</p>
                                            <MomentumBars p={props.project} height={110} barClass="min-w-0 flex-1" color={accent()} />
                                            <div class="text-sub/60 mt-1 flex justify-between text-[10px]">
                                                <span>2 weeks ago</span>
                                                <span class="text-main font-mono">best day: {Math.max(0, ...props.project.momentum)}</span>
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
                                            <For each={Object.keys(LABELS)}>
                                                {(l) => {
                                                    const count = () => all().filter((c) => !c.done && c.labels.includes(l)).length
                                                    const maxCount = () => Math.max(1, ...Object.keys(LABELS).map((x) => all().filter((c) => !c.done && c.labels.includes(x)).length))
                                                    return (
                                                        <div class="flex items-center gap-3 py-1.5">
                                                            <span class="w-12 shrink-0 rounded px-1.5 text-center text-[10px] font-medium" style={{ color: LABELS[l], border: `1px solid ${LABELS[l]}44` }}>
                                                                {l}
                                                            </span>
                                                            <div class="bg-element-accent h-2 flex-1 overflow-hidden rounded">
                                                                <div
                                                                    class="h-full rounded transition-all"
                                                                    style={{ width: `${Math.round((count() / maxCount()) * 100)}%`, 'background-color': `${LABELS[l]}cc`, 'min-width': count() > 0 ? '4px' : '0' }}
                                                                />
                                                            </div>
                                                            <span class="text-main w-4 shrink-0 text-right font-mono text-xs font-bold">{count()}</span>
                                                        </div>
                                                    )
                                                }}
                                            </For>
                                        </div>
                                        <div>
                                            <p class="text-sub mb-3 text-xs font-medium">Recently finished</p>
                                            <Show when={doneCount(all()) > 0} fallback={<p class="text-sub/50 text-xs italic">Nothing finished yet.</p>}>
                                                <For each={all().filter((c) => c.done).slice(-4).reverse()}>
                                                    {(c) => (
                                                        <div
                                                            class="hover:bg-element-matte/40 -mx-1.5 flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:cursor-pointer"
                                                            title="Open card"
                                                            onClick={() => setEditId(c.id)}
                                                        >
                                                            <span class="material-symbols-outlined text-[15px]" style={{ color: accent() || 'var(--theme-highlight)' }}>
                                                                check_circle
                                                            </span>
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
                                <h3 class="text-main font-serif text-xl font-semibold">Up next</h3>
                                <div class="mt-3">
                                    <Show
                                        when={all().filter((c) => !c.done && c.due).length > 0}
                                        fallback={<p class="text-sub/50 text-sm italic">Nothing dated. The board decides what is next.</p>}
                                    >
                                        <For each={all().filter((c) => !c.done && c.due).slice(0, 5)}>
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
                                                    <span class="bg-element-accent text-sub shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold">{c.due}</span>
                                                </div>
                                            )}
                                        </For>
                                    </Show>
                                </div>

                                <h3 class="text-main font-serif border-element-accent/60 mt-8 border-t pt-7 text-xl font-semibold">Roadmap</h3>
                                <div class="mt-4">
                                    <For each={props.project.milestones}>
                                        {(ms, i) => {
                                            const complete = () => liveMs(ms).length > 0 && doneCount(liveMs(ms)) === liveMs(ms).length
                                            const active = () => nextMilestone(props.project)?.id === ms.id
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
                                                                    ? { 'background-color': accent() || 'var(--theme-highlight-strongest)', 'border-color': accent() || 'var(--theme-highlight-strongest)' }
                                                                    : active()
                                                                      ? { 'border-color': accent() || 'var(--theme-highlight)', 'box-shadow': `0 0 0 3px ${accent() || 'var(--theme-highlight)'}33` }
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
                                                            <Show when={ms.due}>
                                                                <span class="text-sub shrink-0 text-[10px]" classList={{ 'text-danger': ms.overdue }}>{ms.due}</span>
                                                            </Show>
                                                            <span class="text-sub ml-auto shrink-0 font-mono text-[10px]">{doneCount(liveMs(ms))}/{liveMs(ms).length}</span>
                                                        </div>
                                                        <div class="bg-element-accent mt-1.5 h-1 overflow-hidden rounded-full">
                                                            <div
                                                                class="h-full rounded-full transition-all"
                                                                style={{
                                                                    width: `${liveMs(ms).length === 0 ? 0 : Math.round((doneCount(liveMs(ms)) / liveMs(ms).length) * 100)}%`,
                                                                    'background-color': accent() || 'var(--theme-highlight-strongest)',
                                                                }}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                            )
                                        }}
                                    </For>
                                </div>

                                <button
                                    onClick={() => setTab('graveyard')}
                                    class="text-sub hover:text-main border-element-accent/60 mt-4 flex items-center gap-1.5 border-t pt-5 text-xs transition-colors hover:cursor-pointer"
                                >
                                    <span class="material-symbols-outlined text-base">history</span>
                                    <span class="text-main font-mono font-bold">{graveyard().length}</span> dismissed · open the graveyard
                                </button>
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
                        <For each={props.project.milestones.filter((m) => m.cards.some((c) => c.dismissed))}>
                            {(ms) => (
                                <div class="mb-4">
                                    <p class="text-sub mb-1.5 text-xs font-medium">from {ms.title}</p>
                                    <For each={ms.cards.filter((c) => c.dismissed)}>
                                        {(c) => (
                                            <div class="bg-element border-element-accent mb-1.5 flex items-center gap-3 rounded-md border px-4 py-2.5">
                                                <span class="text-sub text-sm line-through">{c.title}</span>
                                                <div class="flex flex-wrap gap-1">
                                                    <For each={c.labels}>
                                                        {(l) => (
                                                            <span
                                                                class="rounded px-1.5 text-[10px] font-medium opacity-60"
                                                                style={{ color: LABELS[l], border: `1px solid ${LABELS[l]}44` }}
                                                            >
                                                                {l}
                                                            </span>
                                                        )}
                                                    </For>
                                                </div>
                                                <button
                                                    onClick={() => patchCard(c.id)((x) => (x.dismissed = false))}
                                                    class="text-highlight ml-auto text-xs font-bold hover:cursor-pointer hover:brightness-125"
                                                >
                                                    Restore
                                                </button>
                                                <button
                                                    onClick={() =>
                                                        props.mutate((p) => {
                                                            for (const m of p.milestones) {
                                                                const i = m.cards.findIndex((x) => x.id === c.id)
                                                                if (i >= 0) m.cards.splice(i, 1)
                                                            }
                                                        })
                                                    }
                                                    class="text-danger/70 hover:text-danger text-xs font-bold hover:cursor-pointer"
                                                >
                                                    Delete forever
                                                </button>
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
                <For each={trackList()}>
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
                    <For each={inTrack(t)}>
                    {(ms) => {
                        let panelEl: HTMLDivElement | undefined
                        const mi = () => props.project.milestones.findIndex((m) => m.id === ms.id)
                        return (
                        <div
                            ref={(el) => (panelEl = el)}
                            class="flex min-h-0 w-full flex-1 flex-col rounded-lg border transition-opacity"
                            classList={{
                                'opacity-40': dragCol() === ms.id,
                                'bg-element-matte/60 border-element-accent/50': props.look === 'lanes',
                                'bg-element border-element-accent': props.look === 'accent',
                            }}
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
                                    <span class="text-sub/50 shrink-0 font-mono text-[11px] font-bold">{mi() + 1}</span>
                                    <input
                                        type="text"
                                        value={ms.title}
                                        onChange={(e) =>
                                            props.mutate((p) => {
                                                const m = p.milestones.find((x) => x.id === ms.id)
                                                if (m) m.title = e.currentTarget.value
                                            })
                                        }
                                        class="bg-element-matte text-main font-serif border-element-accent focus:border-highlight min-w-0 flex-1 rounded-md border px-2 py-1 text-sm font-semibold focus:outline-none"
                                    />
                                    <button class="text-sub hover:text-danger shrink-0 hover:cursor-pointer" title="Delete milestone">
                                        <span class="material-symbols-outlined text-base">delete</span>
                                    </button>
                                </div>
                                <div class="flex items-center gap-2">
                                    <Show when={ms.due} fallback={<span class="text-sub/50 text-xs">No date</span>}>
                                        <span
                                            class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold"
                                            classList={{ 'bg-danger/20 text-danger': ms.overdue, 'bg-element-accent text-sub': !ms.overdue }}
                                        >
                                            <span class="material-symbols-outlined text-[12px]">event</span>
                                            {ms.due}
                                        </span>
                                    </Show>
                                    <span class="text-sub whitespace-nowrap text-xs">{doneCount(liveMs(ms))}/{liveMs(ms).length} done</span>
                                    <div class="ml-auto flex items-center gap-2">
                                        <Meter done={doneCount(liveMs(ms))} total={liveMs(ms).length} color={accent()} />
                                        <button
                                            onClick={() => setHiddenDone(ms.id, !hiddenDone[ms.id])}
                                            title={hiddenDone[ms.id] ? `Show ${doneCount(liveMs(ms))} completed` : 'Hide completed'}
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
                                            <p class="text-sub/50 text-xs italic">Nothing here yet. Type below, Enter adds.</p>
                                        </div>
                                    }
                                >
                                    <For each={panelCards(ms)}>
                                        {(c) => (
                                            <div
                                                draggable={true}
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
                                                    'bg-element border-element-accent shadow-sm': props.look === 'lanes',
                                                    'bg-element-matte border-element-accent': props.look === 'accent',
                                                }}
                                                class="group hover:border-highlight/40 flex cursor-grab flex-col gap-1.5 rounded-md border p-2 transition-all duration-150 hover:-translate-y-px hover:shadow-md"
                                                style={props.look === 'accent' && priorityColor(c.priority) ? { 'border-left': `3px solid ${priorityColor(c.priority)}` } : {}}
                                            >
                                                <div class="flex items-start gap-2">
                                                    <input
                                                        type="checkbox"
                                                        checked={c.done}
                                                        onClick={(e) => e.stopPropagation()}
                                                        onChange={() => patchCard(c.id)((x) => (x.done = !x.done))}
                                                        class="mt-0.5 h-4 w-4 shrink-0"
                                                    />
                                                    <span class="flex-1 break-words text-sm" classList={{ 'text-sub line-through': c.done, 'text-main': !c.done }}>
                                                        {c.title}
                                                    </span>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            removeCard(c)
                                                        }}
                                                        title={props.removal === 'dismiss' ? 'Dismiss (undoable)' : 'Delete'}
                                                        class="text-sub hover:text-danger shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:cursor-pointer"
                                                    >
                                                        <span class="material-symbols-outlined text-base">close</span>
                                                    </button>
                                                </div>
                                                <div class="flex items-center gap-1.5 pl-6">
                                                    <span class="text-sub/50 font-mono text-[10px] font-bold">{keyOf(props.project)}-{c.num}</span>
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
                                                        <For each={c.labels}>
                                                            {(l) => (
                                                                <span
                                                                    class="rounded px-1.5 text-[10px] font-medium"
                                                                    style={{ color: LABELS[l], border: `1px solid ${LABELS[l]}44`, 'background-color': `${LABELS[l]}14` }}
                                                                >
                                                                    {l}
                                                                </span>
                                                            )}
                                                        </For>
                                                    </div>
                                                    <div class="ml-auto flex shrink-0 items-center gap-1">
                                                        <Show when={c.notes.trim()}>
                                                            <span class="material-symbols-outlined text-sub text-[14px]" title="Has a body">notes</span>
                                                        </Show>
                                                        <Show when={c.subs.length > 0}>
                                                            <span
                                                                class="text-sub bg-element-accent rounded px-1.5 py-0.5 font-mono text-[10px] font-bold"
                                                                classList={{ 'text-highlight': c.subs.every((s) => s.done) }}
                                                                title="Subtasks complete"
                                                            >
                                                                {c.subs.filter((s) => s.done).length}/{c.subs.length}
                                                            </span>
                                                        </Show>
                                                        <Show when={c.due}>
                                                            <span class="bg-element-accent text-sub rounded px-1.5 py-0.5 text-[10px] font-bold">{c.due}</span>
                                                        </Show>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </For>
                                </Show>
                            </div>
                            <div class="p-3 pt-0">
                                <QuickAdd
                                    placeholder="Add a card…"
                                    onAdd={(titles) =>
                                        props.mutate((p) => {
                                            const m = p.milestones.find((x) => x.id === ms.id)
                                            if (!m) return
                                            for (const t of titles) if (t.trim()) m.cards.push(mkCard(t.trim()))
                                        })
                                    }
                                />
                            </div>
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
                <div
                    class="bg-element/40 border-element-accent flex w-72 shrink-0 flex-col gap-2 self-start rounded-lg border border-dashed p-3"
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
                        onClick={() =>
                            props.mutate((p) => {
                                p.milestones.push({
                                    id: uid(),
                                    title: 'New milestone',
                                    due: '',
                                    overdue: false,
                                    cards: [],
                                    track: Math.max(-1, ...p.milestones.map((m) => m.track)) + 1,
                                })
                            })
                        }
                        class="bg-highlight-strongest flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-xs text-white transition-[filter] hover:brightness-110 hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined text-sm">add</span>
                        New milestone
                    </button>
                </div>
            </div>

            </div>
            </Show>

            <Show when={toastVisible() && undoStack().length > 0}>
                <div class="bg-element-matte border-element-accent fixed bottom-16 left-4 z-50 flex items-center gap-3 rounded-lg border px-4 py-2 shadow-2xl">
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
                {(c) => <CardModal card={c()} style="document" patch={patchCard(c().id)} onClose={() => setEditId(null)} />}
            </Show>
        </div>
    )
}

const CardModal: Component<{
    card: Card
    style: 'checklist' | 'document' | 'both'
    patch: (fn: (c: Card) => void) => void
    onClose: () => void
}> = (props) => {
    const [preview, setPreview] = createSignal(true)
    const hasBody = () => props.style !== 'checklist'
    const hasSubs = () => props.style !== 'document'

    return (
        <div class="animate-fade-in fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={props.onClose}>
            <div
                onClick={(e) => e.stopPropagation()}
                class="bg-element-matte border-element-accent flex max-h-[85vh] w-full flex-col gap-3 overflow-y-auto rounded-2xl border p-5"
                classList={{ 'max-w-2xl': hasBody(), 'max-w-md': !hasBody() }}
            >
                <div class="flex items-start justify-between gap-2">
                    <input
                        type="text"
                        value={props.card.title}
                        onChange={(e) => props.patch((x) => (x.title = e.currentTarget.value))}
                        class="bg-element text-main font-serif border-element-accent focus:border-highlight min-w-0 flex-1 rounded-md border px-2 py-1.5 text-base font-semibold focus:outline-none"
                    />
                    <button onClick={props.onClose} class="text-sub hover:text-main shrink-0 hover:cursor-pointer" title="Close">
                        <span class="material-symbols-outlined text-lg">close</span>
                    </button>
                </div>

                <Show when={hasBody()}>
                    <div class="flex items-center gap-2">
                        <span class="text-sub text-[10px] font-bold uppercase tracking-wide">Body</span>
                        <div class="border-element-accent ml-auto flex overflow-hidden rounded-md border">
                            <button
                                onClick={() => setPreview(false)}
                                class="px-2 py-1 text-[11px] transition-colors hover:cursor-pointer"
                                classList={{ 'bg-highlight-strongest text-white': !preview(), 'text-sub hover:text-main': preview() }}
                            >
                                Write
                            </button>
                            <button
                                onClick={() => setPreview(true)}
                                class="px-2 py-1 text-[11px] transition-colors hover:cursor-pointer"
                                classList={{ 'bg-highlight-strongest text-white': preview(), 'text-sub hover:text-main': !preview() }}
                            >
                                Preview
                            </button>
                        </div>
                    </div>
                    <Show
                        when={preview() && props.card.notes.trim()}
                        fallback={
                            <textarea
                                value={props.card.notes}
                                onChange={(e) => props.patch((x) => (x.notes = e.currentTarget.value))}
                                placeholder={'Markdown body. Embeds work like in moments: ::todo:id:: for a live checklist, [[moment]] for a link.'}
                                rows={10}
                                class="bg-element text-main border-element-accent focus:border-highlight placeholder:text-sub/50 w-full resize-y rounded-md border px-3 py-2 font-mono text-xs leading-relaxed focus:outline-none"
                            />
                        }
                    >
                        <div class="bg-element border-element-accent rounded-md border p-3">
                            <BodyPreview text={props.card.notes} />
                        </div>
                    </Show>
                </Show>

                <Show when={!hasBody()}>
                    <textarea
                        value={props.card.notes}
                        onChange={(e) => props.patch((x) => (x.notes = e.currentTarget.value))}
                        placeholder="Notes…"
                        rows={3}
                        class="bg-element text-main border-element-accent focus:border-highlight placeholder:text-sub/50 w-full resize-none rounded-md border px-2 py-1.5 text-xs focus:outline-none"
                    />
                </Show>

                <Show when={hasSubs()}>
                    <div class="flex flex-col gap-1.5">
                        <div class="flex items-center gap-2">
                            <span class="text-sub text-[10px] font-bold uppercase tracking-wide">Checklist</span>
                            <Show when={props.card.subs.length > 0}>
                                <span class="text-sub font-mono text-[10px]">
                                    {props.card.subs.filter((s) => s.done).length}/{props.card.subs.length}
                                </span>
                                <div class="ml-auto flex items-center gap-2">
                                    <Meter done={props.card.subs.filter((s) => s.done).length} total={props.card.subs.length} class="w-24" />
                                </div>
                            </Show>
                        </div>
                        <For each={props.card.subs}>
                            {(s) => (
                                <div class="group flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={s.done}
                                        onChange={() =>
                                            props.patch((c) => {
                                                const sub = c.subs.find((x) => x.id === s.id)
                                                if (sub) sub.done = !sub.done
                                            })
                                        }
                                        class="h-4 w-4 shrink-0"
                                    />
                                    <span class="flex-1 text-sm" classList={{ 'text-sub line-through': s.done, 'text-main': !s.done }}>{s.text}</span>
                                    <button
                                        onClick={() =>
                                            props.patch((c) => {
                                                const i = c.subs.findIndex((x) => x.id === s.id)
                                                if (i >= 0) c.subs.splice(i, 1)
                                            })
                                        }
                                        class="text-sub hover:text-danger shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:cursor-pointer"
                                    >
                                        <span class="material-symbols-outlined text-base">close</span>
                                    </button>
                                </div>
                            )}
                        </For>
                        <QuickAdd
                            placeholder="Add a step…"
                            onAdd={(titles) =>
                                props.patch((c) => {
                                    for (const t of titles) if (t.trim()) c.subs.push({ id: uid(), text: t.trim(), done: false })
                                })
                            }
                        />
                    </div>
                </Show>

                <CardMeta card={props.card} patch={props.patch} />
            </div>
        </div>
    )
}

// ---- portfolio variants -----------------------------------------------------

const PORTFOLIO_TABS = [
    { key: 'active', label: 'Projects', icon: 'space_dashboard' },
    { key: 'archived', label: 'Archived', icon: 'inventory_2' },
] as const
type PortfolioTab = (typeof PORTFOLIO_TABS)[number]['key']

const PortfolioHeader: Component<{
    view: PortfolioTab
    setView: (v: PortfolioTab) => void
    counts: Record<PortfolioTab, number>
    onNew: () => void
}> = (props) => (
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
                        <span class="opacity-60">{props.counts[t.key]}</span>
                    </button>
                )}
            </For>
        </div>
        <div class="ml-auto">
            <NewProjectButton onNew={props.onNew} />
        </div>
    </div>
)

// The first meaningful non-heading line of the overview, stripped of markup:
// projects are few and large, so their cards can afford a voice.
const snippetOf = (p: Project) => {
    const line = p.overview
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && !l.startsWith('::') && !l.startsWith('- '))
    return line ? line.replace(/\*\*|\*|`/g, '').replace(/\[\[([^\]]+)\]\]/g, '$1') : ''
}

const PortfolioCovers: Component<{
    projects: Project[]
    view: PortfolioTab
    onOpen: (id: string) => void
    onRestore: (id: string) => void
}> = (props) => {
    const shown = () => props.projects.filter((p) => (props.view === 'archived' ? p.archived : !p.archived))
    return (
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
                                            {flat(p).length === 0 ? 0 : Math.round((doneCount(flat(p)) / flat(p).length) * 100)}%
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
                                        <For each={p.milestones.slice(0, 3)}>
                                            {(m, i) => (
                                                <p class="text-sub truncate text-xs" classList={{ 'text-main': nextMilestone(p)?.id === m.id }}>
                                                    {i() + 1}. {m.title} · {doneCount(live(m.cards))}/{live(m.cards).length}
                                                </p>
                                            )}
                                        </For>
                                        <Show when={p.milestones.length > 3}>
                                            <p class="text-sub/50 text-xs">+{p.milestones.length - 3} more</p>
                                        </Show>
                                    </div>
                                    <div class="shrink-0">
                                        <p class="text-sub/70 mb-1 text-right text-xs font-medium">Momentum · 14d</p>
                                        <MomentumBars p={p} height={32} color={p.accent} />
                                    </div>
                                </div>
                                <div class="border-element-accent/60 text-sub flex items-center gap-4 border-t pt-2.5 text-xs">
                                    <span>
                                        <span class="text-main font-mono font-bold">{flat(p).filter((c) => !c.done).length}</span> open
                                    </span>
                                    <span>
                                        <span class="text-main font-mono font-bold">{doneCount(flat(p))}</span> done
                                    </span>
                                    <span>
                                        <span class="font-mono font-bold" style={{ color: priorityColor(3) }}>
                                            {flat(p).filter((c) => !c.done && c.priority === 3).length}
                                        </span>{' '}
                                        high
                                    </span>
                                    <span>
                                        <span class="text-main font-mono font-bold">{flatAll(p).filter((c) => c.dismissed).length}</span> dismissed
                                    </span>
                                    <Show when={props.view === 'archived'}>
                                        <span
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                props.onRestore(p.id)
                                            }}
                                            class="text-highlight ml-auto font-bold hover:cursor-pointer hover:brightness-125"
                                        >
                                            Restore
                                        </span>
                                    </Show>
                                </div>
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    )
}

// ---- shell ------------------------------------------------------------------

export const ProjectsPrototype: Component = () => {
    const [projects, setProjects] = createStore<Project[]>(seed())
    const [open, setOpen] = createSignal<string | null>(null)
    const [pview, setPview] = createSignal<PortfolioTab>('active')
    const [variant, setVariant] = createSignal(new URLSearchParams(window.location.search).get('variant') || 'A')

    const openProject = () => projects.find((p) => p.id === open()) || null
    const mutateOpen = (fn: (p: Project) => void) =>
        setProjects(produce((arr) => {
            const p = arr.find((x) => x.id === open())
            if (p) fn(p)
        }))

    // Instant create, Tasks-style: no dialog, the new project opens ready to
    // rename and fill in.
    const newProject = () => {
        const id = uid()
        setProjects(produce((arr) => arr.push({ id, title: 'New project', momentum: Array(14).fill(0), milestones: [], archived: false, overview: '', accent: '#67b8c7', icon: 'space_dashboard' })))
        setOpen(id)
    }

    const setArchived = (id: string, archived: boolean) =>
        setProjects(produce((arr) => {
            const p = arr.find((x) => x.id === id)
            if (p) p.archived = archived
        }))

    return (
        <div class="text-main flex h-screen flex-col overflow-hidden" style={{ 'background-color': 'var(--theme-bg)' }}>
            <div class="border-element-accent bg-element-matte flex items-center gap-3 border-b px-5 py-1.5">
                <span class="text-sub/60 text-[11px]">
                    Grilling round 15 · overview hierarchy (document first, signals below), six demo projects with cover art · reload reseeds
                </span>
            </div>
            <Show
                when={openProject()}
                fallback={
                    <div class="flex min-h-0 flex-1 flex-col">
                        <PortfolioHeader
                            view={pview()}
                            setView={setPview}
                            counts={{ active: projects.filter((p) => !p.archived).length, archived: projects.filter((p) => p.archived).length }}
                            onNew={newProject}
                        />
                        <PortfolioCovers projects={projects} view={pview()} onOpen={setOpen} onRestore={(id) => setArchived(id, false)} />
                    </div>
                }
            >
                {(p) => (
                    <Hub
                        project={p()}
                        removal="dismiss"
                        look="accent"
                        onBack={() => setOpen(null)}
                        onArchive={() => {
                            setArchived(p().id, true)
                            setOpen(null)
                        }}
                        mutate={mutateOpen}
                    />
                )}
            </Show>
            <Switcher variants={[{ key: 'A', name: 'Round 12' }]} current={variant()} onPick={setVariant} />
        </div>
    )
}

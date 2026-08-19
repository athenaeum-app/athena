import {
    For,
    Match,
    Show,
    Switch,
    createEffect,
    createSignal,
    on,
    onCleanup,
    onMount,
    type Component,
    type JSX,
} from 'solid-js'
import { api, type TodoList, type TodoItem, type Canvas, type Moment, type Project } from '../api'
import { MarkdownText } from './MarkdownText'
import { LinkPreviewRow } from './LinkPreview'
import { CanvasThumbnail } from './CanvasThumbnail'
import { AttachmentList } from './AttachmentList'
import { LinkPreviewList } from './LinkPreview'
import { findBareUrls } from '../linkPreviews'
import { prefs } from '../prefs'
import { notifyTodoChanged, todoVersion } from '../todoBus'

// MomentBody renders moment content, interleaving markdown with live embeds of
// moments, todo lists, and canvases (ADR-0013, ADR-0015). An embed is a live
// reference: the token stores only the entity ID and the current state is
// fetched at render time. Token syntax (on or within a line):
//
//     [[<uuid>]]           moment  → compact card, opens the focused reader
//     ::todo:<uuid>::      todo    → live card, items checkable inline
//     ::canvas:<uuid>::    canvas  → compact card, opens the canvas board
//     ::project:<uuid>::   project → summary card: progress + overview excerpt
//
// Moment previews are NON-RECURSIVE (a flattened excerpt, never a nested
// MomentBody) so an embed cycle is structurally impossible (ADR-0015).
// Unknown/deleted/forbidden entities render a small "unavailable" chip.
//
// With the inlineLinkPreviews pref on, a bare URL is a fourth kind of split: the
// URL text is replaced by its preview card and the content resumes below it.

type EmbedKind = 'moment' | 'todo' | 'canvas' | 'project'

export type Part =
    | { type: 'md'; text: string }
    | { type: 'embed'; kind: EmbedKind; id: string }
    | { type: 'links'; urls: string[] }

// Matches a todo/canvas/project token OR a [[moment]] reference. Capture groups:
// 1 = the kind, 2 = its id; 3 = moment id (for the [[id]] form).
const TOKEN = /::(todo|canvas|project):([0-9a-fA-F-]{6,})::|\[\[([0-9a-fA-F-]{6,})\]\]/g

const THEMATIC_BREAK = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/m
const TRAILING_BULLET = /(?:^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]*$/

// Text that only ever existed to carry links which are now cards: whitespace,
// list bullets, blockquote markers. A run of links written as a bullet list is
// still a run, and leaving the markers behind renders a column of empty bullets
// beside the row. A thematic break is real content and stops the run.
function isScaffold(text: string): boolean {
    if (THEMATIC_BREAK.test(text)) return false
    return text.replace(/\d+[.)]/g, '').replace(/[\s>*+-]/g, '') === ''
}

export function parse(content: string, inlineLinks = false): Part[] {
    const cuts: { start: number; end: number; part: Part }[] = []

    TOKEN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = TOKEN.exec(content)) !== null) {
        const part: Part = m[3]
            ? { type: 'embed', kind: 'moment', id: m[3] }
            : { type: 'embed', kind: m[1] as 'todo' | 'canvas' | 'project', id: m[2] }
        cuts.push({ start: m.index, end: m.index + m[0].length, part })
    }
    if (inlineLinks) {
        for (const u of findBareUrls(content)) {
            cuts.push({ start: u.start, end: u.end, part: { type: 'links', urls: [u.url] } })
        }
    }
    cuts.sort((a, b) => a.start - b.start)

    const parts: Part[] = []
    let last = 0
    for (const cut of cuts) {
        if (cut.start < last) continue
        if (cut.start > last) parts.push({ type: 'md', text: content.slice(last, cut.start) })
        parts.push(cut.part)
        last = cut.end
    }
    if (last < content.length) parts.push({ type: 'md', text: content.slice(last) })
    return inlineLinks ? mergeLinkRuns(parts) : parts
}

// Links written back to back collapse into one row. The text between them has
// to be scaffolding: any real words mean the author was introducing each link
// separately, and a shared row would put both cards above the words for one.
function mergeLinkRuns(parts: Part[]): Part[] {
    const kept: Part[] = []
    parts.forEach((part, i) => {
        const nextIsLinks = parts[i + 1]?.type === 'links'
        if (part.type === 'md' && isScaffold(part.text)) {
            if (parts[i - 1]?.type === 'links' || nextIsLinks) return
        }
        if (part.type === 'md' && nextIsLinks) {
            kept.push({ type: 'md', text: part.text.replace(TRAILING_BULLET, '') })
            return
        }
        kept.push(part)
    })

    const out: Part[] = []
    for (const part of kept) {
        const prev = out[out.length - 1]
        if (part.type === 'links' && prev?.type === 'links') {
            out[out.length - 1] = { type: 'links', urls: [...prev.urls, ...part.urls] }
            continue
        }
        out.push(part)
    }
    return out
}

// excerpt flattens moment markdown to a short plain-text summary for compact
// previews: strips embed tokens, images, and light markdown syntax so a moment
// preview never recurses into another render (ADR-0015). Exported because the
// canvas draws the same flattened summary on a node too small for a body.
export function excerpt(content: string, max = 180): string {
    let text = content || ''
    text = text.replace(/::(todo|canvas|project):[0-9a-fA-F-]{6,}::/g, '')
    text = text.replace(/\[\[[0-9a-fA-F-]{6,}\]\]/g, '')
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links, reduced to their text
    text = text.replace(/[#>*_`~]/g, '') // light markdown syntax
    text = text.replace(/\s+/g, ' ').trim()
    return text.length > max ? text.slice(0, max).trimEnd() + '…' : text
}

export interface MomentBodyProps {
    content: string
    class?: string
    resolveRef?: (id: string) => string | undefined
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
    // Set on the body rendered inside a moment preview. It is the whole of the
    // depth cap: a nested body draws its own moment references as compact
    // cards, so a cycle terminates on the second hop (ADR-0017).
    nested?: boolean
    // Overrides the inlineLinkPreviews reading preference for this body. A
    // canvas node is smaller than one preview card and every card is a fetch,
    // so the board turns them off whatever the reader chose for the feed.
    inlineLinks?: boolean
}

export const MomentBody: Component<MomentBodyProps> = (props) => {
    const parts = () => parse(props.content || '', props.inlineLinks ?? prefs().inlineLinkPreviews)
    return (
        <div class="flex w-full flex-col gap-2">
            <For each={parts()}>
                {(part) => (
                    <Switch>
                        <Match when={part.type === 'md' ? part : null}>
                            {(md) => (
                                <Show when={md().text.trim()}>
                                    <MarkdownText content={md().text} class={props.class} />
                                </Show>
                            )}
                        </Match>
                        <Match when={part.type === 'links' ? part : null}>
                            {(links) => <LinkPreviewRow urls={links().urls} />}
                        </Match>
                        <Match when={part.type === 'embed' && part.kind === 'moment' ? part : null}>
                            {(e) => (
                                <MomentEmbed
                                    id={e().id}
                                    onOpen={props.onOpenMoment}
                                    onOpenTodo={props.onOpenTodo}
                                    onOpenCanvas={props.onOpenCanvas}
                                    onOpenProject={props.onOpenProject}
                                    resolveRef={props.resolveRef}
                                    nested={props.nested}
                                />
                            )}
                        </Match>
                        <Match when={part.type === 'embed' && part.kind === 'todo' ? part : null}>
                            {(e) => <TodoEmbed id={e().id} onOpen={props.onOpenTodo} />}
                        </Match>
                        <Match when={part.type === 'embed' && part.kind === 'canvas' ? part : null}>
                            {(e) => <CanvasEmbed id={e().id} onOpen={props.onOpenCanvas} />}
                        </Match>
                        <Match when={part.type === 'embed' && part.kind === 'project' ? part : null}>
                            {(e) => <ProjectEmbed id={e().id} onOpen={props.onOpenProject} />}
                        </Match>
                    </Switch>
                )}
            </For>
        </div>
    )
}

// A clickable embed card. Keyboard-accessible (Enter/Space) when onOpen is set.
const CardShell: Component<{
    icon: string
    label: string
    onOpen?: () => void
    children?: JSX.Element
}> = (props) => {
    const interactive = () => !!props.onOpen
    return (
        <div
            role={interactive() ? 'button' : undefined}
            tabindex={interactive() ? 0 : undefined}
            onClick={() => props.onOpen?.()}
            onKeyDown={(e) => {
                if (props.onOpen && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    props.onOpen()
                }
            }}
            // The card draws its own surface, so a host tinting the text around
            // it (a coloured canvas node) has to stop at this boundary.
            data-embed-card
            class="bg-element-matte border-element-accent rounded-lg border p-3 transition-colors"
            classList={{ 'hover:border-highlight cursor-pointer': interactive() }}
        >
            <div class="text-sub mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest">
                <span class="material-symbols-outlined text-sm">{props.icon}</span>
                <span class="truncate">{props.label}</span>
                <Show when={interactive()}>
                    <span class="material-symbols-outlined ml-auto text-sm opacity-50">open_in_new</span>
                </Show>
            </div>
            {props.children}
        </div>
    )
}

const UnavailableChip: Component<{ icon: string; label: string }> = (props) => (
    <span
        data-embed-card
        class="bg-element border-element-accent text-sub/70 inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-xs font-bold"
    >
        <span class="material-symbols-outlined text-sm">{props.icon}</span>
        {props.label}
    </span>
)

// The referenced moment rendered the way the main column renders it, clipped to
// a share of the window. Only ever one level deep: the body inside is `nested`,
// so its own references fall back to the compact card (ADR-0017).
const MomentPreview: Component<{
    moment: Moment
    resolveRef?: (id: string) => string | undefined
    onOpenMoment?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
}> = (props) => {
    const [clipped, setClipped] = createSignal(false)
    let frame: HTMLDivElement | undefined
    let content: HTMLDivElement | undefined

    onMount(() => {
        if (!frame || !content || typeof ResizeObserver === 'undefined') return
        // The frame is what stops growing, so the content is what has to be
        // watched: an image or an embed landing late is exactly when a preview
        // crosses the line from whole to clipped.
        const check = () => setClipped(content!.offsetHeight > frame!.clientHeight + 1)
        const observer = new ResizeObserver(check)
        observer.observe(content)
        onCleanup(() => observer.disconnect())
    })

    return (
        // Clicks stay inside: the preview holds real links, images that open the
        // lightbox and checkable todo rows, and the card's own open-the-reader
        // handler would fire under every one of them. The header still opens it.
        <div
            data-testid="moment-preview"
            onClick={(e) => e.stopPropagation()}
            ref={frame}
            class="relative overflow-hidden"
            style={{ 'max-height': `${prefs().momentEmbedPreviewHeight}vh` }}
        >
            <div ref={content}>
                <MomentBody
                    content={props.moment.content}
                    class="text-sub text-sm"
                    nested
                    resolveRef={props.resolveRef}
                    onOpenMoment={props.onOpenMoment}
                    onOpenTodo={props.onOpenTodo}
                    onOpenCanvas={props.onOpenCanvas}
                    onOpenProject={props.onOpenProject}
                />
                <AttachmentList content={props.moment.content} />
                <LinkPreviewList content={props.moment.content} />
            </div>
            <Show when={clipped()}>
                <div class="from-element-matte pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent" />
            </Show>
        </div>
    )
}

const MomentEmbed: Component<{
    id: string
    onOpen?: (id: string) => void
    onOpenTodo?: (id: string) => void
    onOpenCanvas?: (id: string) => void
    onOpenProject?: (id: string) => void
    resolveRef?: (id: string) => string | undefined
    nested?: boolean
}> = (props) => {
    const [moment, setMoment] = createSignal<Moment | null | undefined>(undefined)
    // A preview inside a preview is the cycle, so depth decides this before the
    // pref does.
    const preview = () => prefs().momentEmbedPreview && !props.nested
    onMount(async () => {
        try {
            setMoment((await api.getMoment(props.id)) ?? null)
        } catch {
            setMoment(null)
        }
    })
    return (
        <Show
            when={moment()}
            fallback={
                <Show
                    when={moment() === null}
                    fallback={<CardShell icon="description" label="Loading moment…" />}
                >
                    <UnavailableChip icon="description" label="Moment unavailable" />
                </Show>
            }
        >
            {(mo) => (
                <CardShell
                    icon="description"
                    label={mo().title || props.resolveRef?.(props.id) || 'Untitled'}
                    onOpen={props.onOpen ? () => props.onOpen!(props.id) : undefined}
                >
                    <Show
                        when={preview()}
                        fallback={
                            <Show when={excerpt(mo().content)}>
                                <p class="text-sub line-clamp-3 text-sm">{excerpt(mo().content)}</p>
                            </Show>
                        }
                    >
                        <MomentPreview
                            moment={mo()}
                            resolveRef={props.resolveRef}
                            onOpenMoment={props.onOpen}
                            onOpenTodo={props.onOpenTodo}
                            onOpenCanvas={props.onOpenCanvas}
                            onOpenProject={props.onOpenProject}
                        />
                    </Show>
                </CardShell>
            )}
        </Show>
    )
}

// The live half of a todo embed, split out from the card so the canvas can put
// the same checkable list inside a node instead of the feed's card chrome. It
// owns the fetch because "which list" is reactive there: replacing a canvas
// node's referenced list swaps the id under a mounted component.
//
// undefined = still loading, null = gone or forbidden.
export function createTodoEmbed(id: () => string) {
    const [list, setList] = createSignal<TodoList | null | undefined>(undefined)
    const fetchList = async () => {
        const wanted = id()
        try {
            const fetched = (await api.getTodoList(wanted)) ?? null
            // A slower answer for a list we no longer point at must not land.
            if (id() === wanted) setList(fetched)
        } catch {
            if (id() === wanted) setList(null)
        }
    }
    createEffect(
        on(id, () => {
            setList(undefined)
            void fetchList()
        }),
    )
    // The embed otherwise only ever fetches once, so edits made elsewhere (the
    // full Todo board, or another embed of the same list) wouldn't show up here
    // without the moment being resaved. Refetch when todoBus reports a change.
    createEffect(
        on(
            () => todoVersion(id()),
            (_v, prevV) => {
                if (prevV !== undefined) void fetchList()
            },
        ),
    )

    // Optimistic inline toggle: flip locally, patch, revert on failure.
    const toggle = async (itemId: string, next: boolean) => {
        const patch = (done: boolean) =>
            setList((l) => (l ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, done } : i)) } : l))
        patch(next)
        try {
            await api.updateTodoItem(itemId, { done: next })
            notifyTodoChanged(id())
        } catch {
            patch(!next)
        }
    }

    return { list, toggle }
}

// Progress meter over checkable rows. Presentational: the caller owns the state
// and the surrounding chrome, which is the whole reason this is not baked into
// TodoEmbed.
export const TodoChecklist: Component<{
    list: TodoList
    onToggle: (itemId: string, next: boolean) => void
}> = (props) => {
    const items = () => props.list.items || []
    const done = () => items().filter((i) => i.done).length
    const total = () => items().length

    // Nesting is one level (a subtask can't have subtasks), same as the board.
    const topLevel = () => items().filter((i) => !i.parent_id)
    const childrenOf = (parentId: string) => items().filter((i) => i.parent_id === parentId)

    // One checkable row, shared by a task and its subtasks so a subtask reads
    // and behaves exactly like its parent, only indented.
    const ItemRow: Component<{ item: TodoItem }> = (row) => (
        <button
            type="button"
            // Don't let a checkbox click bubble to the card's open handler.
            onClick={(e) => {
                e.stopPropagation()
                props.onToggle(row.item.id, !row.item.done)
            }}
            // Canvas nodes drag from anywhere on their body; a checkbox must
            // check rather than start a drag.
            onPointerDown={(e) => e.stopPropagation()}
            class="text-sub hover:text-main flex items-center gap-2 text-left text-sm transition-colors"
        >
            <span class="material-symbols-outlined text-base" classList={{ 'text-highlight-strongest': row.item.done }}>
                {row.item.done ? 'check_box' : 'check_box_outline_blank'}
            </span>
            <span classList={{ 'line-through opacity-60': row.item.done }}>{row.item.text}</span>
        </button>
    )

    return (
        <>
            <Show when={total() > 0}>
                <div class="bg-element mb-2 h-1.5 w-full shrink-0 overflow-hidden rounded-full">
                    <div
                        class="bg-highlight-strongest h-full rounded-full transition-all"
                        style={{ width: `${Math.round((done() / total()) * 100)}%` }}
                    />
                </div>
            </Show>
            <div class="flex flex-col gap-1">
                <For each={topLevel()}>
                    {(item) => (
                        <div class="flex flex-col gap-1">
                            <ItemRow item={item} />
                            {/* Indented behind a rule, the way the Todo board
                                draws the same relationship. Flat, a subtask was
                                indistinguishable from a task of its own and the
                                pairing was simply lost. */}
                            <Show when={childrenOf(item.id).length > 0}>
                                <div
                                    data-testid="todo-embed-subtasks"
                                    class="border-element-accent ml-2 flex flex-col gap-1 border-l pl-2.5"
                                >
                                    <For each={childrenOf(item.id)}>{(sub) => <ItemRow item={sub} />}</For>
                                </div>
                            </Show>
                        </div>
                    )}
                </For>
            </div>
        </>
    )
}

const TodoEmbed: Component<{ id: string; onOpen?: (id: string) => void }> = (props) => {
    const { list, toggle } = createTodoEmbed(() => props.id)
    return (
        <Show
            when={list()}
            fallback={
                <Show when={list() === null} fallback={<CardShell icon="checklist" label="Loading todo…" />}>
                    <UnavailableChip icon="checklist" label="Todo list unavailable" />
                </Show>
            }
        >
            {(l) => (
                <CardShell
                    icon="checklist"
                    label={l().title || 'Todo'}
                    onOpen={props.onOpen ? () => props.onOpen!(props.id) : undefined}
                >
                    <TodoChecklist list={l()} onToggle={(itemId, next) => void toggle(itemId, next)} />
                </CardShell>
            )}
        </Show>
    )
}

const CanvasEmbed: Component<{ id: string; onOpen?: (id: string) => void }> = (props) => {
    const [canvas, setCanvas] = createSignal<Canvas | null | undefined>(undefined)
    onMount(async () => {
        try {
            setCanvas((await api.getCanvas(props.id)) ?? null)
        } catch {
            setCanvas(null)
        }
    })
    return (
        <Show
            when={canvas()}
            fallback={
                <Show when={canvas() === null} fallback={<CardShell icon="dashboard" label="Loading canvas…" />}>
                    <UnavailableChip icon="dashboard" label="Canvas unavailable" />
                </Show>
            }
        >
            {(c) => (
                <CardShell
                    icon="dashboard"
                    label={c().title || 'Canvas'}
                    onOpen={props.onOpen ? () => props.onOpen!(props.id) : undefined}
                >
                    <p class="text-sub text-xs">
                        {c().nodes.length} node{c().nodes.length === 1 ? '' : 's'}
                    </p>
                    <Show when={prefs().canvasEmbedPreview}>
                        <div class="mt-2">
                            <CanvasThumbnail canvas={c()} />
                        </div>
                    </Show>
                </CardShell>
            )}
        </Show>
    )
}

// A project summary: completion meter in the project's accent, the overview
// flattened to an excerpt (never a nested render), and the open/done counts.
// Presentational, so the canvas can draw the same summary inside a node.
export const ProjectSummary: Component<{ project: Project }> = (props) => {
    const liveCards = () => (props.project.cards || []).filter((c) => !c.dismissed)
    const done = () => liveCards().filter((c) => c.done).length
    const pct = () => (liveCards().length === 0 ? 0 : Math.round((done() / liveCards().length) * 100))
    const milestones = () => (props.project.milestones || []).length
    return (
        <>
            <div class="mb-2 flex shrink-0 items-center gap-2">
                <div class="bg-element h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
                    <div
                        class="h-full rounded-full transition-all"
                        style={{
                            width: `${pct()}%`,
                            'background-color': props.project.accent || 'var(--color-highlight-strongest)',
                        }}
                    />
                </div>
                <span class="text-sub shrink-0 font-mono text-xs font-bold">{pct()}%</span>
            </div>
            <Show when={excerpt(props.project.overview || '', 220)}>
                <p class="text-sub line-clamp-3 text-sm">{excerpt(props.project.overview || '', 220)}</p>
            </Show>
            <p class="text-sub/70 mt-2 shrink-0 text-xs">
                {liveCards().filter((c) => !c.done).length} open · {done()} done · {milestones()} milestone
                {milestones() === 1 ? '' : 's'}
            </p>
        </>
    )
}

const ProjectEmbed: Component<{ id: string; onOpen?: (id: string) => void }> = (props) => {
    const [project, setProject] = createSignal<Project | null | undefined>(undefined)
    onMount(async () => {
        try {
            setProject((await api.getProject(props.id)) ?? null)
        } catch {
            setProject(null)
        }
    })
    return (
        <Show
            when={project()}
            fallback={
                <Show when={project() === null} fallback={<CardShell icon="space_dashboard" label="Loading project…" />}>
                    <UnavailableChip icon="space_dashboard" label="Project unavailable" />
                </Show>
            }
        >
            {(p) => (
                <CardShell
                    icon={p().icon || 'space_dashboard'}
                    label={p().title || 'Untitled project'}
                    onOpen={props.onOpen ? () => props.onOpen!(props.id) : undefined}
                >
                    <ProjectSummary project={p()} />
                </CardShell>
            )}
        </Show>
    )
}

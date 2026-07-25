import { For, Show, createEffect, createSignal, on, onMount, type Component, type JSX } from 'solid-js'
import { api, type TodoList, type Canvas, type Moment } from '../api'
import { MarkdownText } from './MarkdownText'
import { notifyTodoChanged, todoVersion } from '../todoBus'

// MomentBody renders moment content, interleaving markdown with live embeds of
// moments, todo lists, and canvases (ADR-0013, ADR-0015). An embed is a live
// reference: the token stores only the entity ID and the current state is
// fetched at render time. Token syntax (on or within a line):
//
//     [[<uuid>]]           moment  → compact card, opens the focused reader
//     ::todo:<uuid>::      todo    → live card, items checkable inline
//     ::canvas:<uuid>::    canvas  → compact card, opens the canvas board
//
// Moment previews are NON-RECURSIVE (a flattened excerpt, never a nested
// MomentBody) so an embed cycle is structurally impossible (ADR-0015).
// Unknown/deleted/forbidden entities render a small "unavailable" chip.

type EmbedKind = 'moment' | 'todo' | 'canvas'

type Part =
    | { type: 'md'; text: string }
    | { type: 'embed'; kind: EmbedKind; id: string }

// Matches a todo/canvas token OR a [[moment]] reference. Capture groups:
// 1 = 'todo'|'canvas', 2 = its id; 3 = moment id (for the [[id]] form).
const TOKEN = /::(todo|canvas):([0-9a-fA-F-]{6,})::|\[\[([0-9a-fA-F-]{6,})\]\]/g

function parse(content: string): Part[] {
    const parts: Part[] = []
    let last = 0
    let m: RegExpExecArray | null
    TOKEN.lastIndex = 0
    while ((m = TOKEN.exec(content)) !== null) {
        if (m.index > last) parts.push({ type: 'md', text: content.slice(last, m.index) })
        if (m[3]) {
            parts.push({ type: 'embed', kind: 'moment', id: m[3] })
        } else {
            parts.push({ type: 'embed', kind: m[1] as 'todo' | 'canvas', id: m[2] })
        }
        last = m.index + m[0].length
    }
    if (last < content.length) parts.push({ type: 'md', text: content.slice(last) })
    return parts
}

// excerpt flattens moment markdown to a short plain-text summary for compact
// previews: strips embed tokens, images, and light markdown syntax so a moment
// preview never recurses into another render (ADR-0015).
function excerpt(content: string, max = 180): string {
    let text = content || ''
    text = text.replace(/::(todo|canvas):[0-9a-fA-F-]{6,}::/g, '')
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
}

export const MomentBody: Component<MomentBodyProps> = (props) => {
    const parts = () => parse(props.content || '')
    return (
        <div class="flex w-full flex-col gap-2">
            <For each={parts()}>
                {(part) => (
                    <Show
                        when={part.type === 'embed' ? part : null}
                        fallback={
                            <Show when={(part as { text: string }).text.trim()}>
                                <MarkdownText content={(part as { text: string }).text} class={props.class} />
                            </Show>
                        }
                    >
                        {(embed) => (
                            <Show
                                when={embed().kind === 'moment'}
                                fallback={
                                    <Show
                                        when={embed().kind === 'todo'}
                                        fallback={<CanvasEmbed id={embed().id} onOpen={props.onOpenCanvas} />}
                                    >
                                        <TodoEmbed id={embed().id} onOpen={props.onOpenTodo} />
                                    </Show>
                                }
                            >
                                <MomentEmbed id={embed().id} onOpen={props.onOpenMoment} resolveRef={props.resolveRef} />
                            </Show>
                        )}
                    </Show>
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
    <span class="bg-element border-element-accent text-sub/70 inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-xs font-bold">
        <span class="material-symbols-outlined text-sm">{props.icon}</span>
        {props.label}
    </span>
)

const MomentEmbed: Component<{
    id: string
    onOpen?: (id: string) => void
    resolveRef?: (id: string) => string | undefined
}> = (props) => {
    const [moment, setMoment] = createSignal<Moment | null | undefined>(undefined)
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
                    <Show when={excerpt(mo().content)}>
                        <p class="text-sub line-clamp-3 text-sm">{excerpt(mo().content)}</p>
                    </Show>
                </CardShell>
            )}
        </Show>
    )
}

const TodoEmbed: Component<{ id: string; onOpen?: (id: string) => void }> = (props) => {
    const [list, setList] = createSignal<TodoList | null | undefined>(undefined)
    const fetchList = async () => {
        try {
            setList((await api.getTodoList(props.id)) ?? null)
        } catch {
            setList(null)
        }
    }
    onMount(fetchList)
    // The embed otherwise only ever fetches once on mount, so edits made
    // elsewhere (the full Todo board, or another embed of the same list)
    // wouldn't show up here without the moment being resaved. Refetch when
    // todoBus reports this list changed.
    createEffect(
        on(
            () => todoVersion(props.id),
            (_v, prevV) => {
                if (prevV !== undefined) void fetchList()
            },
        ),
    )
    const done = () => (list()?.items || []).filter((i) => i.done).length
    const total = () => (list()?.items || []).length

    // Optimistic inline toggle: flip locally, patch, revert on failure.
    const toggle = async (itemId: string, next: boolean) => {
        setList((l) =>
            l ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, done: next } : i)) } : l,
        )
        try {
            await api.updateTodoItem(itemId, { done: next })
            notifyTodoChanged(props.id)
        } catch {
            setList((l) =>
                l ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, done: !next } : i)) } : l,
            )
        }
    }

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
                    <Show when={total() > 0}>
                        <div class="bg-element mb-2 h-1.5 w-full overflow-hidden rounded-full">
                            <div
                                class="bg-highlight-strongest h-full rounded-full transition-all"
                                style={{ width: `${Math.round((done() / total()) * 100)}%` }}
                            />
                        </div>
                    </Show>
                    <div class="flex flex-col gap-1">
                        <For each={l().items}>
                            {(item) => (
                                <button
                                    type="button"
                                    // Don't let a checkbox click bubble to the card's open handler.
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        void toggle(item.id, !item.done)
                                    }}
                                    class="text-sub hover:text-main flex items-center gap-2 text-left text-sm transition-colors"
                                >
                                    <span
                                        class="material-symbols-outlined text-base"
                                        classList={{ 'text-highlight-strongest': item.done }}
                                    >
                                        {item.done ? 'check_box' : 'check_box_outline_blank'}
                                    </span>
                                    <span classList={{ 'line-through opacity-60': item.done }}>{item.text}</span>
                                </button>
                            )}
                        </For>
                    </div>
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
                </CardShell>
            )}
        </Show>
    )
}

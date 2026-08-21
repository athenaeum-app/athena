import { createSignal, createEffect, on, onCleanup, untrack, type Accessor } from 'solid-js'
import { api } from './api'
import { documentPath } from './projectDocuments'

// The one search behind every Embed picker (ADR-0019). `[[` in a composer and
// the slash menu's per-kind dialog both run this: one place that knows which
// kinds exist, how to find things of each kind, and what token each one is
// stored as.
//
// Adding a kind is one entry in EMBED_KINDS below: where its candidates come
// from, how it is badged, and the token it inserts. Nothing else in the client
// enumerates kinds.

// What a kind's source hands back. Deliberately without the kind itself, so a
// source never has to name itself and the type stays independent of the
// registry that derives EmbedKind from it.
export interface EmbedItem {
    id: string
    title: string
    // Second line in the list, and matched on when the source has no search of
    // its own: an excerpt, a count, whatever tells two entries apart.
    sub?: string
}

interface EmbedKindShape {
    kind: string
    // Singular, for the badge and the group heading.
    label: string
    icon: string
    // Slash menu right-hand hint.
    hint: string
    // Heading when the slash menu opens this kind on its own.
    dialogTitle: string
    // What gets written into the body once something is picked.
    token: (id: string) => string
    // Everything pickable of this kind. Cached, then filtered in the client.
    load: () => Promise<EmbedItem[]>
    // Server-side search, when the kind has one. Without it a query is matched
    // against the loaded list.
    search?: (query: string) => Promise<EmbedItem[]>
}

const momentItems = (moments: { id: string; title: string; content: string }[]): EmbedItem[] =>
    moments.map((m) => ({ id: m.id, title: m.title || 'Untitled', sub: m.content }))

export const EMBED_KINDS = [
    {
        kind: 'moment',
        label: 'Moment',
        icon: 'description',
        hint: 'link a moment',
        dialogTitle: 'Link a moment',
        // Unchanged storage per ADR-0015: a moment stays a wiki-style token.
        token: (id: string) => `[[${id}]]`,
        load: async () => momentItems((await api.listMoments({ limit: 100 })) ?? []),
        // The server's full-text index, so a match does not depend on what the
        // reader has scrolled past.
        search: async (query: string) => momentItems((await api.listMoments({ q: query, limit: 20 })) ?? []),
    },
    {
        kind: 'todo',
        label: 'To-do list',
        icon: 'checklist',
        hint: 'embed a list',
        dialogTitle: 'Embed a to-do list',
        token: (id: string) => `::todo:${id}::`,
        load: async () =>
            ((await api.listTodos()) ?? []).map((l) => ({
                id: l.id,
                title: l.title || 'Untitled list',
                sub: `${(l.items || []).length} items`,
            })),
    },
    {
        kind: 'canvas',
        label: 'Canvas',
        icon: 'dashboard',
        hint: 'embed a canvas',
        dialogTitle: 'Embed a canvas',
        token: (id: string) => `::canvas:${id}::`,
        load: async () =>
            ((await api.listCanvases()) ?? []).map((c) => ({ id: c.id, title: c.title || 'Untitled canvas' })),
    },
    {
        kind: 'project',
        label: 'Project',
        icon: 'space_dashboard',
        hint: 'embed a project',
        dialogTitle: 'Embed a project',
        token: (id: string) => `::project:${id}::`,
        load: async () =>
            ((await api.listProjects()) ?? [])
                .filter((p) => !p.archived)
                .map((p) => ({
                    id: p.id,
                    title: p.title || 'Untitled project',
                    sub: `${(p.cards || []).filter((c) => !c.dismissed).length} cards`,
                })),
    },
    {
        kind: 'doc',
        label: 'Document',
        icon: 'article',
        hint: 'embed a document',
        dialogTitle: 'Embed a document',
        token: (id: string) => `::doc:${id}::`,
        // Documents have no list endpoint of their own: the whole tree comes
        // nested in each project (ADR-0020), so flattening the projects is the
        // list. Folders are containers, not embeddable content, so they are
        // dropped here rather than offered and then failing to render.
        load: async () =>
            ((await api.listProjects()) ?? [])
                .filter((p) => !p.archived)
                .flatMap((project) => {
                    const documents = project.documents || []
                    return documents
                        .filter((d) => d.kind === 'document')
                        .map((d) => ({
                            id: d.id,
                            title: d.title || 'Untitled document',
                            // Where it lives, so two documents named "Notes"
                            // are told apart by the path rather than by luck.
                            sub: [project.title || 'Untitled project', ...documentPath(documents, d.parent_id ?? null).map((f) => f.title)].join(
                                ' / ',
                            ),
                        }))
                }),
    },
    {
        kind: 'agenda',
        label: 'Agenda',
        icon: 'event_upcoming',
        hint: 'embed the agenda',
        dialogTitle: 'Embed the agenda',
        // The only kind whose second segment is a scope rather than an id: an
        // agenda is a question about everything you own, not one row that can
        // be pointed at (ADR-0021). The registry does not care, because a
        // token is a string built from what the picker chose either way.
        token: (scope: string) => `::agenda:${scope}::`,
        // Fixed, and not fetched: these three are the agenda, so there is
        // nothing to look up and nothing that can be missing.
        load: async () => [
            { id: 'all', title: 'Agenda: everything due', sub: 'Tasks and project deadlines together' },
            { id: 'tasks', title: 'Agenda: tasks only', sub: 'Dated items from your to-do lists' },
            { id: 'projects', title: 'Agenda: project work only', sub: 'Dated cards and milestones' },
        ],
    },
] as const satisfies readonly EmbedKindShape[]

export type EmbedKind = (typeof EMBED_KINDS)[number]['kind']

export interface EmbedKindSpec extends Omit<EmbedKindShape, 'kind'> {
    kind: EmbedKind
}

export interface EmbedCandidate extends EmbedItem {
    kind: EmbedKind
}

// The same registry, widened off the literal types the const assertion gave it,
// so a lookup by kind reads as one spec rather than a union of four.
const specs: readonly EmbedKindSpec[] = EMBED_KINDS

export const embedKindSpec = (kind: EmbedKind): EmbedKindSpec => specs.find((k) => k.kind === kind) as EmbedKindSpec

export const isEmbedKind = (value: string): value is EmbedKind => specs.some((k) => k.kind === value)

// The canonical token for a picked entity. The query text that found it is a
// search key, not content, and is thrown away.
export const embedToken = (kind: EmbedKind, id: string): string => embedKindSpec(kind).token(id)

// --- the `[[` trigger -------------------------------------------------------

export interface EmbedTrigger {
    // null searches every kind; a kind narrows to it.
    kind: EmbedKind | null
    query: string
    // Index of the opening `[[` in the text, which is where the token goes.
    start: number
}

// Reads the text behind the caret and says whether a picker is being typed.
// `[[groc` searches everything; `[[todo:groc` searches to-do lists only. A
// colon that does not name a kind is just part of the query, so `[[note: buy`
// still searches for the whole string.
export function parseEmbedTrigger(before: string): EmbedTrigger | null {
    const match = before.match(/\[\[([^[\]\n]*)$/)
    if (!match) return null
    const raw = match[1]
    const start = before.length - match[0].length
    const colon = raw.indexOf(':')
    if (colon > 0) {
        const prefix = raw.slice(0, colon).trim().toLowerCase()
        if (isEmbedKind(prefix)) return { kind: prefix, query: raw.slice(colon + 1).replace(/^\s+/, ''), start }
    }
    return { kind: null, query: raw, start }
}

// --- matching and grouping --------------------------------------------------

// Title matches beat body matches, and a title that starts with the query beats
// one that merely contains it. Used for the kinds with no server-side search,
// and as the in-memory answer while a search is in flight.
export function matchEmbedItems<T extends EmbedItem>(items: readonly T[], query: string, limit = Infinity): T[] {
    const needle = query.trim().toLowerCase()
    if (!needle) return items.slice(0, limit)
    const scored: { rank: number; item: T }[] = []
    for (const item of items) {
        const title = item.title.toLowerCase()
        const at = title.indexOf(needle)
        if (at === 0) scored.push({ rank: 0, item })
        else if (at > 0) scored.push({ rank: 1, item })
        else if ((item.sub || '').toLowerCase().includes(needle)) scored.push({ rank: 2, item })
    }
    scored.sort((a, b) => a.rank - b.rank)
    return scored.slice(0, limit).map((s) => s.item)
}

export interface EmbedGroup {
    kind: EmbedKind
    label: string
    icon: string
    items: EmbedCandidate[]
}

// Results come out of the search in registry order already; grouping only
// collects them so the list can carry one heading per kind.
export function groupEmbedCandidates(candidates: readonly EmbedCandidate[]): EmbedGroup[] {
    const groups: EmbedGroup[] = []
    for (const spec of EMBED_KINDS) {
        const items = candidates.filter((c) => c.kind === spec.kind)
        if (items.length > 0) groups.push({ kind: spec.kind, label: spec.label, icon: spec.icon, items })
    }
    return groups
}

// --- the cached per-kind sources --------------------------------------------

// A composer is opened, closed and reopened constantly, and three of the four
// kinds have no server-side search, so every keystroke would otherwise refetch
// a whole list. Short enough that a list created in another tab shows up on the
// next composer rather than the next reload.
const LIST_TTL_MS = 60_000

const pending = new Map<EmbedKind, { at: number; items: Promise<EmbedItem[]> }>()
// What a resolved load left behind, readable without awaiting: this is what
// answers a query on the keystroke, before any request has come back.
const resolved = new Map<EmbedKind, EmbedItem[]>()

export function clearEmbedCache(): void {
    pending.clear()
    resolved.clear()
}

function loadKind(kind: EmbedKind): Promise<EmbedItem[]> {
    const cached = pending.get(kind)
    if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.items
    const items = embedKindSpec(kind)
        .load()
        .then((got) => {
            resolved.set(kind, got)
            return got
        })
        .catch((err) => {
            // A failed fetch must not be cached, or one flaky request poisons
            // the picker for a minute.
            pending.delete(kind)
            throw err
        })
    pending.set(kind, { at: Date.now(), items })
    return items
}

async function searchKind(kind: EmbedKind, query: string, limit: number): Promise<EmbedCandidate[]> {
    const spec = embedKindSpec(kind)
    const found = spec.search && query.trim() ? await spec.search(query) : matchEmbedItems(await loadKind(kind), query)
    return found.slice(0, limit).map((item) => ({ ...item, kind }))
}

// --- the search primitive ---------------------------------------------------

export interface EmbedSearchOptions {
    // null while no picker is open, which clears the results.
    request: Accessor<{ kind: EmbedKind | null; query: string } | null>
    // Moments the host already holds. They answer the query while the server
    // search is in flight, and if it fails.
    fallbackMoments?: Accessor<{ id: string; title: string }[] | undefined>
    limitPerKind?: number
    debounceMs?: number
}

export interface EmbedSearch {
    results: Accessor<EmbedCandidate[]>
    groups: Accessor<EmbedGroup[]>
    loading: Accessor<boolean>
}

export function createEmbedSearch(options: EmbedSearchOptions): EmbedSearch {
    const limit = () => options.limitPerKind ?? 5
    const [results, setResults] = createSignal<EmbedCandidate[]>([])
    const [loading, setLoading] = createSignal(false)

    // Answers from memory alone: the host's moment index plus whatever lists
    // have already been fetched this session.
    const localResults = (kinds: readonly EmbedKind[], query: string): EmbedCandidate[] => {
        const out: EmbedCandidate[] = []
        for (const kind of kinds) {
            const items =
                resolved.get(kind) ??
                (kind === 'moment' ? untrack(() => options.fallbackMoments?.() ?? []) : [])
            for (const item of matchEmbedItems(items, query, limit())) out.push({ ...item, kind })
        }
        return out
    }

    // Every request gets a number, and a response for a stale one is dropped.
    // Typing "grocery" fires seven searches and they do not come back in order.
    let latest = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    createEffect(
        on(options.request, (request) => {
            const run = ++latest
            if (timer) clearTimeout(timer)
            if (!request) {
                setResults([])
                setLoading(false)
                return
            }
            const kinds = request.kind ? [request.kind] : EMBED_KINDS.map((k) => k.kind)
            setResults(localResults(kinds, request.query))
            setLoading(true)
            timer = setTimeout(() => {
                void (async () => {
                    const settled = await Promise.all(
                        kinds.map((kind) => searchKind(kind, request.query, limit()).catch(() => null)),
                    )
                    if (run !== latest) return
                    const out: EmbedCandidate[] = []
                    kinds.forEach((kind, i) => {
                        // A kind whose fetch failed keeps whatever memory could
                        // answer, rather than emptying its group.
                        out.push(...(settled[i] ?? localResults([kind], request.query)))
                    })
                    setResults(out)
                    setLoading(false)
                })()
            }, options.debounceMs ?? 180)
        }),
    )

    onCleanup(() => {
        if (timer) clearTimeout(timer)
    })

    return { results, groups: () => groupEmbedCandidates(results()), loading }
}

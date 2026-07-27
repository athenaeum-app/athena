import { createSignal, createMemo, createEffect, For, Show, onMount, onCleanup, type Component, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import { api, type Archive, type Tag, type Moment, type TagGraph } from '../api'
import { contrastingTextColor, randomTagColor } from '../tagColors'
import { rankTags } from '../tagRank'
import { keybinds, matchEvent } from '../keybinds'
import { backdropDismiss } from '../dismiss'
import { useIsDesktop } from '../media'

// Unified editor. One component drives moment create, moment edit and
// chat compose, replacing the old SmartEditor (inline create) and MomentEditor
// (modal edit) and their duplicated upload / insert / autocomplete helpers.
//
// Features shared across all three chromes:
//   - selection-aware markdown toolbar (bold / italic / strike / link)
//   - `[[` moment-reference autocomplete (lightweight, from momentIndex)
//   - `/` slash menu -> Moment / Todo / Canvas -> searchable picker -> inserts
//     [[id]] / ::todo:id:: / ::canvas:id:: (the same tokens MomentBody renders)
//   - paste / drag-and-drop asset uploads
//   - configurable save keybind (Ctrl+S) plus Ctrl+Enter, handled locally so it
//     works while the textarea is focused
//
// The `chrome` prop selects the surrounding shell: an inline card (create), a
// modal (edit) or a compact chat composer.

export type EditorChrome = 'inline' | 'modal' | 'chat'

export interface EditorProps {
    chrome: EditorChrome
    // Edit mode pre-fills from this moment; create/chat leave it undefined.
    moment?: Moment | null
    archives?: Archive[]
    tags?: Tag[]
    // Whole-library tag pairings, for suggestion ranking (see tagRank). null
    // until the first fetch lands, which leaves the order alone rather than
    // ranking off partial data.
    tagGraph?: TagGraph | null
    defaultArchive?: string | null
    momentIndex?: { id: string; title: string }[]
    // Persist. tagIds/archiveId are empty for chat.
    onSubmit: (title: string, content: string, tagIds: string[], archiveId: string) => Promise<void>
    onCreateTag?: (name: string, color: string) => Promise<Tag>
    onCancel?: () => void
    // Placeholder override (chat uses a different prompt).
    placeholder?: string
    // When set, unsaved work is mirrored to localStorage under this key and
    // restored on mount. See the draft block below.
    draftKey?: string
    // Handed over on mount, for a host that has to put text into a composer it
    // does not own (chat quoting a message it was asked to reply to). A prop
    // holding the content instead would make every keystroke the host's
    // problem, for the sake of the rare write.
    onReady?: (handle: EditorHandle) => void
}

export interface EditorHandle {
    // Insert at the caret, on a line of its own, and leave the caret after it.
    insertBlock: (text: string) => void
}

// --- drafts -----------------------------------------------------------------
// Half-written moments used to evaporate: the composer holds its work in
// component state, so a refresh, a crash, or anything that remounts the
// component (changing the archive filter did) took it with it. Mirroring it to
// localStorage as it is typed means the only thing that clears a draft is
// posting it or discarding it on purpose.
//
// Deliberately client-local: a draft is not content until it is posted, and
// putting it on the server would mean deciding who can see it, what it syncs
// as, and when it expires, for something whose whole job is to survive a
// reload.

interface StoredDraft {
    title: string
    content: string
    tagIds: string[]
    archiveId: string
    savedAt: number
}

const draftStorageKey = (key: string) => `athena-draft:${key}`

function readDraft(key: string): StoredDraft | null {
    try {
        const raw = localStorage.getItem(draftStorageKey(key))
        if (!raw) return null
        const parsed = JSON.parse(raw) as StoredDraft
        if (typeof parsed?.content !== 'string' || typeof parsed?.title !== 'string') return null
        return parsed
    } catch {
        return null
    }
}

function writeDraft(key: string, draft: Omit<StoredDraft, 'savedAt'>): void {
    try {
        localStorage.setItem(draftStorageKey(key), JSON.stringify({ ...draft, savedAt: Date.now() }))
    } catch {
        // A full or unavailable quota must not break typing.
    }
}

export function clearDraft(key: string): void {
    try {
        localStorage.removeItem(draftStorageKey(key))
    } catch {
        /* nothing to do */
    }
}

type SlashKind = 'moment' | 'todo' | 'canvas'

// How many ranked tag suggestions the composer offers at once. The point of the
// list is to replace typing, so it wants to show the whole vocabulary of a
// normal library rather than a teaser: at six it fitted two rows of three and
// anyone with more tags than that was back to typing names out. The cap is a
// rendering bound, not an editorial one; the popover scrolls past it.
const TAG_SUGGESTION_LIMIT = 40

const SLASH_ITEMS: { kind: SlashKind; icon: string; label: string; hint: string }[] = [
    { kind: 'moment', icon: 'description', label: 'Moment', hint: 'link a moment' },
    { kind: 'todo', icon: 'checklist', label: 'To-do list', hint: 'embed a list' },
    { kind: 'canvas', icon: 'dashboard', label: 'Canvas', hint: 'embed a canvas' },
]

export const Editor: Component<EditorProps> = (props) => {
    const showFields = () => props.chrome !== 'chat'
    const isModal = () => props.chrome === 'modal'
    // Drives the chat composer's Enter behaviour, which differs on touch (see
    // the keydown handler): same breakpoint the app shell switches on.
    const isDesktop = useIsDesktop()

    const [title, setTitle] = createSignal(props.moment?.title || '')
    const [content, setContent] = createSignal(props.moment?.content || '')
    const [archiveId, setArchiveId] = createSignal(
        props.moment?.archive_id || props.defaultArchive || props.archives?.[0]?.id || '',
    )
    // Tags are unified to the autocomplete + inline-create model (previously the
    // edit modal only had toggle buttons). Pre-fill from the moment's tag ids.
    const initialTags = (): Tag[] => {
        const ids = props.moment?.tag_ids || []
        const all = props.tags || []
        return ids.map((id) => all.find((t) => t.id === id)).filter((t): t is Tag => !!t)
    }
    const [selectedTags, setSelectedTags] = createSignal<Tag[]>(initialTags())

    // Whether the archive came from the user rather than from context. Until it
    // does, the composer follows whatever archive you are looking at; once you
    // pick one, it stays picked.
    //
    // This used to happen by accident: the composer was rebuilt whenever the
    // surrounding props changed, so it re-read the default every time. Now that
    // it has a stable lifetime (which is what keeps a draft alive), following
    // has to be deliberate, and without it a composer created before the first
    // archive existed would sit on an empty archive id forever, and posting
    // would fail.
    const [archivePinned, setArchivePinned] = createSignal(false)
    const chooseArchive = (id: string) => {
        setArchivePinned(true)
        setArchiveId(id)
    }

    createEffect(() => {
        if (archivePinned()) return
        const next = props.moment?.archive_id || props.defaultArchive || props.archives?.[0]?.id || ''
        if (next && next !== archiveId()) setArchiveId(next)
    })
    const [tagInput, setTagInput] = createSignal('')
    // -1 means "typing" (Enter commits/creates the typed text); 0+ highlights a
    // suggestion (Enter accepts it). Arrow keys move between them. Starts on
    // the top suggestion; comma always commits the raw text, so creating a tag
    // whose name is a prefix of an existing one stays a single keystroke.
    const [tagActive, setTagActive] = createSignal(0)

    const [saving, setSaving] = createSignal(false)
    const [error, setError] = createSignal('')
    const [dragging, setDragging] = createSignal(false)
    const [uploading, setUploading] = createSignal(0)

    // `[[` moment autocomplete.
    const [refQuery, setRefQuery] = createSignal<string | null>(null)
    const [refStart, setRefStart] = createSignal(0)
    const [refIndex, setRefIndex] = createSignal(0)

    // `/` slash menu.
    const [slash, setSlash] = createSignal<{ query: string; start: number; index: number } | null>(null)
    // Searchable embed picker opened from the slash menu.
    const [picker, setPicker] = createSignal<{ kind: SlashKind; insertAt: number; removeLen: number } | null>(null)

    let contentRef: HTMLTextAreaElement | undefined
    let fileInputRef: HTMLInputElement | undefined

    // ---- draft persistence ----
    // Only for composing something new: restoring a stale draft over a moment
    // you opened to edit would silently replace what is actually stored.
    const draftKey = () => (props.moment ? undefined : props.draftKey)
    const [restoredDraft, setRestoredDraft] = createSignal(false)

    onMount(() => {
        const key = draftKey()
        if (!key) return
        const draft = readDraft(key)
        if (!draft || (!draft.title && !draft.content && draft.tagIds.length === 0)) return
        setTitle(draft.title)
        setContent(draft.content)
        // A draft records the archive it was being written for; restoring it
        // should not then be overwritten by whatever is on screen now.
        if (draft.archiveId) chooseArchive(draft.archiveId)
        const all = props.tags || []
        // A tag deleted since the draft was written is simply dropped.
        setSelectedTags(draft.tagIds.map((id) => all.find((t) => t.id === id)).filter((t): t is Tag => !!t))
        setRestoredDraft(true)
    })

    // Mirror every keystroke. No debounce: this is a synchronous write of a
    // few kilobytes to localStorage, and the alternative, losing the last
    // few seconds of typing to a crash, is exactly what this exists to stop.
    createEffect(() => {
        const key = draftKey()
        if (!key) return
        const draft = {
            title: title(),
            content: content(),
            tagIds: selectedTags().map((t) => t.id),
            archiveId: archiveId(),
        }
        if (!draft.title && !draft.content && draft.tagIds.length === 0) {
            clearDraft(key)
            return
        }
        writeDraft(key, draft)
    })

    const discardDraft = () => {
        const key = draftKey()
        if (key) clearDraft(key)
        setTitle('')
        setContent('')
        setSelectedTags([])
        setTagInput('')
        setRestoredDraft(false)
    }

    // ---- caret / insertion ----

    const restoreSelection = (start: number, end: number) => {
        const textarea = contentRef
        if (!textarea) return
        queueMicrotask(() => {
            textarea.focus()
            textarea.setSelectionRange(start, end)
        })
    }

    const wrapSelection = (prefix: string, suffix: string) => {
        const textarea = contentRef
        if (!textarea) return
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const val = content()
        const selected = val.slice(start, end)
        setContent(val.slice(0, start) + prefix + selected + suffix + val.slice(end))
        const innerStart = start + prefix.length
        restoreSelection(innerStart, innerStart + selected.length)
    }

    const insertLink = () => {
        const textarea = contentRef
        if (!textarea) return
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const val = content()
        const text = val.slice(start, end) || 'text'
        const inserted = `[${text}](url)`
        setContent(val.slice(0, start) + inserted + val.slice(end))
        const urlStart = start + 1 + text.length + 2
        restoreSelection(urlStart, urlStart + 3)
    }

    const insertAtCursor = (text: string) => {
        const textarea = contentRef
        if (!textarea) {
            setContent((prev) => prev + text)
            return
        }
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        setContent((prev) => prev.slice(0, start) + text + prev.slice(end))
        const pos = start + text.length
        restoreSelection(pos, pos)
    }

    // Insert starting on a line of its own. A blockquote glued to the tail of
    // whatever was already typed is neither a quote nor prose, and the caret
    // sits at the end of the composer far more often than at the start of a
    // line.
    const insertBlock = (text: string) => {
        const before = content().slice(0, contentRef ? contentRef.selectionStart : content().length)
        insertAtCursor(before === '' || before.endsWith('\n') ? text : '\n' + text)
    }

    onMount(() => props.onReady?.({ insertBlock }))

    const tokenFor = (kind: SlashKind, id: string) =>
        kind === 'moment' ? `[[${id}]]` : kind === 'todo' ? `::todo:${id}::` : `::canvas:${id}::`

    // ---- `[[` autocomplete ----

    const refMatches = createMemo(() => {
        const q = refQuery()
        const idx = props.momentIndex
        if (q === null || !idx || idx.length === 0) return []
        const needle = q.toLowerCase()
        return idx.filter((m) => m.title.toLowerCase().includes(needle)).slice(0, 6)
    })

    createEffect(() => {
        refMatches()
        setRefIndex(0)
    })

    const insertReference = (item: { id: string }) => {
        const textarea = contentRef
        if (!textarea) return
        const val = content()
        const cursor = textarea.selectionStart
        const inserted = `[[${item.id}]]`
        const from = refStart()
        setContent(val.slice(0, from) + inserted + val.slice(cursor))
        setRefQuery(null)
        const pos = from + inserted.length
        restoreSelection(pos, pos)
    }

    // ---- slash menu ----

    const slashMatches = createMemo(() => {
        const state = slash()
        if (!state) return []
        const q = state.query.toLowerCase()
        return SLASH_ITEMS.filter((it) => !q || it.label.toLowerCase().includes(q) || it.kind.includes(q))
    })

    // Re-highlight the first item whenever the match list changes.
    //
    // The `index !== 0` guard is load-bearing. slashMatches derives from slash,
    // so writing slash here feeds straight back into this effect, and the old
    // version wrote `{...s, index: 0}` unconditionally, a fresh object every
    // time, which the signal saw as a change even when nothing had changed. The
    // result was an effect that re-triggered itself until the runtime gave up
    // with "Maximum call stack size exceeded", which is what typing `/` did:
    // the menu appeared, the reactive graph blew up behind it, and the editor
    // was left half-wired. Returning the same object when the index is already
    // 0 makes the cycle terminate after one pass.
    createEffect(() => {
        slashMatches()
        setSlash((s) => (s && s.index !== 0 ? { ...s, index: 0 } : s))
    })

    const chooseSlash = (kind: SlashKind) => {
        const state = slash()
        setSlash(null)
        if (!state) return
        // Open the picker; defer stripping the `/query` trigger until an item is
        // actually picked, so cancelling the picker doesn't eat the typed text.
        setPicker({ kind, insertAt: state.start, removeLen: 1 + state.query.length })
    }

    const onPickEmbed = (id: string) => {
        const p = picker()
        setPicker(null)
        setSlash(null)
        setRefQuery(null)
        if (!p) return
        // Replace the `/query` trigger with the token in a single edit.
        const token = tokenFor(p.kind, id)
        const val = content()
        setContent(val.slice(0, p.insertAt) + token + val.slice(p.insertAt + p.removeLen))
        const pos = p.insertAt + token.length
        restoreSelection(pos, pos)
    }

    // Toolbar affordance: insert a `/` at the caret and open the slash menu
    // (programmatic content changes don't fire the input handler).
    const openSlashMenu = () => {
        const textarea = contentRef
        const at = textarea ? textarea.selectionStart : content().length
        const val = content()
        setContent(val.slice(0, at) + '/' + val.slice(at))
        restoreSelection(at + 1, at + 1)
        setSlash({ query: '', start: at, index: 0 })
    }

    // ---- content input: keep both triggers in sync with the caret ----

    const handleContentInput = (e: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
        const ta = e.currentTarget
        setContent(ta.value)
        const cur = ta.selectionStart
        const before = ta.value.slice(0, cur)

        const refM = before.match(/\[\[([^\]\n]*)$/)
        if (refM && props.momentIndex && props.momentIndex.length > 0) {
            setRefQuery(refM[1])
            setRefStart(cur - refM[0].length)
            setSlash(null)
            return
        }
        setRefQuery(null)

        const slashM = before.match(/(?:^|\s)\/(\w*)$/)
        if (slashM) {
            setSlash({ query: slashM[1], start: cur - slashM[1].length - 1, index: 0 })
            return
        }
        setSlash(null)
    }

    // ---- dropdown placement ----
    // Both dropdowns used to sit `absolute top-full` inside the composer, which
    // is fine in the moment editor and useless in the docked chat widget: that
    // is a fixed-height box with overflow:hidden, so the menu was cut off at
    // the widget's edge. They render in a portal now and are positioned against
    // the textarea's viewport rect, which no ancestor can clip.
    //
    // The rect is re-measured while a menu is open rather than once, because
    // the composer moves under it: the chat scrollback grows, the page
    // scrolls, the window resizes.
    const [anchor, setAnchor] = createSignal<DOMRect | null>(null)
    const menuOpen = () => (slash() && slashMatches().length > 0) || (refQuery() !== null && refMatches().length > 0)

    const measureAnchor = () => {
        if (contentRef) setAnchor(contentRef.getBoundingClientRect())
    }

    createEffect(() => {
        if (!menuOpen()) {
            setAnchor(null)
            return
        }
        measureAnchor()
    })

    onMount(() => {
        // Capture phase so scrolling any ancestor is caught, not just the page.
        const onMove = () => {
            if (menuOpen()) measureAnchor()
        }
        window.addEventListener('scroll', onMove, true)
        window.addEventListener('resize', onMove)
        onCleanup(() => {
            window.removeEventListener('scroll', onMove, true)
            window.removeEventListener('resize', onMove)
        })
    })

    // Below the composer normally; above it when that would run off-screen,
    // which is the usual case for a composer pinned to the bottom of a panel.
    const menuStyle = (): JSX.CSSProperties => {
        const a = anchor()
        if (!a) return { display: 'none' }
        const width = Math.min(a.width, 384) // matches the old max-w-sm
        const spaceBelow = window.innerHeight - a.bottom
        const flipUp = spaceBelow < 220 && a.top > spaceBelow
        return {
            position: 'fixed',
            left: `${a.left}px`,
            width: `${width}px`,
            ...(flipUp
                ? { bottom: `${window.innerHeight - a.top + 4}px` }
                : { top: `${a.bottom + 4}px` }),
        }
    }

    // Dismiss the `[[` / `/` dropdowns when focus genuinely leaves the
    // textarea (clicking another field, the toolbar, etc). Picking an item
    // from either dropdown uses onMouseDown-preventDefault specifically to
    // keep focus on the textarea, so this only fires for real "click away"
    // gestures. Without it the dropdown stays visually stuck open until
    // something else happens to clear the state (e.g. posting the moment).
    const handleContentBlur = () => {
        setRefQuery(null)
        setSlash(null)
    }

    // ---- keybinds inside the textarea ----

    const submitCombo = () => keybinds().saveMoment

    const handleContentKeyDown = (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
        // Slash menu navigation takes priority while open.
        const sMatches = slashMatches()
        if (slash() && sMatches.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSlash((s) => (s ? { ...s, index: (s.index + 1) % sMatches.length } : s))
                return
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSlash((s) => (s ? { ...s, index: (s.index - 1 + sMatches.length) % sMatches.length } : s))
                return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                chooseSlash(sMatches[slash()!.index].kind)
                return
            }
            if (e.key === 'Escape') {
                e.preventDefault()
                setSlash(null)
                return
            }
        }

        // `[[` autocomplete navigation.
        const matches = refMatches()
        if (refQuery() !== null && matches.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setRefIndex((p) => (p + 1) % matches.length)
                return
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault()
                setRefIndex((p) => (p - 1 + matches.length) % matches.length)
                return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                insertReference(matches[refIndex()])
                return
            }
            if (e.key === 'Escape') {
                e.preventDefault()
                setRefQuery(null)
                return
            }
        }

        // Chat: Enter sends, Shift+Enter is a newline. A touch keyboard has no
        // Shift, which left no way to write a second line at all, so below the
        // desktop breakpoint Enter is a newline and sending is the Send
        // button's job.
        if (props.chrome === 'chat' && isDesktop() && e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
            return
        }

        // Chat: Escape blurs the composer instead of closing the whole modal.
        // A second Escape (now unfocused) falls through to the global handler,
        // which closes the chat overlay.
        if (props.chrome === 'chat' && e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            e.currentTarget.blur()
            return
        }

        // Configurable save (Ctrl+S) and the classic Ctrl+Enter both submit.
        if (matchEvent(e, submitCombo()) || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
            e.preventDefault()
            void submit()
            return
        }

        const mod = e.ctrlKey || e.metaKey
        if (!mod) return
        const key = e.key.toLowerCase()
        if (key === 'b') {
            e.preventDefault()
            wrapSelection('**', '**')
        } else if (key === 'i') {
            e.preventDefault()
            wrapSelection('*', '*')
        } else if (key === 'k') {
            e.preventDefault()
            insertLink()
        }
    }

    // ---- tags ----

    const tagSuggestions = createMemo(() => {
        const q = tagInput().trim().toLowerCase()
        const selected = selectedTags()
        const selectedIds = new Set(selected.map((t) => t.id))
        const matching = (props.tags || []).filter(
            (t) => !selectedIds.has(t.id) && (q === '' || t.name.toLowerCase().includes(q)),
        )
        // Rank before slicing, or the ones shown are just the first the server
        // happened to return.
        return rankTags(matching, props.tagGraph ?? null, [...selectedIds]).slice(0, TAG_SUGGESTION_LIMIT)
    })

    // Whether to offer suggestions at all. Deliberately true for an empty
    // field: the whole point of ranking them is that the tags you want are
    // usually already at the front, so making you type a letter first just
    // hides the answer. Gated on the composer having *something* in it, so an
    // untouched inline composer doesn't sit under a permanent tag menu.
    //
    // selectedTags is part of that "something" because committing a tag clears
    // tagInput. Without it, tagging a moment before writing it (type one tag,
    // then pick the rest from the list) died at the first tag: the list showed
    // while the name was half-typed and vanished the moment it was accepted,
    // which is exactly when it is meant to be useful.
    const suggestingTags = createMemo(
        () =>
            tagSuggestions().length > 0 &&
            (selectedTags().length > 0 ||
                tagInput().trim() !== '' ||
                title().trim() !== '' ||
                content().trim() !== ''),
    )

    // Highlight the top suggestion whenever the set changes, so Enter takes it
    // without an ArrowDown first. -1 (nothing highlighted, Enter commits the
    // raw text) is reachable by arrowing back up past the first entry.
    createEffect(() => {
        tagSuggestions()
        setTagActive(0)
    })

    // The list scrolls now that it holds more than a couple of rows, so arrowing
    // through it has to bring the highlight along or the selection walks off
    // screen. -1 indexes nothing, which is the no-op we want.
    let tagListRef: HTMLDivElement | undefined
    createEffect(() => {
        const el = tagListRef?.children[tagActive()] as HTMLElement | undefined
        el?.scrollIntoView({ block: 'nearest' })
    })

    const addTag = (tag: Tag) => {
        setSelectedTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]))
        setTagInput('')
    }
    const removeTag = (id: string) => setSelectedTags((prev) => prev.filter((t) => t.id !== id))

    const commitTagInput = async () => {
        const name = tagInput().trim()
        if (!name) return
        const existing = (props.tags || []).find((t) => t.name.toLowerCase() === name.toLowerCase())
        if (existing) return addTag(existing)
        if (selectedTags().some((t) => t.name.toLowerCase() === name.toLowerCase())) {
            setTagInput('')
            return
        }
        if (!props.onCreateTag) {
            setTagInput('')
            return
        }
        try {
            addTag(await props.onCreateTag(name, randomTagColor()))
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create tag')
        }
    }

    const handleTagKeyDown = (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
        const suggestions = tagSuggestions()
        const suggesting = suggestingTags()
        if (e.key === 'ArrowDown' && suggesting) {
            e.preventDefault()
            setTagActive((a) => Math.min(a + 1, suggestions.length - 1))
        } else if (e.key === 'ArrowUp' && suggesting) {
            e.preventDefault()
            setTagActive((a) => Math.max(a - 1, -1))
        } else if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            const active = tagActive()
            if (e.key === 'Enter' && suggesting && active >= 0 && suggestions[active]) {
                addTag(suggestions[active])
            } else {
                void commitTagInput()
            }
        } else if (e.key === 'Backspace' && tagInput() === '') {
            const last = selectedTags()[selectedTags().length - 1]
            if (last) removeTag(last.id)
        }
    }

    // ---- uploads ----

    const isImageFile = (file: File) => file.type.startsWith('image/')

    const uploadFile = async (file: File) => {
        const placeholder = `[Attaching ${file.name}...]`
        insertAtCursor(placeholder)
        try {
            const asset = (await api.uploadAsset(file)) as { id: string }
            const url = `/api/v1/assets/${asset.id}`
            const markdown = isImageFile(file) ? `![${file.name}](${url})` : `[${file.name}](${url})`
            setContent((prev) => prev.replace(placeholder, markdown))
        } catch (err) {
            setContent((prev) => prev.replace(placeholder, `[failed to attach ${file.name}]`))
            setError(err instanceof Error ? err.message : `Failed to upload ${file.name}`)
        }
    }

    const handleFiles = (files: FileList | File[]) => {
        const arr = Array.from(files)
        if (arr.length === 0) return
        setUploading((n) => n + arr.length)
        Promise.all(arr.map(uploadFile)).finally(() => setUploading((n) => n - arr.length))
    }

    const handlePaste = (e: ClipboardEvent) => {
        const items = e.clipboardData?.items
        if (!items) return
        const files: File[] = []
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
                const f = items[i].getAsFile()
                if (f) files.push(f)
            }
        }
        if (files.length > 0) {
            e.preventDefault()
            handleFiles(files)
        }
    }

    const handleDrop = (e: DragEvent) => {
        e.preventDefault()
        setDragging(false)
        if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files)
    }
    const handleDragOver = (e: DragEvent) => {
        e.preventDefault()
        setDragging(true)
    }
    const handleDragLeave = (e: DragEvent) => {
        e.preventDefault()
        const current = e.currentTarget as Node | null
        if (current && !current.contains(e.relatedTarget as Node)) setDragging(false)
    }

    // ---- submit ----

    const submit = async () => {
        if (saving()) return
        // Chat won't submit an empty line.
        if (props.chrome === 'chat' && !content().trim()) return
        setSaving(true)
        setError('')
        try {
            await props.onSubmit(title(), content(), selectedTags().map((t) => t.id), archiveId())
            // Posted, so there is nothing left to recover. Clear the draft
            // before resetting the fields, since the reset itself would clear
            // it anyway, and being explicit keeps that from being load-bearing.
            const key = draftKey()
            if (key) clearDraft(key)
            setRestoredDraft(false)
            if (props.chrome !== 'modal') {
                // Inline create and chat reset for the next entry.
                setTitle('')
                setContent('')
                setSelectedTags([])
                setTagInput('')
                setRefQuery(null)
                setSlash(null)
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save')
        } finally {
            setSaving(false)
        }
    }

    // ---- shared sub-views ----

    const ToolbarButton: Component<{ icon: string; title: string; onClick: () => void }> = (btn) => (
        <button
            type="button"
            title={btn.title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={btn.onClick}
            class="text-sub hover:text-main hover:bg-element-accent flex items-center justify-center rounded p-1 transition-colors"
        >
            <span class="material-symbols-outlined" style={{ 'font-size': '18px' }}>
                {btn.icon}
            </span>
        </button>
    )

    const Toolbar = () => (
        <div class="border-element-accent flex items-center gap-1 border-b pb-2">
            <ToolbarButton icon="format_bold" title="Bold (Ctrl+B)" onClick={() => wrapSelection('**', '**')} />
            <ToolbarButton icon="format_italic" title="Italic (Ctrl+I)" onClick={() => wrapSelection('*', '*')} />
            <ToolbarButton icon="format_strikethrough" title="Strikethrough" onClick={() => wrapSelection('~~', '~~')} />
            <div class="bg-element-accent mx-1 h-4 w-px" />
            <ToolbarButton icon="link" title="Link (Ctrl+K)" onClick={insertLink} />
            <ToolbarButton icon="add_box" title="Embed a moment / to-do / canvas (or type /)" onClick={openSlashMenu} />
            <div class="bg-element-accent mx-1 h-4 w-px" />
            <ToolbarButton icon="attach_file" title="Attach files" onClick={() => fileInputRef?.click()} />
            {HiddenFileInput()}
            <div class="ml-auto">{UploadingHint()}</div>
        </div>
    )

    // Textarea plus its overlays (dropzone, `[[` menu, slash menu).
    const ContentArea = (p: { rows: number; placeholder: string; autofocus?: boolean }) => (
        <div
            class={`relative rounded-md border transition-colors ${dragging() ? 'border-dashed border-highlight bg-highlight/10' : 'border-element-accent'}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
        >
            <textarea
                ref={(el) => {
                    contentRef = el
                    if (p.autofocus) queueMicrotask(() => el.focus())
                }}
                value={content()}
                onInput={handleContentInput}
                onKeyDown={handleContentKeyDown}
                onBlur={handleContentBlur}
                onPaste={handlePaste}
                rows={p.rows}
                placeholder={p.placeholder}
                class="bg-transparent text-main w-full resize-none rounded-md px-3 py-2 text-sm focus:outline-none"
            />

            {/* `[[` moment autocomplete */}
            <Show when={refQuery() !== null && refMatches().length > 0}>
                <Portal>
                    <div
                        style={menuStyle()}
                        class="bg-element-matte border-element-accent z-[70] flex flex-col rounded-xl border p-1 shadow-2xl"
                    >
                        <span class="text-sub/60 px-2 py-1 text-xs font-bold tracking-widest uppercase">Link to Moment</span>
                        <For each={refMatches()}>
                            {(match, index) => (
                                <button
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => insertReference(match)}
                                    class={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-bold transition-all ${refIndex() === index() ? 'bg-highlight-strongest text-white' : 'text-sub hover:bg-element-accent'}`}
                                >
                                    <span class="material-symbols-outlined text-base opacity-60">description</span>
                                    {match.title || 'Untitled'}
                                </button>
                            )}
                        </For>
                    </div>
                </Portal>
            </Show>

            {/* `/` slash menu */}
            <Show when={slash() && slashMatches().length > 0}>
                <Portal>
                    <div
                        style={menuStyle()}
                        class="bg-element-matte border-element-accent z-[70] flex flex-col rounded-xl border p-1 shadow-2xl"
                    >
                        <span class="text-sub/60 px-2 py-1 text-xs font-bold tracking-widest uppercase">Insert embed</span>
                        <For each={slashMatches()}>
                            {(item, index) => (
                                <button
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => chooseSlash(item.kind)}
                                    class={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-bold transition-all ${slash()?.index === index() ? 'bg-highlight-strongest text-white' : 'text-sub hover:bg-element-accent'}`}
                                >
                                    <span class="material-symbols-outlined text-base opacity-60">{item.icon}</span>
                                    <span>{item.label}</span>
                                    <span class="ml-auto text-xs font-normal opacity-60">{item.hint}</span>
                                </button>
                            )}
                        </For>
                    </div>
                </Portal>
            </Show>

            <Show when={dragging()}>
                <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span class="text-highlight-strongest text-sm font-bold tracking-widest uppercase">Drop files to attach</span>
                </div>
            </Show>
        </div>
    )

    // The (visually hidden) file picker. Rendered once per chrome next to its
    // attach affordance so `fileInputRef.click()` always has a live target.
    const HiddenFileInput = () => (
        <input
            ref={fileInputRef}
            type="file"
            multiple
            class="hidden"
            onChange={(e) => {
                if (e.currentTarget.files) handleFiles(e.currentTarget.files)
                e.currentTarget.value = ''
            }}
        />
    )

    const UploadingHint = () => (
        <Show when={uploading() > 0}>
            <span class="text-highlight text-xs font-bold">Uploading {uploading()} file(s)…</span>
        </Show>
    )

    // Compact icon-only attach control for the chat composer (which has no
    // format toolbar). Matches ToolbarButton styling.
    const AttachButton = () => (
        <div class="flex items-center gap-2">
            <button
                type="button"
                title="Attach files"
                onClick={() => fileInputRef?.click()}
                class="text-sub hover:text-main hover:bg-element-accent flex items-center justify-center rounded p-1 transition-colors"
            >
                <span class="material-symbols-outlined" style={{ 'font-size': '18px' }}>
                    attach_file
                </span>
            </button>
            {HiddenFileInput()}
            {UploadingHint()}
        </div>
    )

    const TagField = () => (
        <div class="relative flex flex-col gap-2">
            <Show when={selectedTags().length > 0}>
                <div class="flex flex-wrap gap-2">
                    <For each={selectedTags()}>
                        {(tag) => (
                            <span
                                class="flex items-center gap-1 rounded-xl px-2 py-1 text-xs font-black tracking-wide uppercase"
                                style={{ 'background-color': tag.color, color: contrastingTextColor(tag.color) }}
                            >
                                #{tag.name}
                                <button
                                    type="button"
                                    onClick={() => removeTag(tag.id)}
                                    // Icon-only, so the glyph name ("close") is
                                    // all a screen reader would otherwise read,
                                    // for every chip alike.
                                    aria-label={`Remove tag ${tag.name}`}
                                    title={`Remove tag ${tag.name}`}
                                    class="material-symbols-outlined text-sm hover:opacity-70"
                                    style={{ 'font-size': '14px' }}
                                >
                                    close
                                </button>
                            </span>
                        )}
                    </For>
                </div>
            </Show>
            <input
                type="text"
                value={tagInput()}
                onInput={(e) => setTagInput(e.currentTarget.value)}
                onKeyDown={handleTagKeyDown}
                placeholder="Add tags (Enter takes the suggestion, comma adds what you typed)"
                class="bg-element text-main border-element-accent w-full min-w-0 rounded-md border px-3 py-2 text-sm focus:outline-none focus:border-highlight"
            />
            <Show when={suggestingTags()}>
                {/* Full composer width, not max-w-sm: this is a pick-list, so
                    the more chips fit per row the fewer names get typed. Capped
                    height with a scroll so a large library can't run it off the
                    bottom of the screen.

                    In the layout flow rather than floating over it. As a
                    six-chip hint an overlay was fine; at full width it is tall
                    enough to cover the Post button underneath, which left
                    anyone with a real tag vocabulary unable to submit without
                    dismissing it first. Taking up space pushes the controls
                    down instead. */}
                <div
                    ref={tagListRef}
                    data-testid="tag-suggestions"
                    class="bg-element-matte border-element-accent mt-1 flex max-h-48 w-full flex-wrap gap-2 overflow-y-auto rounded-xl border p-2"
                >
                    <For each={tagSuggestions()}>
                        {(tag, index) => (
                            <button
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onMouseMove={() => setTagActive(index())}
                                onClick={() => addTag(tag)}
                                class="rounded-xl px-2 py-1 text-xs font-black tracking-wide uppercase transition-all hover:opacity-80"
                                classList={{ 'ring-2 ring-highlight-strongest': tagActive() === index() }}
                                style={{ 'background-color': tag.color, color: contrastingTextColor(tag.color) }}
                            >
                                #{tag.name}
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    )

    const embedPicker = () => (
        <Show when={picker()}>
            {(p) => <EmbedPicker kind={p().kind} onPick={onPickEmbed} onClose={() => setPicker(null)} />}
        </Show>
    )

    // ---- chromes ----

    if (props.chrome === 'chat') {
        return (
            <div class="flex flex-col gap-2">
                {ContentArea({
                    rows: 2,
                    // No Shift key on touch, so don't advertise Shift+Enter there.
                    placeholder:
                        props.placeholder ||
                        (isDesktop()
                            ? 'Message… (Enter to send, Shift+Enter for a new line, / to embed)'
                            : 'Message… (Send button posts, / to embed)'),
                    autofocus: true,
                })}
                <Show when={error()}>
                    <p class="text-danger text-xs">{error()}</p>
                </Show>
                <div class="flex items-center justify-between">
                    {AttachButton()}
                    <button
                        type="button"
                        onClick={() => void submit()}
                        disabled={saving()}
                        class="bg-highlight-strongest text-white rounded-md px-4 py-1.5 text-sm font-bold hover:brightness-110 disabled:opacity-50 transition-[filter]"
                    >
                        {saving() ? 'Sending…' : 'Send'}
                    </button>
                </div>
                {embedPicker()}
            </div>
        )
    }

    // Restoring silently would be indistinguishable from "the app kept some
    // text I didn't ask it to", so say what happened and offer the way out.
    const DraftNotice = () => (
        <Show when={restoredDraft()}>
            <div class="bg-element-matte border-element-accent text-sub flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
                <span class="material-symbols-outlined text-highlight text-base">history_edu</span>
                <span class="min-w-0 flex-1">Restored an unsaved draft.</span>
                <button
                    type="button"
                    onClick={discardDraft}
                    class="hover:text-danger font-bold underline transition-colors hover:cursor-pointer"
                >
                    Discard
                </button>
            </div>
        </Show>
    )

    const Fields = () => (
        <>
            {DraftNotice()}
            <Show when={showFields()}>
                <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
                    <select
                        value={archiveId()}
                        onChange={(e) => chooseArchive(e.currentTarget.value)}
                        class="bg-element text-main border-element-accent w-full max-w-[14rem] min-w-0 truncate rounded-md border px-3 py-2 text-sm focus:outline-none focus:border-highlight"
                    >
                        <For each={props.archives || []}>{(a) => <option value={a.id}>{a.name}</option>}</For>
                    </select>
                    <input
                        type="text"
                        value={title()}
                        onInput={(e) => setTitle(e.currentTarget.value)}
                        placeholder="Untitled"
                        class="bg-element text-main font-serif text-xl border-element-accent min-w-0 flex-1 rounded-md border px-3 py-2 focus:outline-none focus:border-highlight"
                    />
                </div>
            </Show>
            {Toolbar()}
            {ContentArea({ rows: props.chrome === 'modal' ? 12 : 8, placeholder: 'Write your thoughts… drag or paste files to attach, [[ to link a moment, / to embed' })}
            {TagField()}
            <Show when={error()}>
                <p class="text-danger text-sm">{error()}</p>
            </Show>
        </>
    )

    if (props.chrome === 'modal') {
        return (
            <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-[65] animate-fade-in p-4" {...backdropDismiss(() => props.onCancel?.())}>
                <div class="bg-element-matte border-element-accent flex h-[90vh] max-h-full w-full max-w-2xl flex-col rounded-lg border shadow-2xl overflow-hidden">
                    <div class="bg-element border-element-accent flex items-center justify-between rounded-t-lg border-b p-4">
                        <h2 class="text-main font-serif text-xl">{props.moment ? 'Edit Moment' : 'New Moment'}</h2>
                        <button onClick={() => props.onCancel?.()} class="text-sub hover:text-plain transition-colors">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <div class="flex-1 overflow-y-auto p-6 space-y-5">{Fields()}</div>
                    <div class="bg-element border-element-accent flex items-center justify-end gap-4 rounded-b-lg border-t p-4">
                        <button onClick={() => props.onCancel?.()} class="text-sub hover:text-main px-2 py-2 text-sm font-bold transition-colors">
                            Cancel
                        </button>
                        <button
                            onClick={() => void submit()}
                            disabled={saving()}
                            class="bg-highlight-strongest text-white rounded-md px-5 py-2 text-sm font-bold hover:brightness-110 disabled:opacity-50 transition-[filter]"
                        >
                            {saving() ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                    {embedPicker()}
                </div>
            </div>
        )
    }

    // inline (create)
    return (
        <div class="bg-element border-element-accent w-full min-w-0 rounded-lg border p-5">
            <div class="flex min-w-0 flex-col gap-4">
                {Fields()}
                <div class="flex justify-end">
                    <button
                        type="button"
                        onClick={() => void submit()}
                        disabled={saving()}
                        class="bg-highlight-strongest text-white rounded-md px-5 py-2 text-sm font-bold hover:brightness-110 disabled:opacity-50 transition-[filter]"
                    >
                        {saving() ? 'Posting…' : 'Post'}
                    </button>
                </div>
            </div>
            {embedPicker()}
        </div>
    )
}

// Searchable picker for a slash-menu embed. Self-fetches by kind so callers
// don't have to thread todo/canvas indexes through props.
const EmbedPicker: Component<{ kind: SlashKind; onPick: (id: string) => void; onClose: () => void }> = (props) => {
    const [query, setQuery] = createSignal('')
    const [items, setItems] = createSignal<{ id: string; title: string; sub?: string }[]>([])
    const [loading, setLoading] = createSignal(true)

    onMount(async () => {
        try {
            if (props.kind === 'moment') {
                const data = (await api.listMoments({ limit: 100 })) ?? []
                setItems(data.map((m) => ({ id: m.id, title: m.title || 'Untitled', sub: m.content })))
            } else if (props.kind === 'todo') {
                const data = (await api.listTodos()) ?? []
                setItems(data.map((l) => ({ id: l.id, title: l.title || 'Untitled list', sub: `${(l.items || []).length} items` })))
            } else {
                const data = (await api.listCanvases()) ?? []
                setItems(data.map((c) => ({ id: c.id, title: c.title || 'Untitled canvas' })))
            }
        } catch {
            setItems([])
        } finally {
            setLoading(false)
        }
    })

    const filtered = () => {
        const q = query().trim().toLowerCase()
        if (!q) return items()
        return items().filter((i) => i.title.toLowerCase().includes(q) || (i.sub || '').toLowerCase().includes(q))
    }

    const label = props.kind === 'moment' ? 'Reference a moment' : props.kind === 'todo' ? 'Embed a to-do list' : 'Embed a canvas'

    // Keyboard navigation: arrows move the highlight, Enter picks it, Escape
    // closes. Focus lives in the search input, so the handler sits there.
    const [active, setActive] = createSignal(0)
    let listRef: HTMLDivElement | undefined
    createEffect(() => {
        filtered()
        setActive(0)
    })
    createEffect(() => {
        const el = listRef?.children[active()] as HTMLElement | undefined
        el?.scrollIntoView({ block: 'nearest' })
    })
    const onKeyDown = (e: KeyboardEvent) => {
        const n = filtered().length
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => (n ? (a + 1) % n : 0))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => (n ? (a - 1 + n) % n : 0))
        } else if (e.key === 'Enter') {
            e.preventDefault()
            const chosen = filtered()[active()]
            if (chosen) props.onPick(chosen.id)
        } else if (e.key === 'Escape') {
            e.preventDefault()
            props.onClose()
        }
    }

    return (
        <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" {...backdropDismiss(props.onClose)}>
            <div class="bg-element-matte border-element-accent w-full max-w-md rounded-lg border p-4 shadow-2xl">
                <div class="mb-3 flex items-center justify-between">
                    <h3 class="text-main font-serif text-base">{label}</h3>
                    <button onClick={props.onClose} class="text-sub hover:text-main hover:cursor-pointer">
                        <span class="material-symbols-outlined text-base">close</span>
                    </button>
                </div>
                <input
                    // Focused explicitly, not via the autofocus attribute:
                    // autofocus only applies to elements present at page load,
                    // so on this dialog it did nothing. The search box stayed
                    // unfocused, keystrokes went to the textarea underneath,
                    // and the arrow keys this handler implements never
                    // reached it.
                    ref={(el) => queueMicrotask(() => el.focus())}
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Search…"
                    class="bg-element border-element-accent text-main mb-2 w-full rounded-md border px-3 py-2 text-sm focus:outline-none"
                />
                <div ref={listRef} data-testid="embed-picker-list" class="max-h-72 overflow-y-auto">
                    <Show when={!loading()} fallback={<p class="text-sub p-2 text-sm">Loading…</p>}>
                        <Show when={filtered().length > 0} fallback={<p class="text-sub/60 p-2 text-sm italic">No matches.</p>}>
                            <For each={filtered()}>
                                {(it, index) => (
                                    <button
                                        onClick={() => props.onPick(it.id)}
                                        onMouseMove={() => setActive(index())}
                                        class="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:cursor-pointer"
                                        classList={{
                                            'bg-element-accent': active() === index(),
                                            'hover:bg-element-accent': active() !== index(),
                                        }}
                                    >
                                        {/* w-full: Chromium 130 (Electron 33) does not stretch a
                                            column-flex <button>'s children, so truncate has nothing
                                            finite to clip against unless the width is explicit. */}
                                        <span class="text-main w-full min-w-0 truncate text-sm font-bold">{it.title}</span>
                                        <Show when={it.sub}>
                                            <span class="text-sub w-full min-w-0 line-clamp-1 text-xs">{it.sub}</span>
                                        </Show>
                                    </button>
                                )}
                            </For>
                        </Show>
                    </Show>
                </div>
            </div>
        </div>
    )
}

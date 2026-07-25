import { createSignal, createMemo, For, Show, onMount, type Component } from 'solid-js'
import { createStore, produce, reconcile } from 'solid-js/store'
import { api, type TodoList, type TodoItem, type TodoResetMode } from '../api'
import { useUI } from '../ui'
import { backdropDismiss } from '../dismiss'
import { createListboxNav } from '../listboxNav'
import { prefs, setPref } from '../prefs'
import { notifyTodoChanged } from '../todoBus'

// Todo module (ADR-0013): server-synced, library-shared to-do
// lists as a Trello-style board. v2.3 adds per-item due dates, priority,
// recurrence, a linked moment, subtask parentage (schema), plus a board-level
// quick filter / sort and drag-reorder for general-list items.
//
// Two flavours share one data model:
//   - "daily"   lists get a Reset-day action and roll unfinished items over.
//   - "general" (task) lists get a progress bar, notes and drag-reorder.
// Mutations require the ManageTodos permission; when !canManage the whole
// surface is read-only.

interface TodoModuleProps {
    onClose: () => void
    canManage: boolean
    onOpenMoment?: (id: string) => void
    // Opens the moment editor in create mode; the supplied callback links the
    // created moment back to the task the picker was opened for.
    onRequestNewMoment?: (link: (momentId: string) => void) => void
}

// ---- shared meta / helpers ----

const PRIORITIES = [
    { v: 0, label: 'None', color: '' },
    { v: 1, label: 'Low', color: '#7ed6df' },
    { v: 2, label: 'Med', color: '#ffbe76' },
    { v: 3, label: 'High', color: '#ff7979' },
]
const priorityColor = (v: number) => PRIORITIES.find((p) => p.v === v)?.color || ''

const RECURRENCES = ['', 'daily', 'weekly', 'monthly']

// How a repeating item decides when it comes back. Only meaningful once a
// recurrence is set, so the picker is hidden until then. Wording is per-period
// rather than "daily/24h" because the same control governs weekly and monthly.
const RESET_MODES: { value: TodoResetMode; label: string; hint: string }[] = [
    { value: 'calendar', label: 'At the start of each period', hint: 'A daily task clears every midnight, whenever you ticked it off.' },
    { value: 'interval', label: 'A full period after completion', hint: 'Finishing early pushes the next one out by the same amount.' },
]

const startOfToday = () => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
}
const isoToDateInput = (iso?: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const dateInputToIso = (s: string) => (s ? new Date(`${s}T00:00:00`).toISOString() : '')
const formatDue = (iso: string) => new Intl.DateTimeFormat(navigator.language, { month: 'short', day: 'numeric' }).format(new Date(iso))
const dueMs = (iso?: string) => (iso ? new Date(iso).setHours(0, 0, 0, 0) : Infinity)
const isOverdue = (i: TodoItem) => !!i.due_at && !i.done && dueMs(i.due_at) < startOfToday()
const isDueToday = (i: TodoItem) => !!i.due_at && dueMs(i.due_at) === startOfToday()

// Resolve + cache linked-moment titles for the little chip on a task.
const momentTitleCache = new Map<string, string>()

export const TodoModule: Component<TodoModuleProps> = (props) => {
    const ui = useUI()
    // Fine-grained store: mutations patch in place so <For> never disposes a
    // column/card (keeps notes, editors, drafts and open detail panels alive).
    const [lists, setLists] = createStore<TodoList[]>([])
    const [loading, setLoading] = createSignal(true)
    const [loadError, setLoadError] = createSignal(false)

    // Board-level quick filter / sort.
    const [search, setSearch] = createSignal('')
    const [doneFilter, setDoneFilter] = createSignal<'all' | 'active' | 'done'>('all')
    const [sortMode, setSortMode] = createSignal<'manual' | 'due' | 'priority'>('manual')
    // Board vs. agenda: the agenda pulls due-dated items across every
    // list onto one deadline-ordered timeline.
    const [boardView, setBoardView] = createSignal<'board' | 'agenda'>('board')

    // Toggle an item found by its list_id (used by the agenda, which is flat).
    const toggleById = (item: TodoItem) => {
        const list = lists.find((l) => l.id === item.list_id)
        if (list) toggleItem(list, item)
    }

    // Moment picker (link a moment to a task).
    const [momentPicker, setMomentPicker] = createSignal<{ listId: string; itemId: string } | null>(null)

    // Column drag-reorder: id of the column being dragged.
    const [colDrag, setColDrag] = createSignal<string | null>(null)

    // Every mutation path funnels through withList/withItem (or explicitly
    // notifies below for the few that don't), so any live-embedded card for
    // this list (MomentBody's TodoEmbed) knows to refetch. See todoBus.ts.
    const withList = (id: string, fn: (l: TodoList) => void) => {
        setLists((l) => l.id === id, produce(fn))
        notifyTodoChanged(id)
    }
    const withItem = (listId: string, itemId: string, fn: (i: TodoItem) => void) => {
        setLists((l) => l.id === listId, 'items', (i) => i.id === itemId, produce(fn))
        notifyTodoChanged(listId)
    }

    const load = async () => {
        setLoading(true)
        setLoadError(false)
        try {
            const data = await api.listTodos()
            setLists(reconcile((data ?? []).map((l) => ({ ...l, items: l.items ?? [] }))))
        } catch (err) {
            console.error('Failed to load todos:', err)
            setLoadError(true)
            ui.toast('Could not load to-do lists.', 'error')
        } finally {
            setLoading(false)
        }
    }

    onMount(load)

    // --- list mutations ---

    const newList = async (kind: 'daily' | 'general') => {
        try {
            const created = await api.createTodoList(kind, kind === 'daily' ? 'New daily list' : 'New task list')
            setLists(produce((arr) => arr.push({ ...created, items: created.items ?? [] })))
        } catch (err) {
            console.error('Failed to create list:', err)
            ui.toast('Could not create list.', 'error')
        }
    }

    const renameList = async (list: TodoList, title: string) => {
        const trimmed = title.trim()
        if (!trimmed || trimmed === list.title) return
        try {
            const updated = await api.updateTodoList(list.id, { title: trimmed })
            withList(list.id, (l) => {
                l.title = updated.title
                l.updated_at = updated.updated_at
            })
        } catch (err) {
            console.error('Failed to rename list:', err)
            ui.toast('Could not rename list.', 'error')
        }
    }

    const saveNotes = async (list: TodoList, notes: string) => {
        if (notes === list.notes) return
        try {
            const updated = await api.updateTodoList(list.id, { notes })
            withList(list.id, (l) => {
                l.notes = updated.notes
                l.updated_at = updated.updated_at
            })
        } catch (err) {
            console.error('Failed to save notes:', err)
            ui.toast('Could not save notes.', 'error')
        }
    }

    const removeList = async (list: TodoList) => {
        const ok = await ui.confirm({
            title: 'Delete list?',
            message: `"${list.title}" and all of its items will be permanently removed.`,
            confirmLabel: 'Delete',
            danger: true,
        })
        if (!ok) return
        try {
            await api.deleteTodoList(list.id)
            setLists(produce((arr) => {
                const i = arr.findIndex((l) => l.id === list.id)
                if (i >= 0) arr.splice(i, 1)
            }))
            notifyTodoChanged(list.id)
            ui.toast('List deleted.', 'success')
        } catch (err) {
            console.error('Failed to delete list:', err)
            ui.toast('Could not delete list.', 'error')
        }
    }

    const resetDay = async (list: TodoList) => {
        const ok = await ui.confirm({
            title: 'Reset day?',
            message: 'Completed items are cleared and unfinished items roll over to today.',
            confirmLabel: 'Reset',
        })
        if (!ok) return
        try {
            const updated = await api.resetTodoList(list.id)
            withList(list.id, (l) => {
                l.items = updated.items ?? []
                l.notes = updated.notes
                l.updated_at = updated.updated_at
            })
            ui.toast('Day reset.', 'success')
        } catch (err) {
            console.error('Failed to reset list:', err)
            ui.toast('Could not reset the day.', 'error')
        }
    }

    // --- item mutations ---

    const addItem = async (list: TodoList, text: string, parentId?: string) => {
        const trimmed = text.trim()
        if (!trimmed) return
        try {
            const item = await api.createTodoItem(list.id, trimmed, parentId)
            setLists((l) => l.id === list.id, 'items', produce((items) => items.push(item)))
            notifyTodoChanged(list.id)
        } catch (err) {
            console.error('Failed to add item:', err)
            ui.toast('Could not add item.', 'error')
        }
    }

    const toggleItem = async (list: TodoList, item: TodoItem) => {
        const prevDone = item.done
        withItem(list.id, item.id, (i) => (i.done = !prevDone))
        try {
            const updated = await api.updateTodoItem(item.id, { done: !prevDone })
            withItem(list.id, item.id, (i) => Object.assign(i, updated))
        } catch (err) {
            console.error('Failed to toggle item:', err)
            withItem(list.id, item.id, (i) => (i.done = prevDone))
            ui.toast('Could not update item.', 'error')
        }
    }

    const editItem = async (list: TodoList, item: TodoItem, text: string) => {
        const trimmed = text.trim()
        if (!trimmed || trimmed === item.text) return
        try {
            const updated = await api.updateTodoItem(item.id, { text: trimmed })
            withItem(list.id, item.id, (i) => Object.assign(i, updated))
        } catch (err) {
            console.error('Failed to edit item:', err)
            ui.toast('Could not update item.', 'error')
        }
    }

    const pullIntoToday = async (list: TodoList, item: TodoItem) => {
        try {
            const updated = await api.updateTodoItem(item.id, { rolled_over: false })
            withItem(list.id, item.id, (i) => Object.assign(i, updated))
        } catch (err) {
            console.error('Failed to pull item:', err)
            ui.toast('Could not pull item into today.', 'error')
        }
    }

    const removeItem = async (list: TodoList, item: TodoItem) => {
        try {
            await api.deleteTodoItem(item.id)
            setLists((l) => l.id === list.id, 'items', produce((items) => {
                const i = items.findIndex((x) => x.id === item.id)
                if (i >= 0) items.splice(i, 1)
            }))
            notifyTodoChanged(list.id)
        } catch (err) {
            console.error('Failed to delete item:', err)
            ui.toast('Could not delete item.', 'error')
        }
    }

    // Generic optimistic field patch for the v2.3 item fields.
    const patchItem = async (list: TodoList, item: TodoItem, optimistic: (i: TodoItem) => void, body: Parameters<typeof api.updateTodoItem>[1]) => {
        const before = { ...item }
        withItem(list.id, item.id, optimistic)
        try {
            const updated = await api.updateTodoItem(item.id, body)
            withItem(list.id, item.id, (i) => Object.assign(i, updated))
        } catch (err) {
            console.error('Failed to update item:', err)
            withItem(list.id, item.id, (i) => Object.assign(i, before))
            ui.toast('Could not update item.', 'error')
        }
    }

    const setPriority = (list: TodoList, item: TodoItem, priority: number) =>
        patchItem(list, item, (i) => (i.priority = priority), { priority })
    const setDue = (list: TodoList, item: TodoItem, dateInput: string) =>
        patchItem(list, item, (i) => (i.due_at = dateInput ? dateInputToIso(dateInput) : undefined), { due_at: dateInput ? dateInputToIso(dateInput) : '' })
    const setRecurrence = (list: TodoList, item: TodoItem, recurrence: string) =>
        patchItem(list, item, (i) => (i.recurrence = recurrence), { recurrence })
    const setResetMode = (list: TodoList, item: TodoItem, mode: TodoResetMode) =>
        patchItem(list, item, (i) => (i.reset_mode = mode), { reset_mode: mode })
    const linkMoment = (list: TodoList, item: TodoItem, momentId: string) =>
        patchItem(list, item, (i) => (i.moment_id = momentId || undefined), { moment_id: momentId })

    const chooseMoment = (id: string) => {
        const p = momentPicker()
        setMomentPicker(null)
        if (!p) return
        const list = lists.find((l) => l.id === p.listId)
        const item = list?.items.find((i) => i.id === p.itemId)
        if (list && item) linkMoment(list, item, id)
    }

    // "Create a new moment to link": hand off to the editor (App), which calls
    // back with the new moment id so we can link it to the task the picker was
    // opened for. The board stays mounted, so the link lands live.
    const createMomentForLink = () => {
        const p = momentPicker()
        setMomentPicker(null)
        if (!p || !props.onRequestNewMoment) return
        const list = lists.find((l) => l.id === p.listId)
        const item = list?.items.find((i) => i.id === p.itemId)
        if (!list || !item) return
        props.onRequestNewMoment((newId) => linkMoment(list, item, newId))
    }

    // Reorder top-level items within a general list, persisting the
    // position PATCH. Subtasks are grouped under their parent, so only
    // parentless items participate in the drag order.
    const reorderItems = (list: TodoList, fromId: string, toId: string) => {
        const items = list.items.filter((i) => !i.rolled_over && !i.parent_id)
        const from = items.findIndex((i) => i.id === fromId)
        const to = items.findIndex((i) => i.id === toId)
        if (from < 0 || to < 0 || from === to) return
        const reordered = [...items]
        const [moved] = reordered.splice(from, 1)
        reordered.splice(to, 0, moved)
        // Optimistic: rewrite positions in place (withItem notifies per-call).
        reordered.forEach((it, idx) => withItem(list.id, it.id, (i) => (i.position = idx)))
        // Persist (best-effort; positions are last-write-wins anyway).
        reordered.forEach((it, idx) => {
            void api.updateTodoItem(it.id, { position: idx }).catch(() => {})
        })
    }

    // Reorder whole list columns. Moves the dragged
    // column before the drop-target column and persists each new position.
    const reorderLists = (fromId: string, toId: string) => {
        const order = lists.map((l) => l.id)
        const from = order.indexOf(fromId)
        const to = order.indexOf(toId)
        if (from < 0 || to < 0 || from === to) return
        const [moved] = order.splice(from, 1)
        order.splice(to, 0, moved)
        // Optimistic: reorder the store array in place (objects keep identity,
        // so <For> reorders the DOM without disposing a column) and renumber.
        setLists(produce((arr) => {
            arr.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
            arr.forEach((l, idx) => (l.position = idx))
        }))
        order.forEach((id, idx) => {
            void api.updateTodoList(id, { position: idx }).catch(() => {})
        })
    }

    return (
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in" {...backdropDismiss(props.onClose)}>
            <div class="bg-element-matte border-element-accent flex h-[85vh] w-[92vw] max-w-6xl flex-col rounded-lg border shadow-2xl overflow-hidden">
                {/* Header */}
                <div class="bg-element border-element-accent flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
                    <div class="flex items-center gap-2">
                        <span class="material-symbols-outlined text-highlight text-xl">checklist</span>
                        <h2 class="text-main font-serif text-2xl font-semibold">To-Do Board</h2>
                    </div>

                    {/* Quick filter / sort + board/agenda toggle */}
                    <div class="flex flex-1 flex-wrap items-center justify-end gap-2">
                        <div class="border-element-accent flex overflow-hidden rounded-md border">
                            <button
                                onClick={() => setBoardView('board')}
                                class="flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors"
                                classList={{ 'bg-highlight-strongest text-white': boardView() === 'board', 'text-sub hover:text-main': boardView() !== 'board' }}
                                title="Board view"
                            >
                                <span class="material-symbols-outlined text-sm">view_kanban</span>
                                Board
                            </button>
                            <button
                                onClick={() => setBoardView('agenda')}
                                class="flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors"
                                classList={{ 'bg-highlight-strongest text-white': boardView() === 'agenda', 'text-sub hover:text-main': boardView() !== 'agenda' }}
                                title="Agenda view"
                            >
                                <span class="material-symbols-outlined text-sm">calendar_month</span>
                                Agenda
                            </button>
                        </div>
                        <div class="relative">
                            <span class="material-symbols-outlined text-sub pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-base">search</span>
                            <input
                                type="text"
                                value={search()}
                                onInput={(e) => setSearch(e.currentTarget.value)}
                                placeholder="Filter items…"
                                class="bg-element-matte text-main border-element-accent focus:border-highlight w-40 rounded-md border py-1.5 pl-8 pr-2 text-sm focus:outline-none"
                            />
                        </div>
                        <Show when={boardView() === 'board'}>
                            <button
                                onClick={() => setPref('showSubtaskAdders', !prefs().showSubtaskAdders)}
                                title={prefs().showSubtaskAdders ? 'Hide the per-task subtask inputs' : 'Show a subtask input under each task'}
                                class="border-element-accent flex items-center rounded-md border px-2 py-1.5 text-xs transition-colors"
                                classList={{ 'bg-highlight-strongest text-white': prefs().showSubtaskAdders, 'bg-element-matte text-sub hover:text-main': !prefs().showSubtaskAdders }}
                            >
                                <span class="material-symbols-outlined text-sm">subdirectory_arrow_right</span>
                            </button>
                            <select
                                value={doneFilter()}
                                onChange={(e) => setDoneFilter(e.currentTarget.value as any)}
                                class="bg-element-matte text-sub border-element-accent rounded-md border px-2 py-1.5 text-xs focus:outline-none"
                                title="Show"
                            >
                                <option value="all">All</option>
                                <option value="active">Active</option>
                                <option value="done">Done</option>
                            </select>
                            <select
                                value={sortMode()}
                                onChange={(e) => setSortMode(e.currentTarget.value as any)}
                                class="bg-element-matte text-sub border-element-accent rounded-md border px-2 py-1.5 text-xs focus:outline-none"
                                title="Sort"
                            >
                                <option value="manual">Manual order</option>
                                <option value="due">By due date</option>
                                <option value="priority">By priority</option>
                            </select>
                        </Show>
                        <button onClick={props.onClose} class="text-sub hover:text-main transition-colors" title="Close">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div class="flex-1 min-h-0 overflow-hidden">
                    <Show
                        when={!loading()}
                        fallback={
                            <div class="flex h-full items-center justify-center">
                                <p class="text-sub text-sm">Loading…</p>
                            </div>
                        }
                    >
                        <Show
                            when={!loadError()}
                            fallback={
                                <div class="flex h-full flex-col items-center justify-center gap-3 text-center">
                                    <span class="material-symbols-outlined text-danger text-3xl">error</span>
                                    <p class="text-sub text-sm">Could not load your to-do lists.</p>
                                    <button
                                        onClick={load}
                                        class="border-element-accent text-sub hover:text-main flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs transition-colors hover:cursor-pointer"
                                    >
                                        <span class="material-symbols-outlined text-sm">refresh</span>
                                        Retry
                                    </button>
                                </div>
                            }
                        >
                            <Show
                                when={boardView() === 'board'}
                                fallback={
                                    <AgendaView
                                        lists={lists}
                                        search={search()}
                                        canManage={props.canManage}
                                        onToggle={toggleById}
                                        onOpenMoment={props.onOpenMoment}
                                    />
                                }
                            >
                            <div class="flex h-full items-start gap-4 overflow-x-auto p-5">
                                <For each={lists}>
                                    {(list) => (
                                        <div
                                            class="flex max-h-full shrink-0 transition-opacity"
                                            classList={{ 'opacity-40': colDrag() === list.id }}
                                            onDragOver={(e) => {
                                                if (colDrag() && colDrag() !== list.id) e.preventDefault()
                                            }}
                                            onDrop={(e) => {
                                                const from = colDrag()
                                                if (from && from !== list.id) {
                                                    e.preventDefault()
                                                    reorderLists(from, list.id)
                                                }
                                                setColDrag(null)
                                            }}
                                        >
                                            <ListColumn
                                                list={list}
                                                canManage={props.canManage}
                                                search={search()}
                                                doneFilter={doneFilter()}
                                                sortMode={sortMode()}
                                                canReorderColumns={props.canManage && sortMode() === 'manual'}
                                                onColumnGrab={() => setColDrag(list.id)}
                                                onColumnDrop={() => setColDrag(null)}
                                                onRename={(t) => renameList(list, t)}
                                                onDelete={() => removeList(list)}
                                                onSaveNotes={(n) => saveNotes(list, n)}
                                                onReset={() => resetDay(list)}
                                                onAddItem={(t) => addItem(list, t)}
                                                onAddSubtask={(parentId, t) => addItem(list, t, parentId)}
                                                onToggle={(it) => toggleItem(list, it)}
                                                onEditItem={(it, t) => editItem(list, it, t)}
                                                onPull={(it) => pullIntoToday(list, it)}
                                                onRemoveItem={(it) => removeItem(list, it)}
                                                onSetPriority={(it, p) => setPriority(list, it, p)}
                                                onSetDue={(it, d) => setDue(list, it, d)}
                                                onSetRecurrence={(it, r) => setRecurrence(list, it, r)}
                                                onSetResetMode={(it, m) => setResetMode(list, it, m)}
                                                onLinkMoment={(it) => setMomentPicker({ listId: list.id, itemId: it.id })}
                                                onUnlinkMoment={(it) => linkMoment(list, it, '')}
                                                onOpenMoment={props.onOpenMoment}
                                                onReorder={(fromId, toId) => reorderItems(list, fromId, toId)}
                                            />
                                        </div>
                                    )}
                                </For>

                                <Show
                                    when={props.canManage}
                                    fallback={
                                        <Show when={lists.length === 0}>
                                            <p class="text-sub/60 mt-4 text-sm italic">No to-do lists yet.</p>
                                        </Show>
                                    }
                                >
                                    <div class="bg-element/40 border-element-accent flex w-72 shrink-0 flex-col gap-2 rounded-lg border border-dashed p-3">
                                        <p class="text-sub font-serif text-sm">Add a list</p>
                                        <button
                                            onClick={() => newList('general')}
                                            class="bg-highlight-strongest flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-xs text-white transition-[filter] hover:brightness-110 hover:cursor-pointer"
                                        >
                                            <span class="material-symbols-outlined text-sm">add</span>
                                            New task list
                                        </button>
                                        <button
                                            onClick={() => newList('daily')}
                                            class="border-element-accent text-sub hover:text-main flex items-center justify-center gap-1 rounded-md border px-3 py-1.5 text-xs transition-colors hover:cursor-pointer"
                                        >
                                            <span class="material-symbols-outlined text-sm">add</span>
                                            New daily list
                                        </button>
                                    </div>
                                </Show>
                            </div>
                            </Show>
                        </Show>
                    </Show>
                </div>
            </div>

            <Show when={momentPicker()}>
                <MomentPickerLite
                    onPick={chooseMoment}
                    onCreate={props.onRequestNewMoment ? createMomentForLink : undefined}
                    onClose={() => setMomentPicker(null)}
                />
            </Show>
        </div>
    )
}

// --- agenda view ---
// A cross-list timeline of every open, due-dated task, bucketed by deadline
// window. Read-mostly: you can tick an item off (which drops it from the
// agenda) or jump to its linked moment.
const AgendaView: Component<{
    lists: TodoList[]
    search: string
    canManage: boolean
    onToggle: (item: TodoItem) => void
    onOpenMoment?: (id: string) => void
}> = (props) => {
    const grouped = createMemo(() => {
        const todayDate = new Date()
        todayDate.setHours(0, 0, 0, 0)
        const today = todayDate.getTime()
        const tomorrowDate = new Date(todayDate)
        tomorrowDate.setDate(tomorrowDate.getDate() + 1)
        const tomorrow = tomorrowDate.getTime()
        const weekDate = new Date(todayDate)
        weekDate.setDate(weekDate.getDate() + 7)
        const weekEnd = weekDate.getTime()

        const q = props.search.trim().toLowerCase()
        const titles = new Map(props.lists.map((l) => [l.id, l.title]))
        const rows: { item: TodoItem; listTitle: string }[] = []
        for (const l of props.lists) {
            for (const it of l.items) {
                if (it.done || !it.due_at || it.rolled_over) continue
                if (q && !it.text.toLowerCase().includes(q)) continue
                rows.push({ item: it, listTitle: titles.get(it.list_id) ?? '' })
            }
        }
        rows.sort((a, b) => dueMs(a.item.due_at) - dueMs(b.item.due_at) || b.item.priority - a.item.priority)

        const buckets: { key: string; label: string; rows: typeof rows }[] = [
            { key: 'overdue', label: 'Overdue', rows: [] },
            { key: 'today', label: 'Today', rows: [] },
            { key: 'tomorrow', label: 'Tomorrow', rows: [] },
            { key: 'week', label: 'This week', rows: [] },
            { key: 'later', label: 'Later', rows: [] },
        ]
        for (const r of rows) {
            const ms = dueMs(r.item.due_at)
            const b =
                ms < today ? buckets[0] : ms === today ? buckets[1] : ms === tomorrow ? buckets[2] : ms <= weekEnd ? buckets[3] : buckets[4]
            b.rows.push(r)
        }
        return buckets.filter((b) => b.rows.length > 0)
    })

    return (
        <div class="h-full overflow-y-auto p-5">
            <Show
                when={grouped().length > 0}
                fallback={
                    <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
                        <span class="material-symbols-outlined text-sub/40 text-4xl">event_available</span>
                        <p class="text-sub text-sm">Nothing scheduled. Give a task a due date to see it here.</p>
                    </div>
                }
            >
                <div class="mx-auto flex max-w-2xl flex-col gap-5">
                    <For each={grouped()}>
                        {(bucket) => (
                            <div>
                                <h3 class="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide">
                                    <span
                                        classList={{
                                            'text-danger': bucket.key === 'overdue',
                                            'text-highlight': bucket.key === 'today',
                                            'text-sub': bucket.key !== 'overdue' && bucket.key !== 'today',
                                        }}
                                    >
                                        {bucket.label}
                                    </span>
                                    <span class="bg-element-accent text-sub rounded-full px-1.5 text-[10px]">{bucket.rows.length}</span>
                                </h3>
                                <div class="flex flex-col gap-1.5">
                                    <For each={bucket.rows}>
                                        {(row) => (
                                            <div
                                                class="group bg-element-matte border-element-accent flex items-center gap-2.5 rounded-md border p-2.5"
                                                style={priorityColor(row.item.priority) ? { 'border-left': `3px solid ${priorityColor(row.item.priority)}` } : {}}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={row.item.done}
                                                    disabled={!props.canManage}
                                                    onChange={() => props.onToggle(row.item)}
                                                    class="h-4 w-4 shrink-0"
                                                />
                                                <div class="min-w-0 flex-1">
                                                    <p class="text-main truncate text-sm">{row.item.text}</p>
                                                    <p class="text-sub/70 truncate text-[11px]">{row.listTitle}</p>
                                                </div>
                                                <Show when={row.item.recurrence}>
                                                    <span class="material-symbols-outlined text-sub/60 text-sm" title={`Repeats ${row.item.recurrence}`}>
                                                        repeat
                                                    </span>
                                                </Show>
                                                <Show when={row.item.moment_id}>
                                                    <button onClick={() => props.onOpenMoment?.(row.item.moment_id!)} class="text-sub hover:text-main shrink-0 hover:cursor-pointer" title="Open linked moment">
                                                        <span class="material-symbols-outlined text-sm">bookmark</span>
                                                    </button>
                                                </Show>
                                                <span
                                                    class="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold"
                                                    classList={{ 'bg-danger/20 text-danger': isOverdue(row.item), 'bg-element-accent text-sub': !isOverdue(row.item) }}
                                                >
                                                    {formatDue(row.item.due_at!)}
                                                </span>
                                            </div>
                                        )}
                                    </For>
                                </div>
                            </div>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    )
}

// --- single list column ---

interface ListColumnProps {
    list: TodoList
    canManage: boolean
    search: string
    doneFilter: 'all' | 'active' | 'done'
    sortMode: 'manual' | 'due' | 'priority'
    canReorderColumns: boolean
    onColumnGrab: () => void
    onColumnDrop: () => void
    onRename: (title: string) => void
    onDelete: () => void
    onSaveNotes: (notes: string) => void
    onReset?: () => void
    onAddItem: (text: string) => void
    onAddSubtask: (parentId: string, text: string) => void
    onToggle: (item: TodoItem) => void
    onEditItem: (item: TodoItem, text: string) => void
    onPull: (item: TodoItem) => void
    onRemoveItem: (item: TodoItem) => void
    onSetPriority: (item: TodoItem, priority: number) => void
    onSetDue: (item: TodoItem, dateInput: string) => void
    onSetRecurrence: (item: TodoItem, recurrence: string) => void
    onSetResetMode: (item: TodoItem, mode: TodoResetMode) => void
    onLinkMoment: (item: TodoItem) => void
    onUnlinkMoment: (item: TodoItem) => void
    onOpenMoment?: (id: string) => void
    onReorder: (fromId: string, toId: string) => void
}

const ListColumn: Component<ListColumnProps> = (props) => {
    const [draft, setDraft] = createSignal('')
    const [showNotes, setShowNotes] = createSignal(false)
    const [dragId, setDragId] = createSignal<string | null>(null)

    const isDaily = () => props.list.kind === 'daily'
    const total = () => props.list.items.length
    const done = () => props.list.items.filter((i) => i.done).length
    const percent = () => (total() === 0 ? 0 : Math.round((done() / total()) * 100))
    const canDrag = () => props.canManage && props.sortMode === 'manual' && !isDaily()

    // Apply the board filter, then sort per the board sort mode.
    const visible = (items: TodoItem[]) => {
        const q = props.search.trim().toLowerCase()
        let out = items.filter((i) => {
            if (q && !i.text.toLowerCase().includes(q)) return false
            if (props.doneFilter === 'active' && i.done) return false
            if (props.doneFilter === 'done' && !i.done) return false
            return true
        })
        if (props.sortMode === 'due') {
            out = [...out].sort((a, b) => dueMs(a.due_at) - dueMs(b.due_at))
        } else if (props.sortMode === 'priority') {
            out = [...out].sort((a, b) => b.priority - a.priority)
        }
        return out
    }

    // Top-level (parentless) items drive the column; subtasks nest under them.
    const rolled = () => visible(props.list.items.filter((i) => i.rolled_over && !i.parent_id))
    const current = () => visible(props.list.items.filter((i) => !i.rolled_over && !i.parent_id))
    const childrenOf = (parentId: string) => visible(props.list.items.filter((i) => i.parent_id === parentId))
    // True subtask progress (unaffected by the board filter/sort).
    const subProgress = (parentId: string) => {
        const kids = props.list.items.filter((i) => i.parent_id === parentId)
        return { done: kids.filter((k) => k.done).length, total: kids.length }
    }

    const submitDraft = () => {
        const text = draft().trim()
        if (!text) return
        props.onAddItem(text)
        setDraft('')
    }

    return (
        <div class="bg-element border-element-accent flex max-h-full w-72 shrink-0 flex-col rounded-lg border">
            {/* Column header */}
            <div class="border-element-accent flex flex-col gap-2 border-b p-3">
                <div class="flex items-center gap-2">
                    <Show when={props.canReorderColumns}>
                        <span
                            draggable={true}
                            onDragStart={(e) => {
                                e.dataTransfer?.setData('text/plain', props.list.id)
                                props.onColumnGrab()
                            }}
                            onDragEnd={() => props.onColumnDrop()}
                            title="Drag to reorder list"
                            class="material-symbols-outlined text-sub/40 hover:text-sub shrink-0 cursor-grab text-base"
                        >
                            drag_indicator
                        </span>
                    </Show>
                    <Show
                        when={props.canManage}
                        fallback={<span class="text-main font-serif flex-1 truncate text-sm font-semibold">{props.list.title}</span>}
                    >
                        <input
                            type="text"
                            value={props.list.title}
                            onChange={(e) => props.onRename(e.currentTarget.value)}
                            class="bg-element-matte text-main font-serif border-element-accent focus:border-highlight flex-1 rounded-md border px-2 py-1 text-sm font-semibold focus:outline-none"
                        />
                        <Show when={isDaily() && props.onReset}>
                            <button onClick={() => props.onReset?.()} title="Reset day" class="text-sub hover:text-main shrink-0 hover:cursor-pointer">
                                <span class="material-symbols-outlined text-base">restart_alt</span>
                            </button>
                        </Show>
                        <button onClick={props.onDelete} title="Delete list" class="text-sub hover:text-danger shrink-0 hover:cursor-pointer">
                            <span class="material-symbols-outlined text-base">delete</span>
                        </button>
                    </Show>
                </div>

                <div class="flex items-center gap-2">
                    <Show when={isDaily()}>
                        <span class="text-highlight border-element-accent rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">Daily</span>
                    </Show>
                    <span class="text-sub text-xs">
                        {done()}/{total()} done
                    </span>
                    <Show when={!isDaily() && total() > 0}>
                        <div class="bg-element-accent ml-auto h-1.5 w-16 overflow-hidden rounded-full">
                            <div class="bg-highlight-strongest h-full rounded-full transition-all" style={{ width: `${percent()}%` }} />
                        </div>
                        <span class="text-sub font-mono text-[10px]">{percent()}%</span>
                    </Show>
                </div>
            </div>

            {/* Scrollable item stack */}
            <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                <Show when={isDaily() && rolled().length > 0}>
                    <div class="border-highlight/40 bg-highlight-strongest/5 space-y-2 rounded-md border border-dashed p-2">
                        <p class="text-sub text-[10px] font-medium uppercase tracking-wide">Unfinished from yesterday</p>
                        <For each={rolled()}>
                            {(item) => (
                                <ItemCard
                                    item={item}
                                    canManage={props.canManage}
                                    rolledStyle
                                    canDrag={false}
                                    onToggle={() => props.onToggle(item)}
                                    onEdit={(t) => props.onEditItem(item, t)}
                                    onPull={() => props.onPull(item)}
                                    onRemove={() => props.onRemoveItem(item)}
                                    onSetPriority={(p) => props.onSetPriority(item, p)}
                                    onSetDue={(d) => props.onSetDue(item, d)}
                                    onSetRecurrence={(r) => props.onSetRecurrence(item, r)}
                                    onSetResetMode={(m) => props.onSetResetMode(item, m)}
                                    onLinkMoment={() => props.onLinkMoment(item)}
                                    onUnlinkMoment={() => props.onUnlinkMoment(item)}
                                    onOpenMoment={props.onOpenMoment}
                                />
                            )}
                        </For>
                    </div>
                </Show>

                <Show when={current().length > 0} fallback={<p class="text-sub/50 py-2 text-center text-xs italic">No items.</p>}>
                    <For each={current()}>
                        {(item) => (
                            <div>
                                <div
                                    draggable={canDrag()}
                                    onDragStart={(e) => {
                                        if (!canDrag()) return
                                        setDragId(item.id)
                                        e.dataTransfer?.setData('text/plain', item.id)
                                    }}
                                    onDragOver={(e) => {
                                        if (canDrag() && dragId() && dragId() !== item.id) e.preventDefault()
                                    }}
                                    onDrop={(e) => {
                                        if (!canDrag()) return
                                        e.preventDefault()
                                        const from = dragId()
                                        if (from && from !== item.id) props.onReorder(from, item.id)
                                        setDragId(null)
                                    }}
                                    onDragEnd={() => setDragId(null)}
                                    classList={{ 'opacity-40': dragId() === item.id }}
                                >
                                    <ItemCard
                                        item={item}
                                        canManage={props.canManage}
                                        canDrag={canDrag()}
                                        subCount={subProgress(item.id)}
                                        onToggle={() => props.onToggle(item)}
                                        onEdit={(t) => props.onEditItem(item, t)}
                                        onPull={() => props.onPull(item)}
                                        onRemove={() => props.onRemoveItem(item)}
                                        onSetPriority={(p) => props.onSetPriority(item, p)}
                                        onSetDue={(d) => props.onSetDue(item, d)}
                                        onSetRecurrence={(r) => props.onSetRecurrence(item, r)}
                                        onSetResetMode={(m) => props.onSetResetMode(item, m)}
                                        onLinkMoment={() => props.onLinkMoment(item)}
                                        onUnlinkMoment={() => props.onUnlinkMoment(item)}
                                        onOpenMoment={props.onOpenMoment}
                                    />
                                </div>

                                {/* Subtasks: nested one level under the parent. The
                                    per-task adder is hidden unless toggled on (prefs). */}
                                <Show when={childrenOf(item.id).length > 0 || (props.canManage && !isDaily() && prefs().showSubtaskAdders)}>
                                    <div class="border-element-accent ml-4 mt-1.5 space-y-1.5 border-l pl-2.5">
                                        <For each={childrenOf(item.id)}>
                                            {(sub) => (
                                                <ItemCard
                                                    item={sub}
                                                    canManage={props.canManage}
                                                    canDrag={false}
                                                    subtask
                                                    onToggle={() => props.onToggle(sub)}
                                                    onEdit={(t) => props.onEditItem(sub, t)}
                                                    onPull={() => props.onPull(sub)}
                                                    onRemove={() => props.onRemoveItem(sub)}
                                                    onSetPriority={(p) => props.onSetPriority(sub, p)}
                                                    onSetDue={(d) => props.onSetDue(sub, d)}
                                                    onSetRecurrence={(r) => props.onSetRecurrence(sub, r)}
                                                    onSetResetMode={(m) => props.onSetResetMode(sub, m)}
                                                    onLinkMoment={() => props.onLinkMoment(sub)}
                                                    onUnlinkMoment={() => props.onUnlinkMoment(sub)}
                                                    onOpenMoment={props.onOpenMoment}
                                                />
                                            )}
                                        </For>
                                        <Show when={props.canManage && !isDaily() && prefs().showSubtaskAdders}>
                                            <SubtaskAdder onAdd={(t) => props.onAddSubtask(item.id, t)} />
                                        </Show>
                                    </div>
                                </Show>
                            </div>
                        )}
                    </For>
                </Show>

                {/* Notes (task lists only) */}
                <Show when={!isDaily()}>
                    <div class="pt-1">
                        <button onClick={() => setShowNotes((v) => !v)} class="text-sub hover:text-main flex items-center gap-1 text-[11px] hover:cursor-pointer">
                            <span class="material-symbols-outlined text-sm">{showNotes() ? 'expand_less' : 'expand_more'}</span>
                            Notes
                        </button>
                        <Show when={showNotes()}>
                            <textarea
                                value={props.list.notes}
                                disabled={!props.canManage}
                                onBlur={(e) => props.canManage && props.onSaveNotes(e.currentTarget.value)}
                                placeholder="Notes…"
                                rows={3}
                                class="bg-element-matte text-sub border-element-accent focus:border-highlight mt-1 w-full resize-y rounded-md border px-2 py-1.5 text-xs focus:outline-none disabled:opacity-70"
                            />
                        </Show>
                    </div>
                </Show>
            </div>

            {/* Add item */}
            <Show when={props.canManage}>
                {/* A form, not a bare input: a touch keyboard's go key submits
                    the enclosing form, and with no form to submit it did
                    nothing here. preventDefault stops the browser navigating
                    to the form action, which is what made Enter look like it
                    was leaving the board. enterkeyhint labels the key. */}
                <form
                    class="border-element-accent border-t p-3"
                    onSubmit={(e) => {
                        e.preventDefault()
                        submitDraft()
                    }}
                >
                    <input
                        type="text"
                        value={draft()}
                        enterkeyhint="done"
                        onInput={(e) => setDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault()
                                submitDraft()
                            }
                        }}
                        placeholder="Add an item…"
                        class="bg-element-matte text-main border-element-accent focus:border-highlight w-full rounded-md border px-2 py-1.5 text-sm focus:outline-none"
                    />
                </form>
            </Show>
        </div>
    )
}

// --- single item card ---

interface ItemCardProps {
    item: TodoItem
    canManage: boolean
    rolledStyle?: boolean
    canDrag: boolean
    // subtask renders the card more compactly (nested under a parent);
    // subCount shows a done/total badge for a parent that has children.
    subtask?: boolean
    subCount?: { done: number; total: number }
    onToggle: () => void
    onEdit: (text: string) => void
    onPull: () => void
    onRemove: () => void
    onSetPriority: (priority: number) => void
    onSetDue: (dateInput: string) => void
    onSetRecurrence: (recurrence: string) => void
    onSetResetMode: (mode: TodoResetMode) => void
    onLinkMoment: () => void
    onUnlinkMoment: () => void
    onOpenMoment?: (id: string) => void
}

const ItemCard: Component<ItemCardProps> = (props) => {
    const [editing, setEditing] = createSignal(false)
    const [draft, setDraft] = createSignal('')
    const [detail, setDetail] = createSignal(false)

    const startEdit = () => {
        if (!props.canManage) return
        setDraft(props.item.text)
        setEditing(true)
    }
    const commit = () => {
        props.onEdit(draft())
        setEditing(false)
    }

    const edgeColor = () => priorityColor(props.item.priority)

    return (
        <div
            class="group bg-element-matte border-element-accent flex flex-col gap-1.5 rounded-md border"
            classList={{ 'p-2': !props.subtask, 'p-1.5': props.subtask }}
            style={edgeColor() ? { 'border-left': `3px solid ${edgeColor()}` } : {}}
        >
            <div class="flex items-start gap-2">
                <Show when={props.canDrag}>
                    <span class="material-symbols-outlined text-sub/40 mt-0.5 cursor-grab text-sm" title="Drag to reorder">drag_indicator</span>
                </Show>
                <input type="checkbox" checked={props.item.done} disabled={!props.canManage} onChange={props.onToggle} class="mt-0.5 h-4 w-4 shrink-0" />
                <Show
                    when={editing()}
                    fallback={
                        <span
                            onClick={startEdit}
                            class="flex-1 break-words text-sm"
                            classList={{
                                'text-sub line-through': props.item.done,
                                'text-main': !props.item.done && !props.rolledStyle,
                                'text-sub': !props.item.done && props.rolledStyle,
                                'cursor-text': props.canManage,
                            }}
                        >
                            {props.item.text}
                        </span>
                    }
                >
                    <input
                        type="text"
                        value={draft()}
                        ref={(el) => queueMicrotask(() => el.focus())}
                        onInput={(e) => setDraft(e.currentTarget.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') commit()
                            else if (e.key === 'Escape') setEditing(false)
                        }}
                        class="bg-element text-main border-element-accent focus:border-highlight flex-1 rounded border px-1.5 py-0.5 text-sm focus:outline-none"
                    />
                </Show>

                <Show when={props.subCount && props.subCount.total > 0}>
                    <span
                        class="text-sub bg-element-accent mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold"
                        classList={{ 'text-highlight': props.subCount!.done === props.subCount!.total }}
                        title="Subtasks complete"
                    >
                        {props.subCount!.done}/{props.subCount!.total}
                    </span>
                </Show>
                <Show when={props.canManage && props.rolledStyle}>
                    <button onClick={props.onPull} title="Pull into today" class="text-sub hover:text-main shrink-0 hover:cursor-pointer">
                        <span class="material-symbols-outlined text-base">arrow_downward</span>
                    </button>
                </Show>
                <Show when={props.canManage}>
                    <button
                        onClick={() => setDetail((v) => !v)}
                        title="Details"
                        class="text-sub hover:text-main shrink-0 hover:cursor-pointer"
                        classList={{ 'text-highlight': detail() }}
                    >
                        <span class="material-symbols-outlined text-base">tune</span>
                    </button>
                    <button onClick={props.onRemove} title="Delete item" class="text-sub hover:text-danger shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:cursor-pointer">
                        <span class="material-symbols-outlined text-base">close</span>
                    </button>
                </Show>
            </div>

            {/* Chips row: due / recurrence / linked moment */}
            <Show when={props.item.due_at || props.item.recurrence || props.item.moment_id}>
                <div class="flex flex-wrap items-center gap-1 pl-6">
                    <Show when={props.item.due_at}>
                        <span
                            class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold"
                            classList={{
                                'bg-danger/20 text-danger': isOverdue(props.item),
                                'bg-highlight-strongest/20 text-highlight': isDueToday(props.item),
                                'bg-element-accent text-sub': !isOverdue(props.item) && !isDueToday(props.item),
                            }}
                            title={isOverdue(props.item) ? 'Overdue' : isDueToday(props.item) ? 'Due today' : 'Due'}
                        >
                            <span class="material-symbols-outlined text-[12px]">event</span>
                            {formatDue(props.item.due_at!)}
                        </span>
                    </Show>
                    <Show when={props.item.recurrence}>
                        {/* A completed repeating task stays ticked until its next
                            occurrence comes round and the server unchecks it, so
                            say when that is rather than leaving the due chip beside
                            a done task looking like a contradiction. */}
                        <span
                            class="bg-element-accent text-sub flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold"
                            title={
                                props.item.done && props.item.due_at
                                    ? `Repeats ${props.item.recurrence} · back on ${formatDue(props.item.due_at)}`
                                    : `Repeats ${props.item.recurrence}`
                            }
                        >
                            <span class="material-symbols-outlined text-[12px]">repeat</span>
                            {props.item.recurrence}
                        </span>
                    </Show>
                    <Show when={props.item.moment_id}>
                        <button
                            onClick={() => props.onOpenMoment?.(props.item.moment_id!)}
                            class="bg-element-accent text-sub hover:text-main flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold hover:cursor-pointer"
                            title="Open linked moment"
                        >
                            <span class="material-symbols-outlined text-[12px]">bookmark</span>
                            <MomentLabel id={props.item.moment_id!} />
                        </button>
                    </Show>
                </div>
            </Show>

            {/* Detail editor */}
            <Show when={detail() && props.canManage}>
                <div class="border-element-accent mt-1 flex flex-col gap-2 rounded-md border border-dashed p-2 pl-6">
                    <div class="flex items-center gap-1">
                        <span class="text-sub w-16 text-[10px] font-bold uppercase tracking-wide">Priority</span>
                        <For each={PRIORITIES}>
                            {(p) => (
                                <button
                                    onClick={() => props.onSetPriority(p.v)}
                                    class="rounded px-1.5 py-0.5 text-[10px] font-bold transition-all"
                                    classList={{ 'ring-1 ring-highlight-strongest': props.item.priority === p.v }}
                                    style={p.color ? { background: p.color, color: '#1c1c1c' } : { background: 'var(--color-element-accent, #333)' }}
                                >
                                    {p.label}
                                </button>
                            )}
                        </For>
                    </div>
                    <div class="flex items-center gap-1">
                        <span class="text-sub w-16 text-[10px] font-bold uppercase tracking-wide">Due</span>
                        <input
                            type="date"
                            value={isoToDateInput(props.item.due_at)}
                            onChange={(e) => props.onSetDue(e.currentTarget.value)}
                            class="bg-element text-main border-element-accent focus:border-highlight flex-1 rounded border px-2 py-1 text-xs focus:outline-none"
                        />
                        <Show when={props.item.due_at}>
                            <button onClick={() => props.onSetDue('')} title="Clear due date" class="text-sub hover:text-danger shrink-0">
                                <span class="material-symbols-outlined text-sm">close</span>
                            </button>
                        </Show>
                    </div>
                    <div class="flex items-center gap-1">
                        <span class="text-sub w-16 text-[10px] font-bold uppercase tracking-wide">Repeat</span>
                        <select
                            value={props.item.recurrence}
                            onChange={(e) => props.onSetRecurrence(e.currentTarget.value)}
                            class="bg-element text-main border-element-accent flex-1 rounded border px-2 py-1 text-xs focus:outline-none"
                        >
                            <For each={RECURRENCES}>{(r) => <option value={r}>{r === '' ? 'Never' : r}</option>}</For>
                        </select>
                    </div>
                    {/* Only meaningful once the item repeats, so it stays out
                        of the way until then. */}
                    <Show when={props.item.recurrence}>
                        <div class="flex items-center gap-1">
                            <span class="text-sub w-16 text-[10px] font-bold uppercase tracking-wide">Resets</span>
                            <select
                                value={props.item.reset_mode}
                                onChange={(e) => props.onSetResetMode(e.currentTarget.value as TodoResetMode)}
                                title={RESET_MODES.find((m) => m.value === props.item.reset_mode)?.hint}
                                class="bg-element text-main border-element-accent flex-1 rounded border px-2 py-1 text-xs focus:outline-none"
                            >
                                <For each={RESET_MODES}>{(m) => <option value={m.value}>{m.label}</option>}</For>
                            </select>
                        </div>
                    </Show>
                    <div class="flex items-center gap-1">
                        <span class="text-sub w-16 text-[10px] font-bold uppercase tracking-wide">Moment</span>
                        <Show
                            when={props.item.moment_id}
                            fallback={
                                <button onClick={props.onLinkMoment} class="text-sub hover:text-main flex items-center gap-1 text-xs hover:cursor-pointer">
                                    <span class="material-symbols-outlined text-sm">add_link</span>
                                    Link a moment
                                </button>
                            }
                        >
                            <button onClick={props.onUnlinkMoment} class="text-sub hover:text-danger flex items-center gap-1 text-xs hover:cursor-pointer">
                                <span class="material-symbols-outlined text-sm">link_off</span>
                                Unlink
                            </button>
                        </Show>
                    </div>
                </div>
            </Show>
        </div>
    )
}

// Compact inline input for adding a subtask under a parent item.
const SubtaskAdder: Component<{ onAdd: (text: string) => void }> = (props) => {
    const [draft, setDraft] = createSignal('')
    const submit = () => {
        const text = draft().trim()
        if (!text) return
        props.onAdd(text)
        setDraft('')
    }
    // Same reason as the add-item field above: a form so a touch keyboard's go
    // key has something to submit.
    return (
        <form
            class="flex items-center gap-1"
            onSubmit={(e) => {
                e.preventDefault()
                submit()
            }}
        >
            <span class="material-symbols-outlined text-sub/40 text-sm">subdirectory_arrow_right</span>
            <input
                type="text"
                value={draft()}
                enterkeyhint="done"
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault()
                        submit()
                    }
                }}
                placeholder="Add a subtask…"
                class="bg-element-matte text-main border-element-accent focus:border-highlight w-full rounded border px-2 py-1 text-xs focus:outline-none"
            />
        </form>
    )
}

// Resolves a linked moment's title for the chip (cached).
const MomentLabel: Component<{ id: string }> = (props) => {
    const [title, setTitle] = createSignal(momentTitleCache.get(props.id) ?? 'Moment')
    onMount(async () => {
        if (momentTitleCache.has(props.id)) return
        try {
            const linked = await api.getMoment(props.id)
            const title = linked.title || 'Untitled'
            momentTitleCache.set(props.id, title)
            setTitle(title)
        } catch {
            setTitle('(deleted)')
        }
    })
    return <span class="max-w-24 truncate">{title()}</span>
}

// Minimal searchable moment picker (self-fetching) for linking a moment.
const MomentPickerLite: Component<{ onPick: (id: string) => void; onCreate?: () => void; onClose: () => void }> = (props) => {
    const [query, setQuery] = createSignal('')
    const [moments, setMoments] = createSignal<{ id: string; title: string; content: string }[]>([])
    const [loading, setLoading] = createSignal(true)

    onMount(async () => {
        try {
            const data = (await api.listMoments({ limit: 100 })) ?? []
            setMoments(data.map((m) => ({ id: m.id, title: m.title || 'Untitled', content: m.content })))
        } catch {
            setMoments([])
        } finally {
            setLoading(false)
        }
    })

    const filtered = createMemo(() => {
        const q = query().trim().toLowerCase()
        if (!q) return moments()
        return moments().filter((m) => m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q))
    })

    const nav = createListboxNav(filtered, (m) => props.onPick(m.id), props.onClose)

    return (
        <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" {...backdropDismiss(props.onClose)}>
            <div class="bg-element-matte border-element-accent w-full max-w-md rounded-lg border p-4 shadow-2xl">
                <div class="mb-3 flex items-center justify-between">
                    <h3 class="text-main font-serif text-base">Link a moment</h3>
                    <button onClick={props.onClose} class="text-sub hover:text-main hover:cursor-pointer">
                        <span class="material-symbols-outlined text-base">close</span>
                    </button>
                </div>
                <input
                    autofocus
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                    onKeyDown={nav.onKeyDown}
                    placeholder="Search moments…"
                    class="bg-element border-element-accent text-main mb-2 w-full rounded-md border px-3 py-2 text-sm focus:outline-none"
                />
                <Show when={props.onCreate}>
                    <button
                        onClick={() => props.onCreate?.()}
                        class="border-highlight-strongest/40 text-highlight hover:bg-highlight-strongest/10 mb-2 flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm font-medium transition-colors hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined text-base">add</span>
                        Create a new moment to link
                    </button>
                </Show>
                <div ref={nav.setListRef} class="max-h-72 overflow-y-auto">
                    <Show when={!loading()} fallback={<p class="text-sub p-2 text-sm">Loading…</p>}>
                        <Show when={filtered().length > 0} fallback={<p class="text-sub/60 p-2 text-sm italic">No matches.</p>}>
                            <For each={filtered()}>
                                {(m, index) => (
                                    <button
                                        onClick={() => props.onPick(m.id)}
                                        onMouseMove={() => nav.setActive(index())}
                                        class="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:cursor-pointer"
                                        classList={{
                                            'bg-element-accent': nav.active() === index(),
                                            'hover:bg-element-accent': nav.active() !== index(),
                                        }}
                                    >
                                        <span class="text-main text-sm font-bold truncate">{m.title}</span>
                                        <span class="text-sub line-clamp-1 text-xs">{m.content}</span>
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

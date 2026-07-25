import { createSignal, createEffect, For, Show, Switch, Match, onMount, onCleanup, type Component } from 'solid-js'
import { Portal } from 'solid-js/web'
import { createStore, produce } from 'solid-js/store'
import { api, type Canvas, type CanvasNode, type CanvasEdge, type CanvasNodeKind, type Moment, type TodoList } from '../api'
import { useUI } from '../ui'
import { backdropDismiss } from '../dismiss'
import { createListboxNav } from '../listboxNav'
import { useIsDesktop } from '../media'
import { createLongPress } from '../longPress'

// Prepend https:// when a link node's URL has no scheme, so `example.com`
// opens externally instead of resolving as an in-app relative path.
const withScheme = (u: string) => (/^[a-zA-Z][\w+.-]*:\/\//.test(u) ? u : `https://${u}`)

// Small module-level cache for moment-ref / todo-ref lookups so a card that
// remounts (e.g. reopening a canvas) resolves from cache instead of flashing a
// loading state and re-hitting the network.
const momentRefCache = new Map<string, Moment>()
const todoRefCache = new Map<string, TodoList>()

// Canvas module (4.10 / ADR-0013): an infinite pan/zoom board of nodes.
//
// Concurrency note (ADR-0013): node writes are Last-Writer-Wins with no
// WebSocket / realtime channel. If two clients drag or edit the same node
// concurrently, the last PATCH to land silently clobbers the other's change.
// This is an accepted trade-off for v2.1. Collaborative editing (CRDT / OT
// over a live socket) is explicitly out of scope. Refetch on open to resync.

interface CanvasModuleProps {
    onClose: () => void
    canManage: boolean
    onOpenMoment?: (id: string) => void
}

const MIN_SCALE = 0.25
const MAX_SCALE = 2.5
const GRID = 24 // snap-to-grid step, world units

// Presentation-only style blob stored in CanvasNode.style (JSON).
interface NodeStyle {
    color?: string
    fontSize?: number
    shape?: ShapeKind
}

// Real shape subtypes, rendered as fillable SVG behind a centered label.
type ShapeKind = 'rect' | 'round' | 'ellipse' | 'diamond' | 'triangle'
const SHAPES: { kind: ShapeKind; icon: string; label: string }[] = [
    { kind: 'rect', icon: 'crop_square', label: 'Rectangle' },
    { kind: 'round', icon: 'rounded_corner', label: 'Rounded' },
    { kind: 'ellipse', icon: 'circle', label: 'Ellipse' },
    { kind: 'diamond', icon: 'diamond', label: 'Diamond' },
    { kind: 'triangle', icon: 'change_history', label: 'Triangle' },
]

const parseStyle = (raw?: string): NodeStyle => {
    if (!raw) return {}
    try {
        return JSON.parse(raw) as NodeStyle
    } catch {
        return {}
    }
}

// A quiet, readable palette for sticky/shape/text backgrounds.
const NODE_COLORS = [
    '#f6e58d', '#ffbe76', '#ff7979', '#badc58', '#7ed6df',
    '#e056fd', '#dff9fb', '#dfe6e9', '#95a5a6', '#2d3436',
]

// Default node geometry per kind (world units).
const NODE_DEFAULTS: Record<CanvasNodeKind, { w: number; h: number }> = {
    text: { w: 220, h: 140 },
    sticky: { w: 180, h: 160 },
    image: { w: 240, h: 180 },
    'moment-ref': { w: 240, h: 150 },
    shape: { w: 160, h: 120 },
    link: { w: 240, h: 64 },
    'todo-ref': { w: 240, h: 130 },
}

interface Point {
    x: number
    y: number
}

export const CanvasModule: Component<CanvasModuleProps> = (props) => {
    const ui = useUI()
    // Below lg the module goes full-screen, the canvas list collapses into a
    // slide-in drawer, and the toolbar drops to the bottom (§ mobile canvas).
    const isDesktop = useIsDesktop()
    const [showList, setShowList] = createSignal(false)
    const [canvases, setCanvases] = createSignal<Canvas[]>([])
    // The active canvas lives in a fine-grained store so node mutations patch
    // fields *in place* rather than swapping the node object. That stops <For>
    // from remounting a node on every drag frame, which is what made
    // moment-ref cards "constantly refresh".
    const [canvasStore, setCanvasStore] = createStore<{ c: Canvas | null }>({ c: null })
    const active = () => canvasStore.c
    const [loading, setLoading] = createSignal(true)

    // Viewport transform.
    const [pan, setPan] = createSignal({ x: 0, y: 0 })
    const [scale, setScale] = createSignal(1)

    // Interaction state.
    const [tool, setTool] = createSignal<'pan' | 'select'>('pan')
    const [snap, setSnap] = createSignal(false)
    const [selection, setSelection] = createSignal<string[]>([])
    const [marquee, setMarquee] = createSignal<{ x: number; y: number; w: number; h: number } | null>(null)

    // Overlays.
    const [contextMenu, setContextMenu] = createSignal<{ sx: number; sy: number; world: Point; nodeId?: string; connectFrom?: string } | null>(null)
    const [stylePopover, setStylePopover] = createSignal<{ nodeId: string; sx: number; sy: number } | null>(null)
    const [momentPicker, setMomentPicker] = createSignal<{ world: Point; replaceId?: string } | null>(null)
    const [todoPicker, setTodoPicker] = createSignal<{ world: Point; replaceId?: string } | null>(null)
    const [linkPrompt, setLinkPrompt] = createSignal<{ world: Point; replaceId?: string; initial?: string } | null>(null)

    // When set, the next node created is auto-connected from this node id (§ drag
    // a connector into empty space → create a connected node). Cleared on use or
    // when the creating picker/prompt is dismissed.
    let connectAfterCreate: string | null = null
    const [guideOpen, setGuideOpen] = createSignal(false)
    const [editingId, setEditingId] = createSignal<string | null>(null)

    // Connector drag (reactive parts, so the temp line can render live).
    const [connectFrom, setConnectFrom] = createSignal<string | null>(null)
    const [connectCursor, setConnectCursor] = createSignal<Point | null>(null)
    // Click-to-click connect mode, started from a node's "Connect to…" menu.
    const [pendingConnect, setPendingConnect] = createSignal<string | null>(null)

    const cancelPendingConnect = () => {
        setPendingConnect(null)
        setConnectFrom(null)
        setConnectCursor(null)
    }

    let surfaceRef: HTMLDivElement | undefined
    let fileInputRef: HTMLInputElement | undefined
    let pendingImageWorld: Point | null = null

    const loadCanvases = async () => {
        setLoading(true)
        try {
            const data = await api.listCanvases()
            setCanvases(data ?? [])
        } catch (err) {
            console.error('Failed to load canvases:', err)
            ui.toast('Could not load canvases.', 'error')
        } finally {
            setLoading(false)
        }
    }

    onMount(loadCanvases)

    const openCanvas = async (id: string) => {
        try {
            const canvas = await api.getCanvas(id)
            setCanvasStore('c', { ...canvas, nodes: canvas.nodes ?? [], edges: canvas.edges ?? [] })
            setPan({ x: 0, y: 0 })
            setScale(1)
            setSelection([])
            setShowList(false) // mobile: dismiss the drawer once a canvas is open
        } catch (err) {
            console.error('Failed to open canvas:', err)
            ui.toast('Could not open canvas.', 'error')
        }
    }

    const newCanvas = async () => {
        try {
            const created = await api.createCanvas('Untitled canvas')
            setCanvases((prev) => [...prev, created])
            await openCanvas(created.id)
        } catch (err) {
            console.error('Failed to create canvas:', err)
            ui.toast('Could not create canvas.', 'error')
        }
    }

    // Inline rename in the sidebar list. Held by id rather than as a flag on
    // the canvas so only one row is ever editable at a time.
    const [renamingId, setRenamingId] = createSignal<string | null>(null)
    const [renameDraft, setRenameDraft] = createSignal('')

    const startRename = (canvas: Canvas) => {
        setRenamingId(canvas.id)
        setRenameDraft(canvas.title)
    }

    const commitRename = async () => {
        const id = renamingId()
        if (!id) return
        setRenamingId(null)
        const before = canvases().find((c) => c.id === id)
        const title = renameDraft().trim()
        // An empty title would render an unclickable blank row, so treat it as
        // a cancel rather than saving it.
        if (!before || !title || title === before.title) return

        const apply = (t: string) => {
            setCanvases((prev) => prev.map((c) => (c.id === id ? { ...c, title: t } : c)))
            if (active()?.id === id) setCanvasStore('c', (c) => (c ? { ...c, title: t } : c))
        }
        apply(title) // optimistic; the list is the only place the title shows
        try {
            await api.updateCanvas(id, title)
        } catch (err) {
            console.error('Failed to rename canvas:', err)
            apply(before.title)
            ui.toast('Could not rename canvas.', 'error')
        }
    }

    const removeCanvas = async (canvas: Canvas) => {
        const ok = await ui.confirm({
            title: 'Delete canvas?',
            message: `"${canvas.title}" and all of its nodes will be permanently removed.`,
            confirmLabel: 'Delete',
            danger: true,
        })
        if (!ok) return
        try {
            await api.deleteCanvas(canvas.id)
            setCanvases((prev) => prev.filter((c) => c.id !== canvas.id))
            if (active()?.id === canvas.id) setCanvasStore('c', null)
            ui.toast('Canvas deleted.', 'success')
        } catch (err) {
            console.error('Failed to delete canvas:', err)
            ui.toast('Could not delete canvas.', 'error')
        }
    }

    // --- node local-state helpers ---

    const patchNode = (id: string, patch: Partial<CanvasNode>) => {
        if (!canvasStore.c) return
        // In-place merge: preserves the node's object identity so its <For>
        // row (and any embedded card) is never remounted.
        setCanvasStore('c', 'nodes', (n) => n.id === id, patch)
    }

    const nodeById = (id: string) => active()?.nodes.find((n) => n.id === id)

    // Nodes sorted by z-order for stacking (last = on top).
    const sortedNodes = () => [...(active()?.nodes ?? [])].sort((a, b) => a.z_order - b.z_order)

    const closeMenus = () => {
        setContextMenu(null)
        setStylePopover(null)
    }

    // --- viewport interaction ---

    const toWorld = (clientX: number, clientY: number): Point => {
        const rect = surfaceRef?.getBoundingClientRect()
        const px = clientX - (rect?.left ?? 0)
        const py = clientY - (rect?.top ?? 0)
        return { x: (px - pan().x) / scale(), y: (py - pan().y) / scale() }
    }

    const handleWheel = (e: WheelEvent) => {
        e.preventDefault()
        const rect = surfaceRef?.getBoundingClientRect()
        const cx = e.clientX - (rect?.left ?? 0)
        const cy = e.clientY - (rect?.top ?? 0)
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale() * factor))
        const worldX = (cx - pan().x) / scale()
        const worldY = (cy - pan().y) / scale()
        setPan({ x: cx - worldX * next, y: cy - worldY * next })
        setScale(next)
    }

    const viewCenterWorld = (): Point => {
        const rect = surfaceRef?.getBoundingClientRect()
        const w = rect?.width ?? 0
        const h = rect?.height ?? 0
        return { x: (w / 2 - pan().x) / scale(), y: (h / 2 - pan().y) / scale() }
    }

    // --- drag machinery ---

    type DragState =
        | { kind: 'pan'; startX: number; startY: number; panX: number; panY: number }
        | { kind: 'node'; startX: number; startY: number; origins: Map<string, Point>; moved: boolean }
        | { kind: 'resize'; id: string; startX: number; startY: number; w0: number; h0: number }
        | { kind: 'marquee'; startWX: number; startWY: number }
        | { kind: 'connect'; fromId: string }
    let drag: DragState | null = null

    // Two-finger pinch-zoom (mobile). Tracked apart from `drag`: when a second
    // pointer lands on the surface we abort any single-pointer drag and scale +
    // pan around the pinch midpoint.
    const activePointers = new Map<number, { x: number; y: number }>()
    let pinch: { dist: number; scale: number; panX: number; panY: number; midX: number; midY: number } | null = null
    const pinchPts = () => [...activePointers.values()]
    const pinchDist = () => {
        const [a, b] = pinchPts()
        return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const pinchMid = () => {
        const [a, b] = pinchPts()
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }
    const abortDrag = () => {
        drag = null
        window.removeEventListener('pointermove', onWindowMove)
        window.removeEventListener('pointerup', onWindowUp)
    }

    const snapV = (v: number) => (snap() ? Math.round(v / GRID) * GRID : v)

    // Draw the snap grid (screen-space, aligned to the world via pan/scale) only
    // while snap is on, so the grid the user snaps to is actually visible.
    const gridStyle = (): Record<string, string> => {
        if (!snap()) return {}
        const step = GRID * scale()
        return {
            'background-image':
                'linear-gradient(to right, rgba(128,128,128,0.18) 1px, transparent 1px),' +
                'linear-gradient(to bottom, rgba(128,128,128,0.18) 1px, transparent 1px)',
            'background-size': `${step}px ${step}px`,
            'background-position': `${pan().x}px ${pan().y}px`,
        }
    }

    const rectFrom = (ax: number, ay: number, bx: number, by: number) => ({
        x: Math.min(ax, bx),
        y: Math.min(ay, by),
        w: Math.abs(ax - bx),
        h: Math.abs(ay - by),
    })

    const intersects = (a: { x: number; y: number; w: number; h: number }, n: CanvasNode) =>
        a.x < n.x + n.w && a.x + a.w > n.x && a.y < n.y + n.h && a.y + a.h > n.y

    const onWindowMove = (e: PointerEvent) => {
        if (!drag) return
        if (drag.kind === 'pan') {
            setPan({ x: drag.panX + (e.clientX - drag.startX), y: drag.panY + (e.clientY - drag.startY) })
        } else if (drag.kind === 'node') {
            const dx = (e.clientX - drag.startX) / scale()
            const dy = (e.clientY - drag.startY) / scale()
            if (Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3) drag.moved = true
            // Snap live while dragging (not only on drop) so the grid feels real.
            for (const [id, origin] of drag.origins) patchNode(id, { x: snapV(origin.x + dx), y: snapV(origin.y + dy) })
        } else if (drag.kind === 'resize') {
            const dx = (e.clientX - drag.startX) / scale()
            const dy = (e.clientY - drag.startY) / scale()
            patchNode(drag.id, { w: Math.max(60, drag.w0 + dx), h: Math.max(48, drag.h0 + dy) })
        } else if (drag.kind === 'marquee') {
            const w = toWorld(e.clientX, e.clientY)
            const box = rectFrom(drag.startWX, drag.startWY, w.x, w.y)
            setMarquee(box)
            setSelection((active()?.nodes ?? []).filter((n) => intersects(box, n)).map((n) => n.id))
        } else if (drag.kind === 'connect') {
            setConnectCursor(toWorld(e.clientX, e.clientY))
        }
    }

    const onWindowUp = async (e: PointerEvent) => {
        const finished = drag
        drag = null
        window.removeEventListener('pointermove', onWindowMove)
        window.removeEventListener('pointerup', onWindowUp)
        if (!finished) return

        if (finished.kind === 'node' && finished.moved) {
            await Promise.all(
                [...finished.origins.keys()].map(async (id) => {
                    const node = nodeById(id)
                    if (!node) return
                    const x = snapV(node.x)
                    const y = snapV(node.y)
                    patchNode(id, { x, y })
                    try {
                        await api.updateCanvasNode(id, { x, y })
                    } catch (err) {
                        console.error('Failed to move node:', err)
                        ui.toast('Could not save node position.', 'error')
                    }
                }),
            )
        } else if (finished.kind === 'resize') {
            const node = nodeById(finished.id)
            if (node) {
                const w = Math.max(60, snapV(node.w))
                const h = Math.max(48, snapV(node.h))
                patchNode(finished.id, { w, h })
                try {
                    await api.updateCanvasNode(finished.id, { w, h })
                } catch (err) {
                    console.error('Failed to resize node:', err)
                    ui.toast('Could not save node size.', 'error')
                }
            }
        } else if (finished.kind === 'marquee') {
            setMarquee(null)
        } else if (finished.kind === 'connect') {
            const world = toWorld(e.clientX, e.clientY)
            const target = [...sortedNodes()].reverse().find(
                (n) => world.x >= n.x && world.x <= n.x + n.w && world.y >= n.y && world.y <= n.y + n.h,
            )
            setConnectFrom(null)
            setConnectCursor(null)
            if (target && target.id !== finished.fromId) {
                await createEdge(finished.fromId, target.id)
            } else if (!target && props.canManage) {
                // Dropped in empty space: offer to create a node here, which the
                // menu will auto-connect back to the source (§ connect-to-empty).
                setContextMenu({ sx: e.clientX, sy: e.clientY, world, connectFrom: finished.fromId })
            }
        }
    }

    const startDrag = (state: DragState, e: PointerEvent) => {
        drag = state
        window.addEventListener('pointermove', onWindowMove)
        window.addEventListener('pointerup', onWindowUp)
        e.preventDefault()
    }

    const onSurfacePointerDown = (e: PointerEvent) => {
        // Track surface-initiated pointers for pinch. A second one starts a
        // pinch and takes over from whatever single-pointer drag was running.
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (activePointers.size === 2) {
            abortDrag()
            const rect = surfaceRef?.getBoundingClientRect()
            const mid = pinchMid()
            pinch = {
                dist: pinchDist(),
                scale: scale(),
                panX: pan().x,
                panY: pan().y,
                midX: mid.x - (rect?.left ?? 0),
                midY: mid.y - (rect?.top ?? 0),
            }
            return
        }
        if (activePointers.size > 2) return
        if (e.button !== 0) return
        // A drag calls e.preventDefault(), which would suppress the focused
        // textarea's native blur, so end any active edit explicitly first
        // (its onBlur still runs and saves). This is what lets you click empty
        // space to deselect a just-edited node and then drag it (bug: deselect).
        if (editingId()) {
            ;(document.activeElement as HTMLElement | null)?.blur?.()
            setEditingId(null)
        }
        closeMenus()
        // Clicking empty space cancels a pending click-to-click connection and
        // any queued auto-connect intent.
        connectAfterCreate = null
        if (pendingConnect()) {
            cancelPendingConnect()
            return
        }
        if (tool() === 'select' && props.canManage) {
            setSelection([])
            const w = toWorld(e.clientX, e.clientY)
            startDrag({ kind: 'marquee', startWX: w.x, startWY: w.y }, e)
        } else {
            setSelection([])
            startDrag({ kind: 'pan', startX: e.clientX, startY: e.clientY, panX: pan().x, panY: pan().y }, e)
        }
    }

    const selectNode = (node: CanvasNode, additive: boolean) => {
        setSelection((sel) => {
            if (additive) return sel.includes(node.id) ? sel.filter((i) => i !== node.id) : [...sel, node.id]
            return sel.includes(node.id) ? sel : [node.id]
        })
    }

    const startNodeDrag = (node: CanvasNode, e: PointerEvent) => {
        e.stopPropagation()
        if (!props.canManage) return
        // Completing a click-to-click connection takes priority over dragging.
        const from = pendingConnect()
        if (from) {
            if (from !== node.id) createEdge(from, node.id)
            cancelPendingConnect()
            return
        }
        closeMenus()
        if (e.shiftKey) selectNode(node, true)
        else if (!selection().includes(node.id)) setSelection([node.id])
        const sel = selection()
        if (!sel.includes(node.id)) return
        const origins = new Map<string, Point>()
        for (const id of sel) {
            const node = nodeById(id)
            if (node) origins.set(id, { x: node.x, y: node.y })
        }
        startDrag({ kind: 'node', startX: e.clientX, startY: e.clientY, origins, moved: false }, e)
    }

    const startResize = (node: CanvasNode, e: PointerEvent) => {
        e.stopPropagation()
        startDrag({ kind: 'resize', id: node.id, startX: e.clientX, startY: e.clientY, w0: node.w, h0: node.h }, e)
    }

    const startConnect = (node: CanvasNode, e: PointerEvent) => {
        e.stopPropagation()
        setConnectFrom(node.id)
        setConnectCursor({ x: node.x + node.w / 2, y: node.y + node.h / 2 })
        startDrag({ kind: 'connect', fromId: node.id }, e)
    }

    onMount(() => window.addEventListener('keydown', onKeyDown))

    onCleanup(() => {
        window.removeEventListener('pointermove', onWindowMove)
        window.removeEventListener('pointerup', onWindowUp)
        window.removeEventListener('keydown', onKeyDown)
    })

    // --- node creation / mutation ---

    const addNodeAt = async (kind: CanvasNodeKind, content: string, world: Point, style?: string): Promise<CanvasNode | null> => {
        const canvas = active()
        if (!canvas) return null
        const size = NODE_DEFAULTS[kind] ?? { w: 220, h: 140 }
        // Snapshot + consume the auto-connect source before the await so a second
        // creation in flight can't inherit it.
        const linkFrom = connectAfterCreate
        connectAfterCreate = null
        try {
            const node = await api.createCanvasNode(canvas.id, {
                kind,
                x: Math.round(world.x - size.w / 2),
                y: Math.round(world.y - size.h / 2),
                w: size.w,
                h: size.h,
                content,
                style,
            })
            setCanvasStore('c', 'nodes', produce((nodes) => nodes.push(node)))
            setSelection([node.id])
            if (linkFrom && linkFrom !== node.id) await createEdge(linkFrom, node.id)
            if (kind === 'text' || kind === 'sticky' || kind === 'shape') setEditingId(node.id)
            return node
        } catch (err) {
            console.error('Failed to add node:', err)
            ui.toast('Could not add node.', 'error')
            return null
        }
    }

    // Add helpers accept an optional world point (context menu) and otherwise
    // drop at the viewport centre (toolbar).
    const addText = (at?: Point) => addNodeAt('text', '', at ?? viewCenterWorld())
    const addSticky = (at?: Point) =>
        addNodeAt('sticky', '', at ?? viewCenterWorld(), JSON.stringify({ color: '#f6e58d', fontSize: 14 }))
    const addShape = (at?: Point) => addNodeAt('shape', '', at ?? viewCenterWorld(), JSON.stringify({ color: '#dfe6e9', shape: 'rect' }))
    // window.prompt is unsupported in the Electron shell (and ugly in-browser),
    // so a link uses a proper in-app modal.
    const addLink = (at?: Point) => setLinkPrompt({ world: at ?? viewCenterWorld() })
    const submitLink = async (url: string) => {
        const p = linkPrompt()
        setLinkPrompt(null)
        const clean = url.trim()
        if (!p || !clean) {
            connectAfterCreate = null
            return
        }
        if (p.replaceId) {
            connectAfterCreate = null
            const node = nodeById(p.replaceId)
            if (node) await saveNodeContent(node, withScheme(clean))
        } else {
            // addNodeAt consumes connectAfterCreate for the auto-connect case.
            await addNodeAt('link', withScheme(clean), p.world)
        }
    }
    const addImage = (at?: Point) => {
        pendingImageWorld = at ?? viewCenterWorld()
        fileInputRef?.click()
    }
    const addMomentRef = (at?: Point) => setMomentPicker({ world: at ?? viewCenterWorld() })
    const addTodoRef = (at?: Point) => setTodoPicker({ world: at ?? viewCenterWorld() })

    const onImagePicked = async (e: Event) => {
        const input = e.currentTarget as HTMLInputElement
        const file = input.files?.[0]
        input.value = ''
        const world = pendingImageWorld ?? viewCenterWorld()
        pendingImageWorld = null
        if (!file) return
        try {
            const asset = (await api.uploadAsset(file)) as { id: string }
            await addNodeAt('image', `/api/v1/assets/${asset.id}`, world)
        } catch (err) {
            console.error('Failed to upload image:', err)
            ui.toast('Could not upload image.', 'error')
        }
    }

    const saveNodeContent = async (node: CanvasNode, content: string) => {
        if (content === node.content) return
        patchNode(node.id, { content })
        try {
            await api.updateCanvasNode(node.id, { content })
        } catch (err) {
            console.error('Failed to save node:', err)
            ui.toast('Could not save node.', 'error')
        }
    }

    const saveNodeStyle = async (node: CanvasNode, style: NodeStyle) => {
        const raw = JSON.stringify(style)
        patchNode(node.id, { style: raw })
        try {
            await api.updateCanvasNode(node.id, { style: raw })
        } catch (err) {
            console.error('Failed to style node:', err)
            ui.toast('Could not save node style.', 'error')
        }
    }

    const bringToFront = async (node: CanvasNode) => {
        const maxZ = Math.max(0, ...(active()?.nodes ?? []).map((n) => n.z_order))
        const z = maxZ + 1
        patchNode(node.id, { z_order: z })
        try {
            await api.updateCanvasNode(node.id, { z_order: z })
        } catch (err) {
            console.error('Failed to reorder node:', err)
        }
    }

    const duplicateNode = async (node: CanvasNode) => {
        const canvas = active()
        if (!canvas) return
        try {
            const copy = await api.createCanvasNode(canvas.id, {
                kind: node.kind,
                x: node.x + 24,
                y: node.y + 24,
                w: node.w,
                h: node.h,
                content: node.content,
                style: node.style,
            })
            setCanvasStore('c', 'nodes', produce((nodes) => nodes.push(copy)))
            setSelection([copy.id])
        } catch (err) {
            console.error('Failed to duplicate node:', err)
            ui.toast('Could not duplicate node.', 'error')
        }
    }

    const removeNode = async (node: CanvasNode) => {
        try {
            await api.deleteCanvasNode(node.id)
            // Server cascades edges; mirror that locally.
            setCanvasStore('c', produce((c) => {
                if (!c) return
                c.nodes = c.nodes.filter((n) => n.id !== node.id)
                c.edges = c.edges.filter((ed) => ed.from_node !== node.id && ed.to_node !== node.id)
            }))
            setSelection((sel) => sel.filter((i) => i !== node.id))
        } catch (err) {
            console.error('Failed to delete node:', err)
            ui.toast('Could not delete node.', 'error')
        }
    }

    const deleteSelected = async () => {
        const ids = selection()
        for (const id of ids) {
            const node = nodeById(id)
            if (node) await removeNode(node)
        }
    }

    const editNode = (node: CanvasNode) => {
        closeMenus()
        if (node.kind === 'text' || node.kind === 'sticky' || node.kind === 'shape') {
            setEditingId(node.id)
        } else if (node.kind === 'link') {
            setLinkPrompt({ world: { x: node.x + node.w / 2, y: node.y + node.h / 2 }, replaceId: node.id, initial: node.content })
        } else if (node.kind === 'moment-ref') {
            setMomentPicker({ world: { x: node.x + node.w / 2, y: node.y + node.h / 2 }, replaceId: node.id })
        } else if (node.kind === 'todo-ref') {
            setTodoPicker({ world: { x: node.x + node.w / 2, y: node.y + node.h / 2 }, replaceId: node.id })
        }
    }

    // --- edges ---

    const createEdge = async (fromId: string, toId: string) => {
        const canvas = active()
        if (!canvas) return
        if (canvas.edges.some((ed) => (ed.from_node === fromId && ed.to_node === toId) || (ed.from_node === toId && ed.to_node === fromId)))
            return
        try {
            const edge = await api.createCanvasEdge(canvas.id, fromId, toId)
            setCanvasStore('c', produce((c) => {
                if (c && !c.edges.some((e) => e.id === edge.id)) c.edges.push(edge)
            }))
        } catch (err) {
            console.error('Failed to create edge:', err)
            ui.toast('Could not connect nodes.', 'error')
        }
    }

    const removeEdge = async (edge: CanvasEdge) => {
        try {
            await api.deleteCanvasEdge(edge.id)
            setCanvasStore('c', produce((c) => {
                if (c) c.edges = c.edges.filter((e) => e.id !== edge.id)
            }))
        } catch (err) {
            console.error('Failed to delete edge:', err)
            ui.toast('Could not delete connector.', 'error')
        }
    }

    // --- picker resolution ---

    const chooseMoment = async (moment: Moment) => {
        const p = momentPicker()
        setMomentPicker(null)
        if (!p) return
        if (p.replaceId) {
            const node = nodeById(p.replaceId)
            if (node) await saveNodeContent(node, moment.id)
        } else {
            await addNodeAt('moment-ref', moment.id, p.world)
        }
    }

    const chooseTodo = async (list: TodoList) => {
        const p = todoPicker()
        setTodoPicker(null)
        if (!p) return
        if (p.replaceId) {
            const node = nodeById(p.replaceId)
            if (node) await saveNodeContent(node, list.id)
        } else {
            await addNodeAt('todo-ref', list.id, p.world)
        }
    }

    // --- context menu ---

    const openContextMenu = (e: MouseEvent, nodeId?: string) => {
        if (!props.canManage) return
        e.preventDefault()
        e.stopPropagation()
        setStylePopover(null)
        setContextMenu({ sx: e.clientX, sy: e.clientY, world: toWorld(e.clientX, e.clientY), nodeId })
    }

    // --- keyboard ---

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            closeMenus()
            setMomentPicker(null)
            setTodoPicker(null)
            setLinkPrompt(null)
            setGuideOpen(false)
            setEditingId(null)
            connectAfterCreate = null
            cancelPendingConnect()
            return
        }
        const tag = (document.activeElement?.tagName ?? '').toLowerCase()
        if ((e.key === 'Delete' || e.key === 'Backspace') && props.canManage && tag !== 'textarea' && tag !== 'input') {
            if (selection().length) {
                e.preventDefault()
                deleteSelected()
            }
        }
    }

    return (
        <div
            class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in"
            {...backdropDismiss(props.onClose)}
        >
            <div class="bg-element-matte border-element-accent flex h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-0 shadow-2xl lg:h-[90vh] lg:max-w-6xl lg:rounded-2xl lg:border-4">
                {/* Header */}
                <div class="bg-element border-element-accent flex items-center justify-between rounded-t-2xl border-b p-4">
                    <div class="flex items-center gap-2">
                        {/* Mobile: toggles the canvas-list drawer (the rail is hidden). */}
                        <button onClick={() => setShowList((v) => !v)} class="text-sub hover:text-main transition-colors hover:cursor-pointer lg:hidden" title="Canvases">
                            <span class="material-symbols-outlined">menu</span>
                        </button>
                        <span class="material-symbols-outlined text-highlight text-xl">dashboard</span>
                        <h2 class="text-main text-lg font-bold tracking-widest">CANVAS</h2>
                    </div>
                    <button onClick={props.onClose} class="text-sub hover:text-plain transition-colors">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>

                <div class="relative flex flex-1 overflow-hidden">
                    {/* Mobile scrim behind the canvas-list drawer. */}
                    <Show when={showList() && !isDesktop()}>
                        <div class="absolute inset-0 z-20 bg-black/40 lg:hidden" onClick={() => setShowList(false)} />
                    </Show>
                    {/* Left rail: canvas list. Static column on desktop; a slide-in
                        drawer (toggled from the header) below lg. */}
                    <div
                        class="bg-element border-element-accent flex w-56 shrink-0 flex-col border-r max-lg:absolute max-lg:inset-y-0 max-lg:left-0 max-lg:z-30 max-lg:shadow-2xl max-lg:transition-transform"
                        classList={{ 'max-lg:-translate-x-full': !showList() }}
                    >
                        <div class="flex items-center justify-between p-3">
                            <span class="text-sub text-xs font-bold tracking-widest uppercase">Canvases</span>
                            <Show when={props.canManage}>
                                <button
                                    onClick={newCanvas}
                                    title="New canvas"
                                    class="text-sub hover:text-highlight-strongest hover:cursor-pointer"
                                >
                                    <span class="material-symbols-outlined text-base">add</span>
                                </button>
                            </Show>
                        </div>
                        <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
                            <Show when={!loading()} fallback={<p class="text-sub px-2 text-sm">Loading…</p>}>
                                <Show
                                    when={canvases().length > 0}
                                    fallback={<p class="text-sub/50 px-2 text-xs italic">No canvases yet.</p>}
                                >
                                    <For each={canvases()}>
                                        {(canvas) => (
                                            <div class="group flex items-center gap-1">
                                                <Show
                                                    when={renamingId() === canvas.id}
                                                    fallback={
                                                        <>
                                                            <button
                                                                onClick={() => openCanvas(canvas.id)}
                                                                onDblClick={() => props.canManage && startRename(canvas)}
                                                                class="flex-1 rounded-lg px-2 py-1.5 text-left text-sm font-bold truncate transition-colors"
                                                                classList={{
                                                                    'bg-highlight-strongest text-white': active()?.id === canvas.id,
                                                                    'text-sub hover:bg-element-accent hover:text-main':
                                                                        active()?.id !== canvas.id,
                                                                }}
                                                            >
                                                                {canvas.title}
                                                            </button>
                                                            <Show when={props.canManage}>
                                                                <button
                                                                    onClick={() => startRename(canvas)}
                                                                    title="Rename canvas"
                                                                    class="text-sub hover:text-highlight-strongest shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hover:cursor-pointer"
                                                                >
                                                                    <span class="material-symbols-outlined text-base">edit</span>
                                                                </button>
                                                                <button
                                                                    onClick={() => removeCanvas(canvas)}
                                                                    title="Delete canvas"
                                                                    class="text-sub hover:text-danger shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hover:cursor-pointer"
                                                                >
                                                                    <span class="material-symbols-outlined text-base">delete</span>
                                                                </button>
                                                            </Show>
                                                        </>
                                                    }
                                                >
                                                    <input
                                                        value={renameDraft()}
                                                        ref={(el) => queueMicrotask(() => { el.focus(); el.select() })}
                                                        onInput={(e) => setRenameDraft(e.currentTarget.value)}
                                                        onBlur={() => void commitRename()}
                                                        // stopPropagation because the module has a window-level
                                                        // keydown handler: Escape there closes the whole board.
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') {
                                                                e.preventDefault()
                                                                e.stopPropagation()
                                                                void commitRename()
                                                            } else if (e.key === 'Escape') {
                                                                e.preventDefault()
                                                                e.stopPropagation()
                                                                setRenamingId(null)
                                                            }
                                                        }}
                                                        class="bg-element-matte text-main border-highlight w-full min-w-0 rounded-lg border px-2 py-1.5 text-sm font-bold focus:outline-none"
                                                    />
                                                </Show>
                                            </div>
                                        )}
                                    </For>
                                </Show>
                            </Show>
                        </div>
                    </div>

                    {/* Main area */}
                    <div class="relative flex-1 overflow-hidden">
                        <Show
                            when={active()}
                            fallback={
                                <div class="flex h-full items-center justify-center">
                                    <p class="text-sub/50 text-sm italic">Select or create a canvas to begin.</p>
                                </div>
                            }
                        >
                            {(canvas) => (
                                <>
                                    {/* Toolbar: top-left on desktop; a bottom, horizontally
                                        scrollable bar on mobile so all tools stay reachable. */}
                                    <Show when={props.canManage}>
                                        <div class="bg-element-matte border-element-accent absolute left-3 top-3 z-10 flex items-center gap-1 rounded-lg border p-1 shadow-lg max-lg:left-2 max-lg:right-2 max-lg:top-auto max-lg:bottom-3 max-lg:overflow-x-auto">
                                            <ToolButton icon="notes" label="Add text" onClick={() => addText()} />
                                            <ToolButton icon="sticky_note_2" label="Add sticky note" onClick={() => addSticky()} />
                                            <ToolButton icon="crop_square" label="Add shape" onClick={() => addShape()} />
                                            <ToolButton icon="image" label="Add image" onClick={() => addImage()} />
                                            <ToolButton icon="link" label="Add web link" onClick={() => addLink()} />
                                            <ToolButton icon="bookmark" label="Add moment reference" onClick={() => addMomentRef()} />
                                            <ToolButton icon="checklist" label="Add todo embed" onClick={() => addTodoRef()} />
                                            <div class="bg-element-accent mx-1 h-5 w-px shrink-0" />
                                            <ToolButton
                                                icon={tool() === 'pan' ? 'pan_tool' : 'highlight_alt'}
                                                label={tool() === 'pan' ? 'Tool: pan (click to switch to select)' : 'Tool: select (click to switch to pan)'}
                                                active={tool() === 'select'}
                                                onClick={() => setTool((t) => (t === 'pan' ? 'select' : 'pan'))}
                                            />
                                            <ToolButton
                                                icon="grid_4x4"
                                                label={snap() ? 'Snap to grid: on' : 'Snap to grid: off'}
                                                active={snap()}
                                                onClick={() => setSnap((s) => !s)}
                                            />
                                            <input
                                                ref={fileInputRef}
                                                type="file"
                                                accept="image/*"
                                                class="hidden"
                                                onChange={onImagePicked}
                                            />
                                        </div>
                                    </Show>

                                    {/* Top-right: zoom + help */}
                                    <div class="absolute right-3 top-3 z-10 flex items-center gap-2">
                                        <div class="bg-element-matte border-element-accent text-sub rounded-lg border px-2 py-1 text-xs font-mono">
                                            {Math.round(scale() * 100)}%
                                        </div>
                                        <button
                                            onClick={() => setGuideOpen(true)}
                                            title="Help"
                                            class="bg-element-matte border-element-accent text-sub hover:text-main flex h-7 w-7 items-center justify-center rounded-lg border text-sm font-serif hover:cursor-pointer"
                                        >
                                            ?
                                        </button>
                                    </div>

                                    {/* Pan/zoom surface */}
                                    <div
                                        ref={surfaceRef}
                                        class="bg-element h-full w-full touch-none overflow-hidden"
                                        classList={{ 'cursor-grab': tool() === 'pan', 'cursor-crosshair': tool() === 'select' }}
                                        style={gridStyle()}
                                        onPointerDown={onSurfacePointerDown}
                                        onPointerMove={(e) => {
                                            if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
                                            if (pinch && activePointers.size === 2) {
                                                const rect = surfaceRef?.getBoundingClientRect()
                                                const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinch.scale * (pinchDist() / pinch.dist)))
                                                // World point under the initial midpoint, held under the
                                                // current midpoint so two-finger pan comes along for free.
                                                const worldX = (pinch.midX - pinch.panX) / pinch.scale
                                                const worldY = (pinch.midY - pinch.panY) / pinch.scale
                                                const mid = pinchMid()
                                                const cx = mid.x - (rect?.left ?? 0)
                                                const cy = mid.y - (rect?.top ?? 0)
                                                setScale(next)
                                                setPan({ x: cx - worldX * next, y: cy - worldY * next })
                                                return
                                            }
                                            if (pendingConnect()) setConnectCursor(toWorld(e.clientX, e.clientY))
                                        }}
                                        onPointerUp={(e) => {
                                            activePointers.delete(e.pointerId)
                                            if (activePointers.size < 2) pinch = null
                                        }}
                                        onPointerCancel={(e) => {
                                            activePointers.delete(e.pointerId)
                                            if (activePointers.size < 2) pinch = null
                                        }}
                                        onContextMenu={(e) => openContextMenu(e)}
                                        onWheel={handleWheel}
                                    >
                                        {/* Inner transformed layer */}
                                        <div
                                            class="absolute left-0 top-0 origin-top-left"
                                            style={{
                                                transform: `translate(${pan().x}px, ${pan().y}px) scale(${scale()})`,
                                            }}
                                        >
                                            {/* Edges (below nodes) */}
                                            <svg
                                                class="pointer-events-none absolute left-0 top-0 overflow-visible"
                                                style={{ width: '1px', height: '1px' }}
                                            >
                                                <defs>
                                                    <marker
                                                        id="canvas-arrow"
                                                        viewBox="0 0 10 10"
                                                        refX="9"
                                                        refY="5"
                                                        markerWidth="7"
                                                        markerHeight="7"
                                                        orient="auto-start-reverse"
                                                    >
                                                        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" class="text-sub" />
                                                    </marker>
                                                </defs>
                                                <For each={canvas().edges}>
                                                    {(edge) => {
                                                        const from = () => nodeById(edge.from_node)
                                                        const to = () => nodeById(edge.to_node)
                                                        const x1 = () => { const f = from(); return f ? f.x + f.w / 2 : 0 }
                                                        const y1 = () => { const f = from(); return f ? f.y + f.h / 2 : 0 }
                                                        const x2 = () => { const t = to(); return t ? t.x + t.w / 2 : 0 }
                                                        const y2 = () => { const t = to(); return t ? t.y + t.h / 2 : 0 }
                                                        return (
                                                            <Show when={from() && to()}>
                                                                <g>
                                                                    <line
                                                                        x1={x1()}
                                                                        y1={y1()}
                                                                        x2={x2()}
                                                                        y2={y2()}
                                                                        class="text-sub"
                                                                        stroke="currentColor"
                                                                        stroke-width="2"
                                                                        marker-end="url(#canvas-arrow)"
                                                                    />
                                                                    <Show when={props.canManage}>
                                                                        <line
                                                                            x1={x1()}
                                                                            y1={y1()}
                                                                            x2={x2()}
                                                                            y2={y2()}
                                                                            stroke="transparent"
                                                                            stroke-width="14"
                                                                            style={{ 'pointer-events': 'stroke', cursor: 'pointer' }}
                                                                            onPointerDown={(e) => e.stopPropagation()}
                                                                            onClick={() => removeEdge(edge)}
                                                                        >
                                                                            <title>Click to remove connector</title>
                                                                        </line>
                                                                    </Show>
                                                                </g>
                                                            </Show>
                                                        )
                                                    }}
                                                </For>
                                                {/* Temp connect line */}
                                                <Show when={connectFrom() && connectCursor()}>
                                                    <line
                                                        x1={(() => { const id = connectFrom(); const f = id ? nodeById(id) : undefined; return f ? f.x + f.w / 2 : 0 })()}
                                                        y1={(() => { const id = connectFrom(); const f = id ? nodeById(id) : undefined; return f ? f.y + f.h / 2 : 0 })()}
                                                        x2={connectCursor()?.x ?? 0}
                                                        y2={connectCursor()?.y ?? 0}
                                                        class="text-highlight-strongest"
                                                        stroke="currentColor"
                                                        stroke-width="2"
                                                        stroke-dasharray="6 4"
                                                    />
                                                </Show>
                                            </svg>

                                            <For each={sortedNodes()}>
                                                {(node) => (
                                                    <NodeView
                                                        node={node}
                                                        canManage={props.canManage}
                                                        selected={selection().includes(node.id)}
                                                        editing={editingId() === node.id}
                                                        pendingConnect={!!pendingConnect()}
                                                        onSelect={(additive) => {
                                                            const from = pendingConnect()
                                                            if (from) {
                                                                if (from !== node.id) createEdge(from, node.id)
                                                                cancelPendingConnect()
                                                                return
                                                            }
                                                            selectNode(node, additive)
                                                        }}
                                                        onDragStart={(e) => startNodeDrag(node, e)}
                                                        onResizeStart={(e) => startResize(node, e)}
                                                        onConnectStart={(e) => startConnect(node, e)}
                                                        onContextMenu={(e) => openContextMenu(e, node.id)}
                                                        onSaveContent={(c) => saveNodeContent(node, c)}
                                                        onEditDone={() => setEditingId(null)}
                                                        onRequestEdit={() => editNode(node)}
                                                        onOpenStyle={(sx, sy) => setStylePopover({ nodeId: node.id, sx, sy })}
                                                        onRemove={() => removeNode(node)}
                                                        onOpenMoment={props.onOpenMoment}
                                                        onLongPress={(e) => openContextMenu(e, node.id)}
                                                    />
                                                )}
                                            </For>

                                            {/* Marquee box */}
                                            <Show when={marquee()}>
                                                {(m) => (
                                                    <div
                                                        class="border-highlight-strongest bg-highlight-strongest/10 pointer-events-none absolute border"
                                                        style={{
                                                            left: `${m().x}px`,
                                                            top: `${m().y}px`,
                                                            width: `${m().w}px`,
                                                            height: `${m().h}px`,
                                                        }}
                                                    />
                                                )}
                                            </Show>
                                        </div>
                                    </div>

                                    {/* Context menu */}
                                    <Show when={contextMenu()}>
                                        {(menu) => (
                                            <CanvasContextMenu
                                                menu={menu()}
                                                onClose={closeMenus}
                                                onAdd={(kind) => {
                                                    const at = menu().world
                                                    const from = menu().connectFrom
                                                    closeMenus()
                                                    // Queue the auto-connect; addNodeAt consumes it (works for
                                                    // async picker-based kinds too, cleared if they're cancelled).
                                                    if (from) connectAfterCreate = from
                                                    if (kind === 'text') addText(at)
                                                    else if (kind === 'sticky') addSticky(at)
                                                    else if (kind === 'shape') addShape(at)
                                                    else if (kind === 'image') addImage(at)
                                                    else if (kind === 'link') addLink(at)
                                                    else if (kind === 'moment-ref') addMomentRef(at)
                                                    else if (kind === 'todo-ref') addTodoRef(at)
                                                }}
                                                node={menu().nodeId ? nodeById(menu().nodeId!) : undefined}
                                                onDuplicate={(n) => {
                                                    closeMenus()
                                                    duplicateNode(n)
                                                }}
                                                onBringToFront={(n) => {
                                                    closeMenus()
                                                    bringToFront(n)
                                                }}
                                                onEdit={(n) => editNode(n)}
                                                onStyle={(n) => setStylePopover({ nodeId: n.id, sx: menu().sx, sy: menu().sy })}
                                                onConnect={(n) => {
                                                    closeMenus()
                                                    setPendingConnect(n.id)
                                                    setConnectFrom(n.id)
                                                    setConnectCursor({ x: n.x + n.w / 2, y: n.y + n.h / 2 })
                                                    ui.toast('Click another node to connect. Press Esc or click empty space to cancel.', 'info')
                                                }}
                                                onDelete={(n) => {
                                                    closeMenus()
                                                    removeNode(n)
                                                }}
                                            />
                                        )}
                                    </Show>

                                    {/* Style popover */}
                                    <Show when={stylePopover()}>
                                        {(sp) => {
                                            const node = () => nodeById(sp().nodeId)
                                            return (
                                                <Show when={node()}>
                                                    {(n) => (
                                                        <StylePopover
                                                            node={n()}
                                                            sx={sp().sx}
                                                            sy={sp().sy}
                                                            onChange={(style) => saveNodeStyle(n(), style)}
                                                            onClose={() => setStylePopover(null)}
                                                        />
                                                    )}
                                                </Show>
                                            )
                                        }}
                                    </Show>

                                    {/* Moment picker */}
                                    <Show when={momentPicker()}>
                                        <MomentPicker onPick={chooseMoment} onClose={() => { setMomentPicker(null); connectAfterCreate = null }} />
                                    </Show>

                                    {/* Todo picker */}
                                    <Show when={todoPicker()}>
                                        <TodoPicker onPick={chooseTodo} onClose={() => { setTodoPicker(null); connectAfterCreate = null }} />
                                    </Show>

                                    {/* Web-link prompt (in-app, replaces window.prompt) */}
                                    <Show when={linkPrompt()}>
                                        {(lp) => (
                                            <LinkPrompt
                                                initial={lp().initial ?? ''}
                                                onSubmit={submitLink}
                                                onClose={() => { setLinkPrompt(null); connectAfterCreate = null }}
                                            />
                                        )}
                                    </Show>

                                    {/* Guide */}
                                    <Show when={guideOpen()}>
                                        <GuideOverlay onClose={() => setGuideOpen(false)} />
                                    </Show>
                                </>
                            )}
                        </Show>
                    </div>
                </div>
            </div>
        </div>
    )
}

// --- toolbar button ---

const ToolButton: Component<{ icon: string; label: string; onClick: () => void; active?: boolean }> = (props) => (
    <button
        onClick={props.onClick}
        title={props.label}
        class="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors hover:cursor-pointer"
        classList={{
            'bg-highlight-strongest text-white': props.active,
            'text-sub hover:bg-element-accent hover:text-main': !props.active,
        }}
    >
        <span class="material-symbols-outlined text-base">{props.icon}</span>
    </button>
)

// --- node rendering ---

interface NodeViewProps {
    node: CanvasNode
    canManage: boolean
    selected: boolean
    editing: boolean
    pendingConnect: boolean
    onSelect: (additive: boolean) => void
    onDragStart: (e: PointerEvent) => void
    onResizeStart: (e: PointerEvent) => void
    onConnectStart: (e: PointerEvent) => void
    onContextMenu: (e: MouseEvent) => void
    onSaveContent: (content: string) => void
    onEditDone: () => void
    onRequestEdit: () => void
    onOpenStyle: (sx: number, sy: number) => void
    onRemove: () => void
    onOpenMoment?: (id: string) => void
    // Long-press (touch) → open this node's context menu.
    onLongPress?: (e: PointerEvent) => void
}

// Fillable SVG for a shape node. preserveAspectRatio=none lets the
// shape stretch to the node's current width/height.
const ShapeSvg: Component<{ w: number; h: number; kind: ShapeKind; fill: string; stroke: string }> = (p) => (
    <svg class="absolute inset-0 h-full w-full" viewBox={`0 0 ${p.w} ${p.h}`} preserveAspectRatio="none">
        <Switch fallback={<rect x="1" y="1" width={p.w - 2} height={p.h - 2} fill={p.fill} stroke={p.stroke} stroke-width="1.5" />}>
            <Match when={p.kind === 'round'}>
                <rect x="1" y="1" width={p.w - 2} height={p.h - 2} rx="16" ry="16" fill={p.fill} stroke={p.stroke} stroke-width="1.5" />
            </Match>
            <Match when={p.kind === 'ellipse'}>
                <ellipse cx={p.w / 2} cy={p.h / 2} rx={(p.w - 2) / 2} ry={(p.h - 2) / 2} fill={p.fill} stroke={p.stroke} stroke-width="1.5" />
            </Match>
            <Match when={p.kind === 'diamond'}>
                <polygon points={`${p.w / 2},1 ${p.w - 1},${p.h / 2} ${p.w / 2},${p.h - 1} 1,${p.h / 2}`} fill={p.fill} stroke={p.stroke} stroke-width="1.5" />
            </Match>
            <Match when={p.kind === 'triangle'}>
                <polygon points={`${p.w / 2},1 ${p.w - 1},${p.h - 1} 1,${p.h - 1}`} fill={p.fill} stroke={p.stroke} stroke-width="1.5" />
            </Match>
        </Switch>
    </svg>
)

const NodeView: Component<NodeViewProps> = (props) => {
    const style = () => parseStyle(props.node.style)
    let textRef: HTMLTextAreaElement | undefined
    let styleBtnRef: HTMLButtonElement | undefined
    // Touch: a stationary hold opens the node's actions (desktop uses right-click
    // / hover). Movement cancels it, so dragging a node still works.
    const lp = createLongPress((e) => props.onLongPress?.(e))

    createEffect(() => {
        if (props.editing && textRef) {
            textRef.focus()
            textRef.select()
        }
    })

    const isShape = () => props.node.kind === 'shape'
    const isTextual = () => props.node.kind === 'text' || props.node.kind === 'sticky' || props.node.kind === 'shape'
    // A plain "text" node is a bare label on the board with no card chrome, unless
    // the user gives it a background colour. A sticky is always a coloured card.
    // (This is the difference between the two: text = annotation, sticky = note.)
    const isPlainText = () => props.node.kind === 'text' && !style().color
    // The saved colour is the shape fill (SVG) for shapes, otherwise the node
    // background. fg is the on-colour text colour.
    const bg = () => (isShape() ? undefined : style().color || undefined)
    const fg = () => (style().color ? '#1c1c1c' : undefined)
    const fontSize = () => `${style().fontSize ?? 14}px`

    // Connector dots just outside each edge; revealed on hover / when selected.
    const dotBase =
        'absolute z-10 h-3 w-3 rounded-full bg-highlight-strongest border border-white/70 opacity-0 group-hover:opacity-100 hover:cursor-crosshair transition-opacity'
    const dotPositions = ['-top-2 left-1/2 -translate-x-1/2', '-right-2 top-1/2 -translate-y-1/2', '-bottom-2 left-1/2 -translate-x-1/2', '-left-2 top-1/2 -translate-y-1/2']

    return (
        <div
            class="group absolute"
            classList={{
                'rounded-lg border shadow-lg overflow-hidden': !isShape() && !isPlainText(),
                'rounded-lg': isPlainText(),
                'ring-2 ring-highlight-strongest': props.selected,
                'border-highlight-strongest': props.selected && !isShape() && !isPlainText(),
                'border-element-accent': !props.selected && !isShape() && !isPlainText(),
                'bg-element-matte': !bg() && !isShape() && !isPlainText(),
                'cursor-crosshair': props.pendingConnect,
                'cursor-move': props.canManage && !props.pendingConnect && !props.editing,
            }}
            style={{
                left: `${props.node.x}px`,
                top: `${props.node.y}px`,
                width: `${props.node.w}px`,
                height: `${props.node.h}px`,
                ...(bg() ? { background: bg() } : {}),
            }}
            // Drag anywhere on the node. Inner interactive elements
            // (textarea, links, buttons) stop propagation so they don't drag.
            onPointerDown={(e) => {
                lp.handlers.onPointerDown(e)
                if (props.canManage) props.onDragStart(e)
            }}
            onPointerMove={lp.handlers.onPointerMove}
            onPointerUp={lp.handlers.onPointerUp}
            onPointerCancel={lp.handlers.onPointerCancel}
            onDblClick={() => props.canManage && props.onRequestEdit()}
            onContextMenu={props.onContextMenu}
        >
            {/* Shape fill sits behind everything else. */}
            <Show when={isShape()}>
                <ShapeSvg w={props.node.w} h={props.node.h} kind={style().shape ?? 'rect'} fill={style().color || '#dfe6e9'} stroke="rgba(0,0,0,0.28)" />
            </Show>

            {/* Floating actions (style / delete), revealed on hover. */}
            <Show when={props.canManage}>
                <div class="absolute right-1 top-1 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                        ref={styleBtnRef}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => {
                            const r = styleBtnRef?.getBoundingClientRect()
                            props.onOpenStyle(r?.left ?? 0, (r?.bottom ?? 0) + 4)
                        }}
                        title="Style"
                        class="bg-element/80 text-sub hover:text-main rounded p-0.5 hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined text-sm">palette</span>
                    </button>
                    <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={props.onRemove}
                        title="Delete node"
                        class="bg-element/80 text-sub hover:text-danger rounded p-0.5 hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined text-sm">close</span>
                    </button>
                </div>
            </Show>

            {/* Body by kind */}
            <div class="relative h-full w-full" style={fg() ? { color: fg() } : {}}>
                <Show when={isTextual()}>
                    <Show
                        when={props.editing}
                        fallback={
                            <div
                                class="h-full w-full overflow-hidden break-words whitespace-pre-wrap p-2"
                                classList={{
                                    'text-main': !fg(),
                                    'flex items-center justify-center text-center': isShape(),
                                    'opacity-50': !props.node.content,
                                }}
                                style={{ 'font-size': fontSize(), ...(fg() ? { color: fg() } : {}) }}
                            >
                                {props.node.content || (isShape() ? 'Label…' : props.node.kind === 'sticky' ? 'Note…' : 'Text…')}
                            </div>
                        }
                    >
                        <textarea
                            ref={textRef}
                            value={props.node.content}
                            disabled={!props.canManage}
                            onPointerDown={(e) => e.stopPropagation()}
                            onDblClick={(e) => e.stopPropagation()}
                            onBlur={(e) => {
                                props.onEditDone()
                                if (props.canManage) props.onSaveContent(e.currentTarget.value)
                            }}
                            placeholder={isShape() ? 'Label…' : props.node.kind === 'sticky' ? 'Note…' : 'Text…'}
                            class="h-full w-full resize-none bg-transparent p-2 focus:outline-none disabled:opacity-90"
                            classList={{ 'text-main': !fg(), 'text-center': isShape() }}
                            style={{ 'font-size': fontSize(), ...(fg() ? { color: fg() } : {}) }}
                        />
                    </Show>
                </Show>

                <Show when={props.node.kind === 'image'}>
                    <img src={props.node.content} alt="" class="h-full w-full object-cover" draggable={false} />
                </Show>

                <Show when={props.node.kind === 'link'}>
                    <LinkChip url={props.node.content} />
                </Show>

                <Show when={props.node.kind === 'moment-ref'}>
                    <MomentRefCard uuid={props.node.content} onOpen={props.onOpenMoment} />
                </Show>

                <Show when={props.node.kind === 'todo-ref'}>
                    <TodoRefCard listId={props.node.content} />
                </Show>
            </div>

            {/* Edge connector dots + resize handle. */}
            <Show when={props.canManage}>
                <For each={dotPositions}>
                    {(pos) => (
                        <button
                            title="Drag to connect to another node"
                            onPointerDown={props.onConnectStart}
                            class={`${dotBase} ${pos}`}
                            classList={{ 'opacity-100': props.selected }}
                        />
                    )}
                </For>
                <div
                    title="Resize"
                    onPointerDown={props.onResizeStart}
                    class="absolute bottom-0 right-0 z-10 h-3 w-3 cursor-nwse-resize"
                    style={{ background: 'linear-gradient(135deg, transparent 50%, var(--color-sub, #888) 50%)' }}
                />
            </Show>
        </div>
    )
}

// --- link chip ---

const LinkChip: Component<{ url: string }> = (props) => {
    const host = () => {
        try {
            return new URL(props.url).host
        } catch {
            return props.url
        }
    }
    return (
        <a
            href={props.url}
            target="_blank"
            rel="noopener noreferrer"
            onPointerDown={(e) => e.stopPropagation()}
            class="hover:bg-element flex h-full w-full items-center gap-2 p-3 text-left transition-colors"
        >
            <span class="material-symbols-outlined text-highlight text-base">link</span>
            <span class="text-main truncate text-sm font-bold">{host()}</span>
        </a>
    )
}

// --- moment-ref card ---

const MomentRefCard: Component<{ uuid: string; onOpen?: (id: string) => void }> = (props) => {
    const [moment, setMoment] = createSignal<Moment | null>(null)
    const [failed, setFailed] = createSignal(false)
    const [loading, setLoading] = createSignal(true)

    createEffect(() => {
        const uuid = props.uuid
        const cached = momentRefCache.get(uuid)
        if (cached) {
            setMoment(cached)
            setFailed(false)
            setLoading(false)
            return
        }
        setLoading(true)
        setFailed(false)
        api.getMoment(uuid)
            .then((m) => {
                momentRefCache.set(uuid, m)
                setMoment(m)
            })
            .catch(() => setFailed(true))
            .finally(() => setLoading(false))
    })

    return (
        <Show
            when={!failed()}
            fallback={
                <div class="flex h-full flex-col items-center justify-center gap-1 p-3 text-center">
                    <span class="material-symbols-outlined text-sub text-xl">broken_image</span>
                    <span class="text-sub text-xs italic">Deleted moment</span>
                </div>
            }
        >
            <Show when={!loading()} fallback={<p class="text-sub p-3 text-xs">Loading…</p>}>
                <Show when={moment()}>
                    {(m) => (
                        <button
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => props.onOpen?.(m().id)}
                            class="hover:bg-element flex h-full w-full flex-col gap-1 p-3 text-left transition-colors hover:cursor-pointer"
                        >
                            {/* w-full: Chromium 130 (Electron 33) does not stretch a column-flex
                                <button>'s children, so truncate has nothing finite to clip
                                against unless the width is explicit. */}
                            <div class="flex w-full min-w-0 items-center gap-1">
                                <span class="material-symbols-outlined text-highlight text-sm">bookmark</span>
                                <span class="text-main min-w-0 truncate text-sm font-bold">{m().title || 'Untitled'}</span>
                            </div>
                            <p class="text-sub w-full min-w-0 line-clamp-3 text-xs leading-snug">{m().content}</p>
                        </button>
                    )}
                </Show>
            </Show>
        </Show>
    )
}

// --- todo-ref card ---

const TodoRefCard: Component<{ listId: string }> = (props) => {
    const [list, setList] = createSignal<TodoList | null>(null)
    const [failed, setFailed] = createSignal(false)
    const [loading, setLoading] = createSignal(true)

    createEffect(() => {
        const id = props.listId
        const cached = todoRefCache.get(id)
        if (cached) {
            setList(cached)
            setFailed(false)
            setLoading(false)
            return
        }
        setLoading(true)
        setFailed(false)
        api.getTodoList(id)
            .then((l) => {
                if (l) {
                    todoRefCache.set(id, l)
                    setList(l)
                } else {
                    setFailed(true)
                }
            })
            .catch(() => setFailed(true))
            .finally(() => setLoading(false))
    })

    const done = () => list()?.items.filter((i) => i.done).length ?? 0
    const total = () => list()?.items.length ?? 0
    const pct = () => (total() ? Math.round((done() / total()) * 100) : 0)

    return (
        <Show
            when={!failed()}
            fallback={
                <div class="flex h-full flex-col items-center justify-center gap-1 p-3 text-center">
                    <span class="material-symbols-outlined text-sub text-xl">playlist_remove</span>
                    <span class="text-sub text-xs italic">Deleted list</span>
                </div>
            }
        >
            <Show when={!loading()} fallback={<p class="text-sub p-3 text-xs">Loading…</p>}>
                <Show when={list()}>
                    {(l) => (
                        <div class="flex h-full w-full flex-col gap-2 p-3">
                            <div class="flex items-center gap-1">
                                <span class="material-symbols-outlined text-highlight text-sm">checklist</span>
                                <span class="text-main text-sm font-bold truncate">{l().title || 'Untitled list'}</span>
                            </div>
                            <div class="text-sub text-xs">
                                {done()} / {total()} done
                            </div>
                            <div class="bg-element-accent h-1.5 w-full overflow-hidden rounded-full">
                                <div class="bg-highlight-strongest h-full rounded-full" style={{ width: `${pct()}%` }} />
                            </div>
                        </div>
                    )}
                </Show>
            </Show>
        </Show>
    )
}

// --- context menu ---

interface ContextMenuData {
    sx: number
    sy: number
    world: Point
    nodeId?: string
    connectFrom?: string
}

const CanvasContextMenu: Component<{
    menu: ContextMenuData
    node?: CanvasNode
    onClose: () => void
    onAdd: (kind: CanvasNodeKind) => void
    onDuplicate: (n: CanvasNode) => void
    onBringToFront: (n: CanvasNode) => void
    onEdit: (n: CanvasNode) => void
    onStyle: (n: CanvasNode) => void
    onConnect: (n: CanvasNode) => void
    onDelete: (n: CanvasNode) => void
}> = (props) => {
    // Portal to <body>: the canvas panel is .bg-element-matte, whose
    // backdrop-filter (Looks system) makes it the containing block for
    // position:fixed, which otherwise threw this menu far off-screen.
    return (
        <Portal>
            {/* Click-away backdrop */}
            <div class="fixed inset-0 z-[60]" onPointerDown={props.onClose} onContextMenu={(e) => e.preventDefault()} />
            <div
                class="bg-element-matte border-element-accent fixed z-[61] min-w-44 rounded-lg border py-1 text-sm shadow-2xl"
                style={{ left: `${Math.min(props.menu.sx, window.innerWidth - 190)}px`, top: `${Math.min(props.menu.sy, window.innerHeight - 320)}px` }}
                onPointerDown={(e) => e.stopPropagation()}
            >
                <Show
                    when={props.node}
                    fallback={
                        <>
                            <MenuHeader>{props.menu.connectFrom ? 'Connect a new node' : 'Add node'}</MenuHeader>
                            <MenuItem icon="notes" label="Text" onClick={() => props.onAdd('text')} />
                            <MenuItem icon="sticky_note_2" label="Sticky note" onClick={() => props.onAdd('sticky')} />
                            <MenuItem icon="crop_square" label="Shape" onClick={() => props.onAdd('shape')} />
                            <MenuItem icon="image" label="Image" onClick={() => props.onAdd('image')} />
                            <MenuItem icon="link" label="Web link" onClick={() => props.onAdd('link')} />
                            <MenuItem icon="bookmark" label="Moment reference" onClick={() => props.onAdd('moment-ref')} />
                            <MenuItem icon="checklist" label="Todo embed" onClick={() => props.onAdd('todo-ref')} />
                        </>
                    }
                >
                    {(n) => (
                        <>
                            <MenuItem icon="edit" label="Edit" onClick={() => props.onEdit(n())} />
                            <MenuItem icon="palette" label="Style…" onClick={() => props.onStyle(n())} />
                            <MenuItem icon="content_copy" label="Duplicate" onClick={() => props.onDuplicate(n())} />
                            <MenuItem icon="flip_to_front" label="Bring to front" onClick={() => props.onBringToFront(n())} />
                            <MenuItem icon="conversion_path" label="Connect to…" onClick={() => props.onConnect(n())} />
                            <div class="bg-element-accent my-1 h-px" />
                            <MenuItem icon="delete" label="Delete" danger onClick={() => props.onDelete(n())} />
                        </>
                    )}
                </Show>
            </div>
        </Portal>
    )
}

const MenuHeader: Component<{ children: any }> = (props) => (
    <div class="text-sub/70 px-3 pb-1 pt-1 text-[10px] font-bold uppercase tracking-widest">{props.children}</div>
)

const MenuItem: Component<{ icon: string; label: string; onClick: () => void; danger?: boolean }> = (props) => (
    <button
        onClick={props.onClick}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:cursor-pointer"
        classList={{
            'text-danger hover:bg-danger/10': props.danger,
            'text-sub hover:bg-element-accent hover:text-main': !props.danger,
        }}
    >
        <span class="material-symbols-outlined text-base">{props.icon}</span>
        <span>{props.label}</span>
    </button>
)

// --- style popover ---

const StylePopover: Component<{
    node: CanvasNode
    sx: number
    sy: number
    onChange: (style: NodeStyle) => void
    onClose: () => void
}> = (props) => {
    const current = () => parseStyle(props.node.style)
    const supportsFont = () => props.node.kind === 'text' || props.node.kind === 'sticky' || props.node.kind === 'shape'
    // Portal to <body> so the panel's backdrop-filter containing block can't
    // offset this fixed popover off-screen (same fix as the context menu).
    return (
        <Portal>
            <div class="fixed inset-0 z-[60]" onPointerDown={props.onClose} />
            <div
                class="bg-element-matte border-element-accent fixed z-[61] w-56 rounded-lg border p-3 shadow-2xl"
                style={{ left: `${Math.min(props.sx, window.innerWidth - 240)}px`, top: `${Math.min(props.sy, window.innerHeight - 260)}px` }}
                onPointerDown={(e) => e.stopPropagation()}
            >
                <p class="text-sub mb-2 text-[10px] font-bold uppercase tracking-widest">Background</p>
                <div class="flex flex-wrap gap-1.5">
                    <button
                        title="None"
                        onClick={() => props.onChange({ ...current(), color: undefined })}
                        class="border-element-accent flex h-6 w-6 items-center justify-center rounded-md border hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined text-sub text-sm">format_color_reset</span>
                    </button>
                    <For each={NODE_COLORS}>
                        {(color) => (
                            <button
                                onClick={() => props.onChange({ ...current(), color })}
                                class="h-6 w-6 rounded-md border hover:cursor-pointer"
                                classList={{
                                    'border-highlight-strongest ring-1 ring-highlight-strongest': current().color === color,
                                    'border-element-accent': current().color !== color,
                                }}
                                style={{ background: color }}
                            />
                        )}
                    </For>
                </div>
                <Show when={props.node.kind === 'shape'}>
                    <p class="text-sub mb-2 mt-3 text-[10px] font-bold uppercase tracking-widest">Shape</p>
                    <div class="flex flex-wrap gap-1.5">
                        <For each={SHAPES}>
                            {(s) => (
                                <button
                                    title={s.label}
                                    onClick={() => props.onChange({ ...current(), shape: s.kind })}
                                    class="flex h-7 w-7 items-center justify-center rounded-md border hover:cursor-pointer"
                                    classList={{
                                        'border-highlight-strongest ring-1 ring-highlight-strongest': (current().shape ?? 'rect') === s.kind,
                                        'border-element-accent': (current().shape ?? 'rect') !== s.kind,
                                    }}
                                >
                                    <span class="material-symbols-outlined text-sub text-sm">{s.icon}</span>
                                </button>
                            )}
                        </For>
                    </div>
                </Show>

                <Show when={supportsFont()}>
                    <p class="text-sub mb-2 mt-3 text-[10px] font-bold uppercase tracking-widest">
                        Font size: {current().fontSize ?? 14}px
                    </p>
                    <input
                        type="range"
                        min="10"
                        max="32"
                        value={current().fontSize ?? 14}
                        onInput={(e) => props.onChange({ ...current(), fontSize: Number(e.currentTarget.value) })}
                        class="w-full"
                    />
                </Show>
            </div>
        </Portal>
    )
}

// --- link prompt ---

const LinkPrompt: Component<{ initial: string; onSubmit: (url: string) => void; onClose: () => void }> = (props) => {
    const [url, setUrl] = createSignal(props.initial)
    const submit = () => {
        const value = url().trim()
        if (value) props.onSubmit(value)
    }
    return (
        <PickerShell title="Web link" onClose={props.onClose}>
            <input
                autofocus
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') submit()
                }}
                placeholder="example.com or https://…"
                class="bg-element border-element-accent text-main mb-3 w-full rounded-md border px-3 py-2 text-sm focus:outline-none"
            />
            <div class="flex justify-end gap-2">
                <button onClick={props.onClose} class="text-sub hover:text-main rounded-md px-3 py-1.5 text-sm hover:cursor-pointer">
                    Cancel
                </button>
                <button
                    onClick={submit}
                    disabled={!url().trim()}
                    class="bg-highlight-strongest rounded-md px-3 py-1.5 text-sm text-white transition-[filter] hover:brightness-110 disabled:opacity-50 hover:cursor-pointer"
                >
                    Add link
                </button>
            </div>
        </PickerShell>
    )
}

// --- moment picker ---

const MomentPicker: Component<{ onPick: (m: Moment) => void; onClose: () => void }> = (props) => {
    const [query, setQuery] = createSignal('')
    const [moments, setMoments] = createSignal<Moment[]>([])
    const [loading, setLoading] = createSignal(true)

    onMount(async () => {
        try {
            const data = await api.listMoments({ limit: 100 })
            setMoments(data ?? [])
        } catch {
            setMoments([])
        } finally {
            setLoading(false)
        }
    })

    const filtered = () => {
        const q = query().trim().toLowerCase()
        if (!q) return moments()
        return moments().filter((m) => (m.title || '').toLowerCase().includes(q) || (m.content || '').toLowerCase().includes(q))
    }

    const nav = createListboxNav(filtered, (m) => props.onPick(m), props.onClose)

    return (
        <PickerShell title="Reference a moment" onClose={props.onClose}>
            <input
                autofocus
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={nav.onKeyDown}
                placeholder="Search moments by title…"
                class="bg-element border-element-accent text-main mb-2 w-full rounded-md border px-3 py-2 text-sm focus:outline-none"
            />
            <div ref={nav.setListRef} class="max-h-72 overflow-y-auto">
                <Show when={!loading()} fallback={<p class="text-sub p-2 text-sm">Loading…</p>}>
                    <Show when={filtered().length > 0} fallback={<p class="text-sub/60 p-2 text-sm italic">No matches.</p>}>
                        <For each={filtered()}>
                            {(m, index) => (
                                <button
                                    onClick={() => props.onPick(m)}
                                    onMouseMove={() => nav.setActive(index())}
                                    class="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:cursor-pointer"
                                    classList={{
                                        'bg-element-accent': nav.active() === index(),
                                        'hover:bg-element-accent': nav.active() !== index(),
                                    }}
                                >
                                    {/* w-full: Chromium 130 (Electron 33) does not stretch a
                                        column-flex <button>'s children, so truncate has nothing
                                        finite to clip against unless the width is explicit. */}
                                    <span class="text-main w-full min-w-0 truncate text-sm font-bold">{m.title || 'Untitled'}</span>
                                    <span class="text-sub w-full min-w-0 line-clamp-1 text-xs">{m.content}</span>
                                </button>
                            )}
                        </For>
                    </Show>
                </Show>
            </div>
        </PickerShell>
    )
}

// --- todo picker ---

const TodoPicker: Component<{ onPick: (l: TodoList) => void; onClose: () => void }> = (props) => {
    const [query, setQuery] = createSignal('')
    const [lists, setLists] = createSignal<TodoList[]>([])
    const [loading, setLoading] = createSignal(true)

    onMount(async () => {
        try {
            const data = await api.listTodos()
            setLists(data ?? [])
        } catch {
            setLists([])
        } finally {
            setLoading(false)
        }
    })

    const filtered = () => {
        const q = query().trim().toLowerCase()
        if (!q) return lists()
        return lists().filter((l) => (l.title || '').toLowerCase().includes(q))
    }

    const nav = createListboxNav(filtered, (l) => props.onPick(l), props.onClose)

    return (
        <PickerShell title="Embed a todo list" onClose={props.onClose}>
            <input
                autofocus
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={nav.onKeyDown}
                placeholder="Search lists by title…"
                class="bg-element border-element-accent text-main mb-2 w-full rounded-md border px-3 py-2 text-sm focus:outline-none"
            />
            <div ref={nav.setListRef} class="max-h-72 overflow-y-auto">
                <Show when={!loading()} fallback={<p class="text-sub p-2 text-sm">Loading…</p>}>
                    <Show when={filtered().length > 0} fallback={<p class="text-sub/60 p-2 text-sm italic">No lists.</p>}>
                        <For each={filtered()}>
                            {(l, index) => (
                                <button
                                    onClick={() => props.onPick(l)}
                                    onMouseMove={() => nav.setActive(index())}
                                    class="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left transition-colors hover:cursor-pointer"
                                    classList={{
                                        'bg-element-accent': nav.active() === index(),
                                        'hover:bg-element-accent': nav.active() !== index(),
                                    }}
                                >
                                    <span class="text-main text-sm font-bold truncate">{l.title || 'Untitled list'}</span>
                                    <span class="text-sub shrink-0 text-xs">{l.items.length} items</span>
                                </button>
                            )}
                        </For>
                    </Show>
                </Show>
            </div>
        </PickerShell>
    )
}

const PickerShell: Component<{ title: string; onClose: () => void; children: any }> = (props) => (
    <div
        class="absolute inset-0 z-30 flex items-center justify-center bg-black/40"
        {...backdropDismiss(props.onClose)}
    >
        <div class="bg-element-matte border-element-accent w-full max-w-md rounded-lg border p-4 shadow-2xl">
            <div class="mb-3 flex items-center justify-between">
                <h3 class="text-main font-serif text-base">{props.title}</h3>
                <button onClick={props.onClose} class="text-sub hover:text-main hover:cursor-pointer">
                    <span class="material-symbols-outlined text-base">close</span>
                </button>
            </div>
            {props.children}
        </div>
    </div>
)

// --- guide overlay ---

const GuideOverlay: Component<{ onClose: () => void }> = (props) => (
    <div
        class="absolute inset-0 z-30 flex items-center justify-center bg-black/50"
        {...backdropDismiss(props.onClose)}
    >
        <div class="bg-element-matte border-element-accent w-full max-w-lg rounded-lg border p-5 shadow-2xl">
            <div class="mb-3 flex items-center justify-between">
                <h3 class="text-main font-serif text-lg">Canvas controls</h3>
                <button onClick={props.onClose} class="text-sub hover:text-main hover:cursor-pointer">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <ul class="text-sub space-y-2 text-sm">
                <GuideRow icon="pan_tool" title="Pan">Drag empty space (Pan tool), or use the Pan/Select toggle in the toolbar.</GuideRow>
                <GuideRow icon="zoom_in" title="Zoom">Scroll the mouse wheel; the point under the cursor stays put.</GuideRow>
                <GuideRow icon="add_box" title="Add nodes">Use the toolbar, or right-click empty space to drop a node where you click.</GuideRow>
                <GuideRow icon="open_with" title="Move & edit">Drag a node from anywhere on its body. Double-click a text, sticky or shape node to edit its label.</GuideRow>
                <GuideRow icon="conversion_path" title="Connect">Hover a node and drag from one of its edge dots onto another node, or drop in empty space to create a new node already connected. Click a connector to remove it.</GuideRow>
                <GuideRow icon="sticky_note_2" title="Text vs. sticky">A text node is a bare label on the board; a sticky is a coloured note card. Give a text node a background colour to turn it into a card.</GuideRow>
                <GuideRow icon="open_in_full" title="Resize">Drag a node's bottom-right corner. Size persists.</GuideRow>
                <GuideRow icon="highlight_alt" title="Multi-select">Switch to the Select tool, then drag a box over empty space. Shift-click nodes to add or remove.</GuideRow>
                <GuideRow icon="grid_4x4" title="Snapping">Toggle snap-to-grid; positions and sizes snap to the grid on drop.</GuideRow>
                <GuideRow icon="right_click" title="Right-click">Opens a context menu on empty space (add) or on a node (edit, style, duplicate, connect, delete).</GuideRow>
            </ul>
        </div>
    </div>
)

const GuideRow: Component<{ icon: string; title: string; children: any }> = (props) => (
    <li class="flex gap-2">
        <span class="material-symbols-outlined text-highlight text-base">{props.icon}</span>
        <span>
            <span class="text-main font-bold">{props.title}.</span> {props.children}
        </span>
    </li>
)

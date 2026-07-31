import { For, Show, type Component } from 'solid-js'
import type { Canvas, CanvasNode } from '../api'

// A schematic of a canvas: one rectangle per node, in the node's own colour,
// with its edges drawn underneath. Deliberately wordless. Node text at this
// size is a smear of pixels, and drawing it would mean laying out content the
// card has no room to show.

// World-unit box containing every node, or null for a board with nothing on it.
export function boardBounds(nodes: CanvasNode[]): { x: number; y: number; w: number; h: number } | null {
    if (!nodes.length) return null
    const left = Math.min(...nodes.map((n) => n.x))
    const top = Math.min(...nodes.map((n) => n.y))
    const right = Math.max(...nodes.map((n) => n.x + n.w))
    const bottom = Math.max(...nodes.map((n) => n.y + n.h))
    // A board of one zero-sized node would give a zero-extent viewBox, which
    // renders nothing at all rather than a dot.
    return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) }
}

// A tenth of the board's longer side, so the margin reads the same whether the
// board is a postage stamp or a wall.
const padding = (bounds: { w: number; h: number }) => Math.max(bounds.w, bounds.h) * 0.05

const colorOf = (node: CanvasNode): string => {
    try {
        return (JSON.parse(node.style || '{}') as { color?: string }).color || 'var(--color-sub)'
    } catch {
        return 'var(--color-sub)'
    }
}

const centre = (node: CanvasNode) => ({ x: node.x + node.w / 2, y: node.y + node.h / 2 })

export const CanvasThumbnail: Component<{ canvas: Canvas }> = (props) => {
    const nodes = () => props.canvas.nodes ?? []
    const bounds = () => boardBounds(nodes())
    const nodeById = (id: string) => nodes().find((n) => n.id === id)
    // Hairlines at board scale: a fixed stroke width would be invisible on a
    // large board and a slab on a small one.
    const stroke = () => Math.max(1, Math.max(bounds()!.w, bounds()!.h) * 0.004)

    return (
        <Show when={bounds()}>
            {(box) => (
                <svg
                    data-testid="canvas-thumbnail"
                    class="bg-element border-element-accent aspect-video w-full rounded-md border"
                    viewBox={`${box().x - padding(box())} ${box().y - padding(box())} ${box().w + padding(box()) * 2} ${box().h + padding(box()) * 2}`}
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label={`Layout of ${props.canvas.title || 'canvas'}`}
                >
                    <For each={props.canvas.edges ?? []}>
                        {(edge) => {
                            const from = nodeById(edge.from_node)
                            const to = nodeById(edge.to_node)
                            if (!from || !to) return null
                            return (
                                <line
                                    x1={centre(from).x}
                                    y1={centre(from).y}
                                    x2={centre(to).x}
                                    y2={centre(to).y}
                                    stroke="var(--color-sub)"
                                    stroke-width={stroke()}
                                    opacity="0.5"
                                />
                            )
                        }}
                    </For>
                    <For each={nodes()}>
                        {(node) => (
                            <rect
                                x={node.x}
                                y={node.y}
                                width={node.w}
                                height={node.h}
                                rx={Math.min(node.w, node.h) * 0.08}
                                fill={colorOf(node)}
                                opacity="0.85"
                            />
                        )}
                    </For>
                </svg>
            )}
        </Show>
    )
}

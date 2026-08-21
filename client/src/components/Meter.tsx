import { type Component } from 'solid-js'

// How far through something is: a bar and the percentage beside it. A fragment
// rather than a box, so a caller decides what it sits in.
//
// Shared because the planner draws one for a container row and the Projects
// screens draw one for a milestone and for a whole project, and a progress bar
// that reads differently in two places reads as two different measurements.
export const Meter: Component<{ done: number; total: number; class?: string; color?: string }> = (props) => {
    const percent = () => (props.total === 0 ? 0 : Math.round((props.done / props.total) * 100))
    return (
        <>
            <div class={`bg-element-accent h-1.5 overflow-hidden rounded-full ${props.class || 'w-16'}`}>
                <div
                    class="bg-highlight-strongest h-full rounded-full transition-all"
                    style={{ width: `${percent()}%`, 'background-color': props.color }}
                />
            </div>
            <span class="text-sub font-mono text-[10px]">{percent()}%</span>
        </>
    )
}

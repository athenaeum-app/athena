// PROTOTYPE, throwaway. Floating variant switcher: arrows cycle, URL param
// keeps the choice shareable and reload-stable. Deliberately styled unlike the
// app so nobody mistakes it for part of the design under evaluation.
import { onMount, onCleanup, type Component } from 'solid-js'

export const Switcher: Component<{
    variants: { key: string; name: string }[]
    current: string
    onPick: (key: string) => void
}> = (props) => {
    if (!import.meta.env.DEV) return null as never

    const index = () => Math.max(0, props.variants.findIndex((v) => v.key === props.current))
    const step = (delta: number) => {
        const next = props.variants[(index() + delta + props.variants.length) % props.variants.length]
        const url = new URL(window.location.href)
        url.searchParams.set('variant', next.key)
        window.history.replaceState(null, '', url)
        props.onPick(next.key)
    }

    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement
            if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable) return
            if (e.key === 'ArrowLeft') step(-1)
            if (e.key === 'ArrowRight') step(1)
        }
        window.addEventListener('keydown', onKey)
        onCleanup(() => window.removeEventListener('keydown', onKey))
    })

    return (
        <div
            style={{
                position: 'fixed',
                bottom: '14px',
                left: '50%',
                transform: 'translateX(-50%)',
                'z-index': 999,
                display: 'flex',
                'align-items': 'center',
                gap: '10px',
                background: '#000',
                color: '#fff',
                border: '2px solid #fff',
                'border-radius': '999px',
                padding: '6px 14px',
                'font-family': 'monospace',
                'font-size': '13px',
                'box-shadow': '0 4px 18px rgba(0,0,0,.6)',
            }}
        >
            <button style={{ cursor: 'pointer', color: '#fff', background: 'none', border: 'none', 'font-size': '15px' }} onClick={() => step(-1)}>
                ←
            </button>
            <span>
                {props.current} · {props.variants[index()].name}
            </span>
            <button style={{ cursor: 'pointer', color: '#fff', background: 'none', border: 'none', 'font-size': '15px' }} onClick={() => step(1)}>
                →
            </button>
        </div>
    )
}

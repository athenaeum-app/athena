import { createEffect, createSignal, type Accessor } from 'solid-js'

// Shared keyboard navigation for the app's hand-rolled searchable pickers
// (arrow keys move the highlight, Enter selects it, Escape closes). Focus lives
// in the picker's search input, so wire `onKeyDown` there. Pass the list
// container to `setListRef` to keep the active row scrolled into view.
//
// The rendered rows must be the direct element children of the ref'd container
// (which is how the pickers render their <For> of buttons).
export function createListboxNav<T>(
    items: Accessor<T[]>,
    onSelect: (item: T, index: number) => void,
    onClose?: () => void,
) {
    const [active, setActive] = createSignal(0)
    let listRef: HTMLElement | undefined

    // Reset the highlight whenever the filtered set changes.
    createEffect(() => {
        items()
        setActive(0)
    })
    // Keep the highlighted row visible.
    createEffect(() => {
        const el = listRef?.children[active()] as HTMLElement | undefined
        el?.scrollIntoView({ block: 'nearest' })
    })

    const onKeyDown = (e: KeyboardEvent) => {
        const list = items()
        const n = list.length
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => (n ? (a + 1) % n : 0))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => (n ? (a - 1 + n) % n : 0))
        } else if (e.key === 'Enter') {
            e.preventDefault()
            const item = list[active()]
            if (item !== undefined) onSelect(item, active())
        } else if (e.key === 'Escape' && onClose) {
            e.preventDefault()
            onClose()
        }
    }

    return {
        active,
        setActive,
        onKeyDown,
        setListRef: (el: HTMLElement) => {
            listRef = el
        },
    }
}

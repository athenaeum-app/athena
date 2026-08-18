import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@solidjs/testing-library'
import { createSignal, Show } from 'solid-js'
import { Modal } from './Modal'

// A gesture, as the browser delivers it: press on one element, release on
// another, and a `click` on the nearest common ancestor of the two. Dragging
// out of a dialog and letting go over the backdrop is the case that used to
// close the dialog under the user's hand.
function drag(from: Element, to: Element, common: Element): void {
    fireEvent.pointerDown(from)
    fireEvent.pointerUp(to)
    fireEvent.click(common)
}

function tap(el: Element): void {
    fireEvent.pointerDown(el)
    fireEvent.pointerUp(el)
    fireEvent.click(el)
}

const panelText = 'panel contents'

function renderModal(onClose: () => void) {
    render(() => (
        <Modal onClose={onClose} data-testid="backdrop">
            <div data-testid="panel">{panelText}</div>
        </Modal>
    ))
    return {
        backdrop: screen.getByTestId('backdrop'),
        panel: screen.getByTestId('panel'),
    }
}

describe('Modal backdrop dismissal', () => {
    it('closes when the whole gesture happens on the backdrop', () => {
        const onClose = vi.fn()
        const { backdrop } = renderModal(onClose)
        tap(backdrop)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('stays open when a drag starts inside the panel and ends on the backdrop', () => {
        const onClose = vi.fn()
        const { backdrop, panel } = renderModal(onClose)
        drag(panel, backdrop, backdrop)
        expect(onClose).not.toHaveBeenCalled()
    })

    it('stays open when a drag starts on the backdrop and ends inside the panel', () => {
        const onClose = vi.fn()
        const { backdrop, panel } = renderModal(onClose)
        drag(backdrop, panel, backdrop)
        expect(onClose).not.toHaveBeenCalled()
    })

    it('stays open on a plain click inside the panel', () => {
        const onClose = vi.fn()
        const { panel } = renderModal(onClose)
        tap(panel)
        expect(onClose).not.toHaveBeenCalled()
    })

    it('closes on the next clean backdrop click after an aborted drag', () => {
        const onClose = vi.fn()
        const { backdrop, panel } = renderModal(onClose)
        drag(panel, backdrop, backdrop)
        tap(backdrop)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('ignores the backdrop entirely when it is not dismissable', () => {
        const onClose = vi.fn()
        render(() => (
            <Modal onClose={onClose} dismissable={false} data-testid="backdrop">
                <div>{panelText}</div>
            </Modal>
        ))
        tap(screen.getByTestId('backdrop'))
        expect(onClose).not.toHaveBeenCalled()
    })
})

describe('Modal escape handling', () => {
    const escape = () => fireEvent.keyDown(window, { key: 'Escape' })

    it('closes on Escape', () => {
        const onClose = vi.fn()
        renderModal(onClose)
        escape()
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('closes only the topmost modal, so one key does not take down two layers', () => {
        const outer = vi.fn()
        const inner = vi.fn()
        const [nested, setNested] = createSignal(false)
        render(() => (
            <Modal onClose={outer}>
                <div>outer</div>
                <Show when={nested()}>
                    <Modal onClose={inner}>
                        <div>inner</div>
                    </Modal>
                </Show>
            </Modal>
        ))

        escape()
        expect(outer).toHaveBeenCalledTimes(1)
        expect(inner).not.toHaveBeenCalled()

        setNested(true)
        escape()
        expect(inner).toHaveBeenCalledTimes(1)
        expect(outer).toHaveBeenCalledTimes(1)
    })

    it('hands Escape back to the layer below once the top one unmounts', () => {
        const outer = vi.fn()
        const inner = vi.fn()
        const [nested, setNested] = createSignal(true)
        render(() => (
            <Modal onClose={outer}>
                <div>outer</div>
                <Show when={nested()}>
                    <Modal onClose={inner}>
                        <div>inner</div>
                    </Modal>
                </Show>
            </Modal>
        ))

        escape()
        expect(inner).toHaveBeenCalledTimes(1)
        expect(outer).not.toHaveBeenCalled()

        setNested(false)
        escape()
        expect(outer).toHaveBeenCalledTimes(1)
    })

    it('leaves the key alone when something inside already answered it', () => {
        const onClose = vi.fn()
        render(() => (
            <Modal onClose={onClose}>
                <input data-testid="field" onKeyDown={(e) => e.preventDefault()} />
            </Modal>
        ))
        fireEvent.keyDown(screen.getByTestId('field'), { key: 'Escape' })
        expect(onClose).not.toHaveBeenCalled()
    })

    it('respects closeOnEscape={false}', () => {
        const onClose = vi.fn()
        render(() => (
            <Modal onClose={onClose} closeOnEscape={false}>
                <div>{panelText}</div>
            </Modal>
        ))
        escape()
        expect(onClose).not.toHaveBeenCalled()
    })
})

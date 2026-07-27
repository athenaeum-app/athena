import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@solidjs/testing-library'
import { quoteFor, ChatPanel } from './ChatPanel'
import { AuthProvider } from '../auth'
import { UIProvider } from '../ui'
import { api } from '../api'

vi.mock('../api', () => ({
    api: {
        getMe: vi.fn(),
        listChat: vi.fn(),
        sendChat: vi.fn(),
        updateChat: vi.fn(),
        deleteChat: vi.fn(),
    },
}))
vi.mock('../users', () => ({ loadUsers: vi.fn(), userName: (id: string) => id }))

describe('quoteFor', () => {
    it('prefixes a single line and leaves room to type under it', () => {
        expect(quoteFor('Hello!')).toBe('> Hello!\n\n')
    })

    it('keeps a multi-line message as one blockquote', () => {
        expect(quoteFor('first\nsecond')).toBe('> first\n> second\n\n')
    })

    it('leaves no trailing space on a blank line inside the quote', () => {
        // '> ' on its own would be trailing whitespace in the composer, and
        // some markdown tooling treats it as a hard break.
        expect(quoteFor('first\n\nsecond')).toBe('> first\n>\n> second\n\n')
    })

    it('quotes a quote rather than flattening it', () => {
        expect(quoteFor('> already quoted')).toBe('> > already quoted\n\n')
    })

    it('drops embed tokens, which cannot survive being quoted', () => {
        const id = '11111111-2222-3333-4444-555555555555'
        expect(quoteFor(`see this ::todo:${id}::`)).toBe('> see this\n\n')
        expect(quoteFor(`see this [[${id}]]`)).toBe('> see this\n\n')
    })

    it('gives nothing back for a message that is only an embed', () => {
        expect(quoteFor('::canvas:11111111-2222-3333-4444-555555555555::')).toBe('')
        expect(quoteFor('')).toBe('')
        expect(quoteFor('   ')).toBe('')
    })

    it('preserves markdown in the quoted text', () => {
        expect(quoteFor('**bold** and `code`')).toBe('> **bold** and `code`\n\n')
    })
})

// Opening chat should land on the newest message even while slow-loading
// content (an image, an embed, a link preview) is still growing the list.
// jsdom implements neither real layout nor ResizeObserver, so the metrics and
// the observer callback are stubbed by hand, which gives full control over
// the exact interleaving being tested instead of chasing a real,
// timing-dependent race.
describe('auto-scroll on open', () => {
    class StubResizeObserver {
        static instances: StubResizeObserver[] = []
        cb: ResizeObserverCallback
        constructor(cb: ResizeObserverCallback) {
            this.cb = cb
            StubResizeObserver.instances.push(this)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
        fire() {
            this.cb([], this as unknown as ResizeObserver)
        }
    }

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    // Installs live scrollHeight/clientHeight/scrollTop on a real element.
    // Real browsers clamp scrollTop to [0, scrollHeight - clientHeight];
    // jsdom does not, so the clamp is reproduced here to keep the simulation
    // honest about what scrollToBottom() would actually land on.
    function stubScrollMetrics(el: HTMLElement, clientHeight: number, scrollHeight: number) {
        let _clientHeight = clientHeight
        let _scrollHeight = scrollHeight
        let _scrollTop = 0
        Object.defineProperty(el, 'clientHeight', { get: () => _clientHeight, configurable: true })
        Object.defineProperty(el, 'scrollHeight', { get: () => _scrollHeight, configurable: true })
        Object.defineProperty(el, 'scrollTop', {
            get: () => _scrollTop,
            set: (v: number) => {
                _scrollTop = Math.max(0, Math.min(v, Math.max(0, _scrollHeight - _clientHeight)))
            },
            configurable: true,
        })
        return { grow: (next: number) => { _scrollHeight = next } }
    }

    it('stays pinned to the bottom across two content-growth events with a scroll event in between', async () => {
        StubResizeObserver.instances.length = 0
        vi.stubGlobal('ResizeObserver', StubResizeObserver)
        vi.mocked(api.getMe).mockResolvedValue({ id: 'u1', username: 'owner', is_owner: true, roles: [], permissions: 0 })
        vi.mocked(api.listChat).mockResolvedValue([
            { id: 'm1', author_id: 'u1', content: 'hello', is_legacy: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        ])

        render(() => (
            <UIProvider>
                <AuthProvider>
                    <ChatPanel />
                </AuthProvider>
            </UIProvider>
        ))
        await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument())

        const scrollEl = screen.getByTestId('chat-scroll')
        const metrics = stubScrollMetrics(scrollEl, 500, 1000)
        const observer = StubResizeObserver.instances[0]
        expect(observer).toBeDefined()

        // First growth (e.g. an image finishing decode): the observer re-pins,
        // which is the component itself calling scrollToBottom().
        observer.fire()
        expect(scrollEl.scrollTop).toBe(500) // clamp(scrollHeight=1000) -> 1000 - 500

        // Something else (another image, a link preview) grows the list again
        // in the gap before the native 'scroll' event from that re-pin lands.
        metrics.grow(1300)
        scrollEl.dispatchEvent(new Event('scroll'))

        // A further resize (content finishing settling in) should still reach
        // the true bottom if the panel is still following it.
        observer.fire()
        expect(scrollEl.scrollTop).toBe(800) // clamp(scrollHeight=1300) -> 1300 - 500
    })
})

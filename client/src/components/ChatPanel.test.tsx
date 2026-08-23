import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@solidjs/testing-library'
import { previewLine, ChatPanel } from './ChatPanel'
import { AuthProvider } from '../auth'
import { UIProvider } from '../ui'
import { api } from '../api'

// The module's other exports stay real: APIError is one of them, and auth's
// session check reaches for it through reachability the moment getMe settles.
vi.mock('../api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api')>()),
    api: {
        getMe: vi.fn(),
        listChat: vi.fn(),
        sendChat: vi.fn(),
        updateChat: vi.fn(),
        deleteChat: vi.fn(),
    },
}))
vi.mock('../users', () => ({ loadUsers: vi.fn(), userName: (id: string) => id }))

describe('previewLine', () => {
    it('gives a message back as one line', () => {
        expect(previewLine('Hello!')).toBe('Hello!')
        expect(previewLine('first\nsecond')).toBe('first second')
    })

    it('drops embed tokens, which are cards rather than words', () => {
        const id = '11111111-2222-3333-4444-555555555555'
        expect(previewLine(`see this ::todo:${id}::`)).toBe('see this')
        expect(previewLine(`see this [[${id}]]`)).toBe('see this')
    })

    it('names an attachment instead of showing the markdown that fetches it', () => {
        expect(previewLine('![kettle.png](/api/v1/assets/abc123)')).toBe('kettle.png')
        expect(previewLine('look: [notes.pdf](/api/v1/assets/abc123)')).toBe('look: notes.pdf')
        expect(previewLine('![](/api/v1/assets/abc123)')).toBe('Attachment')
    })

    // A message with nothing but an embed in it is still a message somebody is
    // answering, and a reply line with nothing on it says nothing at all.
    it('says what a message made only of embeds is', () => {
        expect(previewLine('::canvas:11111111-2222-3333-4444-555555555555::')).toBe('Embed')
        expect(previewLine('   ')).toBe('Embed')
    })

    it('leaves markdown alone, since the line is read as text', () => {
        expect(previewLine('**bold** and `code`')).toBe('**bold** and `code`')
    })
})

// Replying used to paste the message into the composer as a blockquote, so the
// copy went stale, could not be followed back, and could be edited into
// something the original never said. A reply holds the id instead.
describe('replying', () => {
    const owner = { id: 'u1', username: 'owner', is_owner: true, roles: [], permissions: 1 << 19 }
    const at = (iso: string) => ({ created_at: iso, updated_at: iso })

    // The composer asks the width whether Enter sends, and jsdom has no
    // matchMedia at all: without this it throws on render, the panel falls back
    // to the read-only footer, and there is nothing to reply into.
    beforeEach(() => {
        vi.stubGlobal('matchMedia', (media: string) => ({
            media,
            matches: false,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => false,
        }))
    })
    afterEach(() => vi.unstubAllGlobals())

    const renderPanel = () =>
        render(() => (
            <UIProvider>
                <AuthProvider>
                    <ChatPanel />
                </AuthProvider>
            </UIProvider>
        ))

    it('draws a line naming the message a reply answers', async () => {
        vi.mocked(api.getMe).mockResolvedValue(owner)
        vi.mocked(api.listChat).mockResolvedValue([
            { id: 'm1', author_id: 'u1', content: 'the kettle needs descaling', is_legacy: false, ...at('2024-01-01T10:00:00Z') },
            {
                id: 'm2',
                author_id: 'u2',
                content: 'on it',
                is_legacy: false,
                reply_to_id: 'm1',
                reply_to: { id: 'm1', author_id: 'u1', content: 'the kettle needs descaling', deleted: false },
                ...at('2024-01-01T10:01:00Z'),
            },
        ])

        renderPanel()

        const line = await screen.findByTestId('chat-reply-line')
        expect(line).toHaveTextContent('u1')
        expect(line).toHaveTextContent('the kettle needs descaling')
    })

    it('says so where the answered message has been deleted', async () => {
        vi.mocked(api.getMe).mockResolvedValue(owner)
        vi.mocked(api.listChat).mockResolvedValue([
            {
                id: 'm2',
                author_id: 'u2',
                content: 'quite',
                is_legacy: false,
                reply_to_id: 'm1',
                reply_to: { id: 'm1', author_id: 'u1', content: '', deleted: true },
                ...at('2024-01-01T10:01:00Z'),
            },
        ])

        renderPanel()

        expect(await screen.findByTestId('chat-reply-gone')).toBeInTheDocument()
        expect(screen.queryByTestId('chat-reply-line')).not.toBeInTheDocument()
    })

    // The whole point of the change: the composer is left alone, so nothing
    // anybody else wrote can be edited into your own message on the way out.
    it('names the target beside the composer instead of typing into it', async () => {
        vi.mocked(api.getMe).mockResolvedValue(owner)
        vi.mocked(api.listChat).mockResolvedValue([
            { id: 'm1', author_id: 'u1', content: 'the kettle needs descaling', is_legacy: false, ...at('2024-01-01T10:00:00Z') },
        ])

        const { container } = renderPanel()
        const draft = () => (container.querySelector('textarea') as HTMLTextAreaElement).value

        const replyButton = await screen.findByRole('button', { name: 'Reply to u1' })
        expect(draft()).toBe('')
        replyButton.click()

        const bar = await screen.findByTestId('chat-replying-to')
        expect(bar).toHaveTextContent('Replying to')
        expect(bar).toHaveTextContent('the kettle needs descaling')
        expect(draft()).toBe('')

        // And backing out leaves nothing behind either.
        screen.getByRole('button', { name: 'Stop replying' }).click()
        await waitFor(() => expect(screen.queryByTestId('chat-replying-to')).not.toBeInTheDocument())
        expect(draft()).toBe('')
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

// Chat search runs on the server (api.listChat's `q`), because the panel only
// holds the pages it has scrolled through: a filter over those would only ever
// find what is already on screen.
describe('search', () => {
    it('asks the server for the query and lists what comes back', async () => {
        vi.mocked(api.getMe).mockResolvedValue({ id: 'u1', username: 'owner', is_owner: true, roles: [], permissions: 0 })
        const hit = {
            id: 'old1',
            author_id: 'u1',
            content: 'the kettle needs descaling',
            is_legacy: false,
            created_at: new Date('2020-01-01').toISOString(),
            updated_at: new Date('2020-01-01').toISOString(),
        }
        vi.mocked(api.listChat).mockImplementation(async (params: { q?: string } = {}) => (params.q ? [hit] : []))

        render(() => (
            <UIProvider>
                <AuthProvider>
                    <ChatPanel />
                </AuthProvider>
            </UIProvider>
        ))

        await waitFor(() => expect(screen.getByTestId('chat-search-open')).toBeInTheDocument())
        screen.getByTestId('chat-search-open').click()

        const box = (await screen.findByTestId('chat-search')) as HTMLInputElement
        box.value = 'kettle'
        box.dispatchEvent(new Event('input', { bubbles: true }))

        await waitFor(() => expect(screen.getByText('the kettle needs descaling')).toBeInTheDocument(), { timeout: 3000 })
        expect(vi.mocked(api.listChat)).toHaveBeenCalledWith(expect.objectContaining({ q: 'kettle' }))
    })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api, type ChatMessage } from './api'
import { recentChat, refreshChatFeed, mutateChatFeed, watchChatFeed } from './chatFeed'

vi.mock('./api', () => ({ api: { listChat: vi.fn() } }))

const message = (id: string, content: string, updated = '2026-01-01T00:00:00Z'): ChatMessage => ({
    id,
    author_id: 'u1',
    content,
    is_legacy: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: updated,
})

describe('the shared chat feed', () => {
    beforeEach(() => {
        vi.mocked(api.listChat).mockReset()
    })

    it('publishes the newest window oldest-first, the order both readers render in', async () => {
        // The API answers newest-first.
        vi.mocked(api.listChat).mockResolvedValue([message('b', 'second'), message('a', 'first')])
        await refreshChatFeed()
        expect(recentChat().map((m) => m.content)).toEqual(['first', 'second'])
    })

    it('keeps the identity of messages a poll did not change', async () => {
        vi.mocked(api.listChat).mockResolvedValue([message('b', 'second'), message('a', 'first')])
        await refreshChatFeed()
        const before = recentChat()

        // A fresh poll: new objects for the same rows, plus one real edit.
        vi.mocked(api.listChat).mockResolvedValue([message('b', 'edited', '2026-02-02T00:00:00Z'), message('a', 'first')])
        await refreshChatFeed()
        const after = recentChat()

        // Handing <For> a new reference for every message each cycle would
        // rebuild the whole visible list every five seconds.
        expect(after[0]).toBe(before[0])
        expect(after[1]).not.toBe(before[1])
        expect(after[1].content).toBe('edited')
    })

    it('shares one request between callers that overlap', async () => {
        vi.mocked(api.listChat).mockResolvedValue([message('a', 'first')])
        await Promise.all([refreshChatFeed(), refreshChatFeed()])
        expect(api.listChat).toHaveBeenCalledTimes(1)
    })

    it('takes a local change straight away, which is what keeps the preview level with the panel', async () => {
        vi.mocked(api.listChat).mockResolvedValue([message('a', 'first')])
        await refreshChatFeed()

        mutateChatFeed((msgs) => [...msgs, message('b', 'just sent')])
        expect(recentChat().map((m) => m.content)).toEqual(['first', 'just sent'])

        mutateChatFeed((msgs) => msgs.filter((m) => m.id !== 'a'))
        expect(recentChat().map((m) => m.content)).toEqual(['just sent'])
    })

    it('polls only while something is watching', async () => {
        vi.useFakeTimers()
        vi.mocked(api.listChat).mockResolvedValue([])
        const stop = watchChatFeed()
        expect(api.listChat).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(5000)
        expect(api.listChat).toHaveBeenCalledTimes(2)

        stop()
        await vi.advanceTimersByTimeAsync(15000)
        expect(api.listChat).toHaveBeenCalledTimes(2)
        vi.useRealTimers()
    })
})

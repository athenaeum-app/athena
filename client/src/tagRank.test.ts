import { describe, it, expect } from 'vitest'
import { rankTags } from './tagRank'
import type { Tag, TagGraph } from './api'

const tag = (id: string): Tag => ({
    id,
    name: id.toUpperCase(),
    color: '#000000',
    created_at: '',
    updated_at: '',
})

// graph builds the symmetric pair map the server sends, from one direction.
const graph = (totals: Record<string, number>, pairs: Record<string, Record<string, number>> = {}): TagGraph => {
    const symmetric: Record<string, Record<string, number>> = {}
    for (const [left, partners] of Object.entries(pairs)) {
        for (const [right, n] of Object.entries(partners)) {
            symmetric[left] = { ...symmetric[left], [right]: n }
            symmetric[right] = { ...symmetric[right], [left]: n }
        }
    }
    return { totals, pairs: symmetric }
}

const names = (tags: Tag[]) => tags.map((t) => t.id)

describe('rankTags', () => {
    it('orders by overall usage when nothing is selected', () => {
        const tags = [tag('rare'), tag('common'), tag('mid')]
        expect(names(rankTags(tags, graph({ common: 3, mid: 2, rare: 1 })))).toEqual(['common', 'mid', 'rare'])
    })

    it('promotes tags that co-occur with the selected one over more popular tags', () => {
        const tags = [tag('popular'), tag('friend')]
        const g = graph({ popular: 3, friend: 1, picked: 1 }, { picked: { friend: 1 } })
        expect(names(rankTags(tags, g, ['picked']))).toEqual(['friend', 'popular'])
    })

    it('orders co-occurring tags by how often they share a moment', () => {
        // The behaviour the whole feature is for: A appears with D five times,
        // with B twice and C once, so D leads even though B is used more
        // overall.
        const tags = [tag('b'), tag('c'), tag('d')]
        const g = graph({ b: 40, c: 3, d: 5 }, { a: { b: 2, c: 1, d: 5 } })
        expect(names(rankTags(tags, g, ['a']))).toEqual(['d', 'b', 'c'])
    })

    it('adds sharing across several selected tags', () => {
        // `trio` is filed with both picks and so beats a tag strongly tied to
        // only one of them.
        const tags = [tag('trio'), tag('onesided')]
        const g = graph({ trio: 4, onesided: 9 }, { a: { trio: 2, onesided: 3 }, b: { trio: 2 } })
        expect(names(rankTags(tags, g, ['a', 'b']))).toEqual(['trio', 'onesided'])
    })

    it('breaks co-occurrence ties on overall usage', () => {
        const tags = [tag('quiet'), tag('loud')]
        const g = graph({ quiet: 2, loud: 30 }, { a: { quiet: 1, loud: 1 } })
        expect(names(rankTags(tags, g, ['a']))).toEqual(['loud', 'quiet'])
    })

    it('beats popularity no matter how lopsided the counts are', () => {
        // The old weighted sum used a constant of 1000, so a tag with enough
        // solo uses could outscore a better-connected one. Priority is now
        // absolute rather than a threshold to outgrow.
        const tags = [tag('related'), tag('everywhere')]
        const g = graph({ related: 1, everywhere: 500000 }, { a: { related: 1 } })
        expect(names(rankTags(tags, g, ['a']))).toEqual(['related', 'everywhere'])
    })

    it('leaves the incoming order alone before the graph arrives', () => {
        const tags = [tag('b'), tag('a'), tag('c')]
        expect(names(rankTags(tags, null, ['a']))).toEqual(['b', 'a', 'c'])
    })

    it('leaves unused tags in their incoming order', () => {
        const tags = [tag('b'), tag('a'), tag('c')]
        expect(names(rankTags(tags, graph({})))).toEqual(['b', 'a', 'c'])
    })
})

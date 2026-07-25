import { describe, it, expect } from 'vitest'
import { rankTags } from './tagRank'
import type { Moment, Tag } from './api'

const tag = (id: string): Tag => ({
    id,
    name: id.toUpperCase(),
    color: '#000000',
    created_at: '',
    updated_at: '',
})

const moment = (id: string, tag_ids: string[]): Moment =>
    ({ id, tag_ids }) as Moment

const names = (tags: Tag[]) => tags.map((t) => t.id)

describe('rankTags', () => {
    it('orders by overall usage when nothing is selected', () => {
        const tags = [tag('rare'), tag('common'), tag('mid')]
        const moments = [
            moment('1', ['common']),
            moment('2', ['common', 'mid']),
            moment('3', ['common', 'mid']),
            moment('4', ['rare']),
        ]
        expect(names(rankTags(tags, moments))).toEqual(['common', 'mid', 'rare'])
    })

    it('promotes tags that co-occur with the selected one over more popular tags', () => {
        const tags = [tag('popular'), tag('friend')]
        const moments = [
            // `popular` is used more overall...
            moment('1', ['popular']),
            moment('2', ['popular']),
            moment('3', ['popular']),
            // ...but only `friend` has ever been filed alongside `picked`.
            moment('4', ['picked', 'friend']),
        ]
        expect(names(rankTags(tags, moments, ['picked']))).toEqual(['friend', 'popular'])
    })

    it('leaves unused tags in their incoming order', () => {
        const tags = [tag('b'), tag('a'), tag('c')]
        expect(names(rankTags(tags, []))).toEqual(['b', 'a', 'c'])
    })

    it('ignores moments carrying no tags', () => {
        const tags = [tag('a')]
        const moments = [moment('1', []), { id: '2' } as Moment]
        expect(names(rankTags(tags, moments))).toEqual(['a'])
    })
})

import { describe, it, expect } from 'vitest'
import { extractUrls } from './LinkPreview'

describe('extractUrls', () => {
    it('finds bare urls, deduplicated', () => {
        expect(extractUrls('see https://a.com and https://b.com and https://a.com')).toEqual([
            'https://a.com',
            'https://b.com',
        ])
    })

    it('drops trailing sentence punctuation', () => {
        expect(extractUrls('read https://example.com/page.')).toEqual(['https://example.com/page'])
    })

    it('skips urls preceded by a bracket, bang, or paren', () => {
        expect(extractUrls(']https://a.com !https://b.com )https://c.com')).toEqual([])
    })

    it('still matches a url at the very start', () => {
        expect(extractUrls('https://example.com')).toEqual(['https://example.com'])
    })
})

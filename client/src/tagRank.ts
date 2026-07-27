import type { Tag, TagGraph } from './api'

// Ranking for the composer's tag suggestions. Two signals, in strict priority:
//
//   1. Co-occurrence. How many moments carry this tag alongside one you have
//      already picked. Pick GAMES and the tags you habitually file with it come
//      to the front, most-shared first.
//   2. Overall usage, as the tiebreak. With nothing picked this is the only
//      signal, so an empty field opens on your most-used tags.
//
// The comparison is a tuple rather than a weighted sum. An earlier version
// added a large constant per co-occurring moment and claimed one shared moment
// beat any amount of popularity; that only held below the constant, so on a
// large enough library a very popular tag could still displace a genuinely
// related one. Comparing the signals in order says what was always meant and
// has no threshold to outgrow.

// coOccurrence sums the moments this tag shares with each picked tag. A tag
// picked alongside two of your selections counts for both, which is what makes
// the third tag of a habitual trio outrank a tag related to only one of them.
const coOccurrence = (graph: TagGraph, tagId: string, relatedTagIds: string[]): number => {
    const partners = graph.pairs[tagId]
    if (!partners) return 0
    let total = 0
    for (const related of relatedTagIds) {
        total += partners[related] || 0
    }
    return total
}

// rankTags orders `tags` by how often each has shared a moment with
// `relatedTagIds` (the tags already chosen in the composer), then by overall
// usage.
//
// `graph` covers the whole library, not the loaded feed page, so the order does
// not depend on how far the reader has scrolled or which archive they came
// from. A null graph (the first request is still in flight) leaves the incoming
// order alone rather than guessing from partial data.
//
// Ties keep their incoming order: Array.prototype.sort is stable, so the
// server's alphabetical ordering shows through for tags that have never been
// used, instead of the list reshuffling arbitrarily between renders.
export function rankTags(tags: Tag[], graph: TagGraph | null, relatedTagIds: string[] = []): Tag[] {
    if (!graph) return [...tags]

    const shared = new Map<string, number>()
    for (const tag of tags) {
        shared.set(tag.id, relatedTagIds.length ? coOccurrence(graph, tag.id, relatedTagIds) : 0)
    }

    return [...tags].sort((a, b) => {
        const bySharing = (shared.get(b.id) || 0) - (shared.get(a.id) || 0)
        if (bySharing !== 0) return bySharing
        return (graph.totals[b.id] || 0) - (graph.totals[a.id] || 0)
    })
}

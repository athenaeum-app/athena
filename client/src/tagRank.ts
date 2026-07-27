import type { Tag, TagGraph } from './api'

// Ranking for the composer's tag suggestions. Four signals, in strict priority:
//
//   1. Used in the archive being written into. A tag that archive has never
//      carried sorts behind every tag it has, however well the tag scores
//      otherwise. Filing into Work should not open on the vocabulary of a
//      different archive.
//   2. Co-occurrence. How many moments carry this tag alongside one you have
//      already picked. Pick GAMES and the tags you habitually file with it come
//      to the front, most-shared first.
//   3. Usage within that archive, so the archive's own common tags lead.
//   4. Overall usage, as the final tiebreak. With no archive and nothing picked
//      this is the only signal, so an empty field opens on your most-used tags.
//
// The comparison is a tuple rather than a weighted sum. An earlier version
// added a large constant per co-occurring moment and claimed one shared moment
// beat any amount of popularity; that only held below the constant, so on a
// large enough library a very popular tag could still displace a genuinely
// related one. Comparing the signals in order says what was always meant and
// has no threshold to outgrow. The archive gate is the same argument: a score
// of 1 against 0 is a constant, and it would be outgrown the same way.

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

// rankTags orders `tags` by whether each is used in `archiveId`, then by how
// often it has shared a moment with `relatedTagIds` (the tags already chosen in
// the composer), then by usage inside that archive, then by usage overall.
//
// `graph` covers the whole library, not the loaded feed page, so the order does
// not depend on how far the reader has scrolled or which archive they came
// from. The archive signal is separate from that: it is the archive the moment
// is being filed into, which the writer chose, not the view they arrived from.
// A null graph (the first request is still in flight) leaves the incoming order
// alone rather than guessing from partial data.
//
// An absent, empty or unknown `archiveId` drops the archive signals entirely
// and leaves co-occurrence and overall usage deciding, so chat moments (which
// carry no archive) and an archive with nothing filed in it yet both rank the
// way they did before this existed.
//
// Ties keep their incoming order: Array.prototype.sort is stable, so the
// server's alphabetical ordering shows through for tags that have never been
// used, instead of the list reshuffling arbitrarily between renders.
export function rankTags(
    tags: Tag[],
    graph: TagGraph | null,
    relatedTagIds: string[] = [],
    archiveId = '',
): Tag[] {
    if (!graph) return [...tags]

    const inArchive = (archiveId && graph.archive_totals?.[archiveId]) || null

    const shared = new Map<string, number>()
    for (const tag of tags) {
        shared.set(tag.id, relatedTagIds.length ? coOccurrence(graph, tag.id, relatedTagIds) : 0)
    }

    return [...tags].sort((a, b) => {
        if (inArchive) {
            const byPresence = Number(!!inArchive[b.id]) - Number(!!inArchive[a.id])
            if (byPresence !== 0) return byPresence
        }

        const bySharing = (shared.get(b.id) || 0) - (shared.get(a.id) || 0)
        if (bySharing !== 0) return bySharing

        if (inArchive) {
            const byArchiveUse = (inArchive[b.id] || 0) - (inArchive[a.id] || 0)
            if (byArchiveUse !== 0) return byArchiveUse
        }

        return (graph.totals[b.id] || 0) - (graph.totals[a.id] || 0)
    })
}

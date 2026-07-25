import type { Moment, Tag } from './api'

// Ranking for the composer's tag suggestions, ported from the legacy desktop
// client (its `sortTags`). Two signals, in priority order:
//
//   1. Co-occurrence. A tag that appears on moments already carrying one of the
//      tags you have picked is almost certainly the one you want next: pick
//      GAMES and the tags you habitually file alongside it come to the front.
//   2. Overall frequency, as the tiebreak. With nothing picked yet this is the
//      only signal, so an empty field opens on your most-used tags.
//
// The weight is deliberately far larger than any realistic moment count, so a
// single co-occurring moment outranks any amount of raw popularity rather than
// the two signals blending into each other.
const CO_OCCURRENCE_WEIGHT = 1000

// rankTags orders `tags` by usage across `moments`, boosting those that
// co-occur with `relatedTagIds` (the tags already chosen in the composer).
// Ties keep their incoming order: Array.prototype.sort is stable, so the
// server's ordering shows through for tags that have never been used, instead
// of the suggestion list reshuffling arbitrarily between renders.
export function rankTags(tags: Tag[], moments: Moment[], relatedTagIds: string[] = []): Tag[] {
    const related = new Set(relatedTagIds)
    const weights = new Map<string, number>()

    for (const moment of moments) {
        const ids = moment.tag_ids
        if (!ids || ids.length === 0) continue

        // Scored per moment, not per tag: every tag on a moment that shares one
        // of the picked tags is a candidate, including the picked tag itself
        // (harmless, since the caller has already filtered those out).
        const shares = related.size > 0 && ids.some((id) => related.has(id))
        const weight = shares ? CO_OCCURRENCE_WEIGHT + 1 : 1

        for (const id of ids) {
            weights.set(id, (weights.get(id) || 0) + weight)
        }
    }

    return [...tags].sort((a, b) => (weights.get(b.id) || 0) - (weights.get(a.id) || 0))
}

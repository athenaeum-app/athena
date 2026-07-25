import type { Tag } from './api'

// Shared rule for the three tag-filter surfaces (the desktop TagBar, the mobile
// filter sheet, and the Menu column's Tags widget). They all drive the same
// selectedTagIds state, so they have to agree on what is offerable or the same
// library looks different depending on where you filter from.
//
// Tag filtering is AND: a moment must carry every selected tag. That makes it
// easy to assemble a combination nothing satisfies, and the resulting empty
// feed gives no clue which tag was the wrong one. `available` is the server's
// answer to "which tags still match at least one moment under the current
// filter" (GET /api/v1/tags/facets), so hiding everything outside it means
// every remaining tag is a click that narrows rather than a click that might
// dead-end.
//
// Two carve-outs:
//
//   - `available` is null until the first facet response lands. Treating that
//     as "nothing is available" would blank the bar on every cold load and
//     briefly on every filter change, so a missing answer shows everything.
//   - Selected tags are always kept. They are in the facet set anyway (they sit
//     on every surviving moment by definition), but if a facet response is ever
//     stale or partial, dropping a selected tag would remove the only control
//     for undoing that selection and strand the reader on a filter they cannot
//     clear.
export function visibleTags(tags: Tag[], available: Set<string> | null | undefined, selectedTagIds: string[]): Tag[] {
    if (!available) return tags
    const selected = new Set(selectedTagIds)
    return tags.filter((t) => available.has(t.id) || selected.has(t.id))
}

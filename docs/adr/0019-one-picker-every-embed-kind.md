# One picker for every embed kind

Referencing another entity today takes two different doors. Typing `[[` in a
composer autocompletes over moments only, matched by title substring against
whatever happens to be in the loaded feed page, and inserts `[[id]]`. Every
other kind goes through the slash menu's per-kind picker, which fetches that
kind's list and inserts `::kind:id::`. The mental model the user actually has
is simpler than either: "I want to point at a thing I know the name of".

The decision: `[[` becomes the one door. Typing it in any moment-pipeline
composer opens a single search across every referencable entity: moments, todo
lists, canvases, projects, and project documents once those exist. Results are
grouped and badged by kind. A kind prefix narrows the search, written
`[[kind:query`, with the kinds spelled `moment`, `todo`, `canvas`, `project`,
`doc`. Moment search goes through the server's full-text index rather than the
loaded feed page, so a match does not depend on what the reader has scrolled.

What is stored never changes shape. On pick, the picker inserts the entity's
canonical token: `[[id]]` for a moment, unchanged per
[ADR-0015](0015-embed-previews-compact-nonrecursive.md), and `::kind:id::` for
everything else. Tokens stay typed and id-addressed; the query text is a search
key at pick time and is discarded. The slash menu keeps working and its picker
is re-backed by the same search core rather than maintained as a second
implementation.

## Rejected

**Storing `[[Title]]` and resolving by title at render.** It reads well in
source, and it is how wikis do it, but it would be the first title-resolved
reference in the codebase: renames would break or silently re-point references,
duplicate titles would need a disambiguation rule, and rendering would need a
resolver endpoint. Id-addressed tokens have none of those failure modes, which
is why ADR-0015 kept them through the last rendering change.

**A universal id-resolver endpoint ("what is this id").** Unnecessary: the
picker knows the kind at insert time and encodes it in the token, so nothing
downstream ever holds a bare id of unknown type.

## Language

The stored thing remains an Embed and the glossary's avoid line stands:
"reference" does not become a proper noun. This ADR changes how an Embed is
written, not what one is.

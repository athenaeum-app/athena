# An Embed can point at a view, not only at an entity

Every Embed so far names one row: a moment, a to-do list, a canvas, a project,
a document. [ADR-0015](0015-embed-previews-compact-nonrecursive.md) settled on
id-addressed tokens and
[ADR-0019](0019-one-picker-every-embed-kind.md) kept them there, rejecting
title resolution outright: an id cannot be renamed out from under a reference
and cannot become ambiguous.

The agenda has no id. It is the answer to "what is due", assembled at read time
from every to-do list and every live project the reader can see, and it is the
answer most worth having inside a daily note or a project brief. Nothing can be
pointed at, because the thing being pointed at is a question.

The decision: a token's second segment may name a *scope* instead of an id,
and the first embeddable view is the agenda, written `::agenda::` for all of it
and `::agenda:tasks::` or `::agenda:projects::` for one half. It is picked from
the same `[[` picker as everything else, from a fixed list of three rather than
from a search, because those three are the whole of what there is.

What this does not change:

- **Ids stay ids.** Every other kind still stores the entity's id, and no
  token resolves by title. This adds a second shape of token, it does not
  loosen the first.
- **A scope is a closed set, not a query language.** The three words are
  written into the pattern that matches the token, so `::agenda:everything::`
  stays text rather than rendering an agenda of nothing. A view embed is a
  name for a screen the app already draws, never a place to smuggle filters
  into a body where nobody can edit them.
- **The picker stays the one door.** A kind whose candidates are a fixed list
  is still a kind: one entry in the registry, badged and grouped like the rest.

## Rejected

**A saved-view entity, so the token could carry an id after all.** It would
have preserved the invariant exactly, at the price of a table, an editor and a
lifecycle for something that has no state: an agenda is not configured, it is
just read. The scope is not user data, it is one of three words.

**Leaving the agenda out and telling people to embed the lists instead.** A
to-do list embed shows one list, undated items included, in list order. The
question the agenda answers spans every list and both modules and sorts by
date. Three list embeds side by side are not that answer, and they are wrong in
a way that is easy to miss.

## Language

The stored thing is still an Embed and its rendering is still a Preview. The
glossary's Embed entry, which defined one as a reference to another entity,
widens to say that an Embed points at an entity or at a view, and gains an
Agenda entry of its own.

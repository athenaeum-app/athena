# Embed previews: compact, non-recursive, per-type interactivity

Embeds (ADR-0013's live-reference tokens) render as **previews** in read mode, with a
deliberately different treatment per type. A **moment embed** (`[[id]]`) renders as a
*compact* card (title plus a flattened plain-text excerpt), and clicking it opens the
read-only **Focused reader**. A **todo embed** (`::todo:id::`) renders as a *live* card
whose items are checkable inline (reusing the existing optimistic mutation); its header
opens the todo board. A **canvas embed** (`::canvas:id::`) renders as a *compact* card
(name + node count) that opens the canvas board. A referenced entity that is deleted or
not permitted renders a subtle "unavailable" chip, never a raw token or a crash. The
same spirit as ADR-0013's deleted-node placeholder.

The load-bearing rule is that **moment previews never recurse**: the excerpt is flattened
text, so a moment embedded inside a moment embedded inside a moment cannot spawn a render
tree, and a cycle (A embeds B embeds A) is structurally impossible rather than defended
against at runtime. The considered alternatives (full inline render capped at depth 1,
or full render with ancestor-ID cycle detection) were rejected because both keep the
recursion and merely bound it, buying richer nested previews at the cost of a subtle
depth/cycle invariant to maintain and unbounded-cost render trees on deep content. The
compact card is cheap, always terminates, and the full render is one click away in the
Focused reader.

The per-type split (compact-and-open for moments/canvases, live-and-interactive for
todos) is intentional rather than an inconsistency: a todo list's value is the checklist,
which is genuinely useful to act on in place, whereas a moment's value is its prose (best
read in the Focused reader) and a canvas's value is spatial (only meaningful on its
board). Moment clicks open the *read-only* reader, not the edit editor, so glancing at a
reference can't fat-finger an edit; the reader's Edit button keeps editing one click away.

This refines ADR-0013 without changing its data model: tokens, storage, live-reference
resolution, and permissions are unchanged. In particular the moment token stays `[[id]]`.
Only its rendering changes, from an inert `#moment-<id>` markdown link (whose click
interceptor was never wired) to a real card component in `MomentBody`, so no data or token
migration is required. The cost accepted is that deeply nested moment references are never
previewed beyond one hop; this is the same "flatten, don't recurse" trade every compact
transclusion makes, and is acceptable because the Focused reader is always reachable.

# Rich embed previews, opt in, capped at one level

[ADR-0015](0015-embed-previews-compact-nonrecursive.md) fixed a moment embed to a compact
card: title plus a flattened plain-text excerpt. It considered "full inline render capped
at depth 1" and rejected it, on the grounds that a depth cap keeps the recursion and
merely bounds it, buying richer previews at the cost of an invariant to maintain and
render trees whose cost follows the referenced content rather than the referencing one.

That reasoning holds for the **default**, and the default does not change. What changes is
that two preferences, both off, can trade it away deliberately: `momentEmbedPreview`
renders a moment reference the way the main column renders it (`MomentBody`, attachments,
link previews), clipped to `momentEmbedPreviewHeight` percent of the window and faded at
the cut; `canvasEmbedPreview` draws a wordless schematic of a canvas reference's board.

The depth cap ADR-0015 declined to maintain is a single flag rather than a counter.
`MomentBody` takes `nested`, set only on the body a preview renders, and a nested body
draws its own `[[id]]` references as the compact card. So there is one rule to hold, not
an arithmetic one: **a preview never contains a preview**. A cycle (A embeds B embeds A)
terminates on the second hop with a card, exactly as it does today with the setting off,
and the cost of a render is bounded by one moment's content rather than by the shape of
the reference graph.

The height clip is what answers the other half of ADR-0015's objection. An unbounded
inline render can be arbitrarily tall no matter how shallow it is; a percentage of the
window is a ceiling the reader sets and can see. Clipping is `overflow: hidden` on a
`max-height`, so nothing below the cut is laid out taller than the frame, and the fade is
drawn only when the content actually overflows, measured rather than assumed.

Off by default because the compact card remains the right default for the reason ADR-0015
gives: a reference is usually a pointer, the Focused reader is one click away, and a
library where every moment references three others should not render nine moments to show
one. Turning it on is a reader's choice about their own library, and it is stored in
client-local preferences like every other reading preference, so it never changes what
anyone else sees.

This supersedes ADR-0015 only on the rendering of previews. Tokens, storage, live-reference
resolution, permissions and the "unavailable" chip are unchanged, as is the per-type split
(todo embeds stay live and checkable, canvas embeds stay a card that opens the board).

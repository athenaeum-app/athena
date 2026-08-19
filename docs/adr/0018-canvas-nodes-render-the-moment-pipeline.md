# Canvas nodes render the moment pipeline

A canvas node was a chip. A text node held a plain string, a `moment-ref` drew a
title over three lines of flattened excerpt, and a `todo-ref` drew a progress bar
you could look at and not touch. Every one of them was a pointer to content that
lived somewhere else, on a surface whose entire purpose is arranging content you
are working with.

Text nodes now run through the same pipeline a moment's body does: `MomentBody`,
so markdown, images and live embeds (`[[id]]`, `::todo:id::`, `::canvas:id::`,
`::project:id::`) all work in a node. Reference nodes render the thing they point
at rather than describing it: a `moment-ref` renders the moment, a `todo-ref` is
checkable in place, and `project-ref` and `canvas-ref` join them as node kinds of
their own.

## What bounds the cost

[ADR-0017](0017-opt-in-rich-embed-previews.md) made the same move for moment
embeds in the feed and made it opt-in, on the grounds that an inline render can
be arbitrarily tall and that a library where every moment references three others
should not render nine moments to show one. Both halves of that objection are
answered differently on a board, which is why this is the default here and not
there.

**Height is already declared.** A node has a width and a height the author dragged
it to. That is not a ceiling the reader has to guess at, it is the statement of
how much of this to show. Content that outgrows it is clipped and faded at the
cut, measured rather than assumed, exactly as ADR-0017's height clip does. It is
never scrolled: a scroller inside a pan/zoom board fights the board for the
wheel, and the resize handle is already the control for "show me more".

**The depth cap is the same one flag.** A body rendered inside a node is `nested`,
so its own `[[id]]` references fall back to the compact card. A preview never
contains a preview, a cycle terminates on the second hop, and the rule to hold is
the one ADR-0017 already defines rather than a second one.

**A board draws all of its nodes at once**, which the feed does not, so two limits
exist that have no counterpart there:

- Text node content is capped at 4000 characters. A node is a card on a board,
  not a document; anything longer belongs in a moment the node can reference.
- A node defers its body until it has been on screen once, and keeps it after.
  Once rather than while: panning away and back would otherwise refetch and flash
  a loading state at every crossing. The cost of opening a board is therefore
  bounded by what is visible on it, not by how much is on it.

Bare-URL link previews stay off inside a node whatever the reader's preference
is: a preview card is wider than most nodes and each one is a fetch.

## Colour

A new text node takes a colour from the node palette at random, so a board of
them reads as a board of separate ideas rather than one block. That made a fixed
dark ink untenable, since half the palette is dark, so the ink follows the fill's
luminance. Markdown carries the theme's own text tones, which were chosen for the
page background and not for a lime or a slate card, so a coloured node overrides
the typography plugin's colour variables with its ink. Embed cards inside a node
are excluded: a card brings its own surface, and keeps the tones that surface was
designed for.

This does not supersede ADR-0017. The default for a moment embed *in a moment*
is unchanged, and so are tokens, storage, live-reference resolution, permissions
and the "unavailable" chip.

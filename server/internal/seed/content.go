package seed

import "fmt"

// This file holds the deterministic moment bodies. They are kept out of seed.go
// so the seeding flow stays readable. Each body exercises specific client
// rendering features (documented inline).

// welcomeBody is the rich-markdown showcase: headings, lists, fenced code
// (including the specially-added luau and gdscript grammars), a table, a
// blockquote, a link that gets a cached preview, and one inline image.
func (s *seeder) welcomeBody() string {
	return fmt.Sprintf(`# Welcome to Athena

Athena is a shared **library of moments**. This entry shows off the markdown the
editor understands.

## Lists

- Bullet one
- Bullet two
  - A nested bullet
1. Ordered first
2. Ordered second

## A table

| Feature   | Status  |
| --------- | ------- |
| Moments   | Ready   |
| Canvas    | Ready   |
| Todos     | Ready   |

## A quote

> "We are what we repeatedly do." (paraphrasing Aristotle)

## Code

A Luau snippet (custom grammar):

`+"```luau"+`
local function greet(name: string): string
    return string.format("Hello, %%s!", name)
end
print(greet("Athena"))
`+"```"+`

A GDScript snippet (custom grammar):

`+"```gdscript"+`
extends Node

func _ready() -> void:
    print("Athena ready")
`+"```"+`

## A link

See the [Roblox Creator Docs](https://create.roblox.com/docs) for more. This
link renders with a preview card.

## An inline image

![A patterned swatch](%s)

Happy exploring!`, s.assetURL("inline-pattern.png"))
}

// embedBody exercises the three live-reference embed tokens (ADR-0013 / 0015):
// a moment cross-reference, a todo embed, and a canvas embed.
func (s *seeder) embedBody() string {
	return fmt.Sprintf(`# Everything wires together

Moments can embed other library entities as live previews.

Here is a **moment cross-reference** to the welcome note:

[[%s]]

Here is a **live todo embed** whose items you can check off inline:

::todo:%s::

And here is a **canvas embed** (opens the board):

::canvas:%s::

All three stay in sync with their source.`, s.welcome.ID, s.todoGeneral.ID, s.canvas.ID)
}

// gallery3Body is three consecutive image lines, which auto-group into a single
// gallery of 3-4 images.
func (s *seeder) gallery3Body() string {
	return fmt.Sprintf(`Some photos from the trip. These three images auto-group into one gallery.

![](%s)
![](%s)
![](%s)

That is the whole set.`, s.assetURL("gallery-1.png"), s.assetURL("gallery-2.png"), s.assetURL("gallery-3.png"))
}

// twoGalleriesBody shows two galleries separated by a --- rule, which forces
// them into two distinct groups.
func (s *seeder) twoGalleriesBody() string {
	return fmt.Sprintf(`**Before:**

![](%s)
![](%s)

---

**After:**

![](%s)
![](%s)`, s.assetURL("split-a1.png"), s.assetURL("split-a2.png"), s.assetURL("split-b1.png"), s.assetURL("split-b2.png"))
}

// inlineImageBody is a single captioned inline image surrounded by prose.
func (s *seeder) inlineImageBody() string {
	return fmt.Sprintf(`I kept coming back to this pattern, so here it is on its own.

![A diagonal two-tone pattern](%s)

A single inline image renders at full width with its caption underneath.`,
		s.assetURL("inline-pattern.png"))
}

// mediaBody links every non-image attachment type. Non-image
// assets are inserted as ordinary markdown links; the client swaps in the right
// preview (PDF iframe, <audio>, <video>, or a generic file chip) based on the
// asset's mime type.
func (s *seeder) mediaBody() string {
	return fmt.Sprintf(`This moment attaches one of every previewable file type.

- PDF (renders in an iframe): [demo-brief.pdf](%s)
- Audio (renders in an <audio> player): [chime.wav](%s)
- Animated image (renders inline): [loader.gif](%s)
- Generic file (renders as a download chip): [bundle.zip](%s)

Note: a true <video> preview needs a committed binary MP4 (a valid MP4 cannot be
synthesised programmatically), so the seeder ships the animated GIF above to
cover motion media instead.`,
		s.assetURL("demo-brief.pdf"),
		s.assetURL("chime.wav"),
		s.assetURL("loader.gif"),
		s.assetURL("bundle.zip"))
}

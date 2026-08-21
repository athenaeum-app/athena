# The planner is one surface, scoped, not one per module

The Projects overview grew a good screen: a fortnight of day columns, a month
you drag work onto, a plain grouped list, and a tray of everything with no date
yet. It was seven hundred lines inside `ProjectsModule.tsx`, typed to
`ProjectDeadline`, and unreachable from anywhere else.

The Tasks module had its own answer to the same question, written earlier and
smaller: a grouped list of what was due, no month, no tray, nothing to drag.
Which meant a task belonging to no project (a chore, an errand, a renewal) had
nowhere to be planned at all: the only way to give one a date was to open the
item and type one.

The two had already started to disagree. The Tasks agenda refused to tick a
project row, on the stated grounds that finishing project work belongs on the
board; v2.30.0 dropped exactly that rule on the Projects side. The same row
offered a tick in one place and withheld it in the other, and neither screen
was wrong on its own terms. That is what a second implementation buys, and it
was going to keep happening.

The decision: there is one planner. It is a component over one row type
(`PlannerRow`), both modules map onto it, and which work it draws is a *scope*
rather than a separate screen. The scopes are the three an agenda embed already
uses (ADR-0021): everything, tasks only, project work only.

A row keeps what every row needs (what it is, when it is due, how urgent) and
names the rest for the question rather than for either module: where it lives
is a `homeId` and a `homeTitle`, which is a project for a card and a list for a
task. That one rename is most of what made a shared surface possible, and it is
the part worth defending: a column holding a chore and a milestone cannot ask
each row which module it came from.

What follows from it:

- **One tick rule.** Work is finished wherever it is listed. The rule that made
  the two screens disagree is gone rather than reconciled.
- **A host decides what a row *does*, never how it looks.** Opening a card, a
  board and a to-do list are three different acts, so the host supplies them,
  along with its own word for "where this lives" (Project, or List). Nothing
  about a day, a drop or a container is a host's business.
- **Both modules keep their own settings.** A portfolio screen and the place
  the shopping lives want arranging differently, so the view, the direction,
  the sort and the scope are stored per surface, not shared.

## Rejected

**Copying the surface into the Tasks module.** It would have shipped sooner and
left two implementations of "drag a thing onto a day", which is the situation
this replaces rather than a way out of it.

**A third top-level module for planning.** One screen for everything dated is
tempting and defensible, but it takes a view away from each module that has one
today, and it puts what is due behind a door you have to learn. The scope does
the same work without moving anything.

**A per-module row type with a shared component generic over it.** The
components would have needed an accessor per field, which is the same coupling
with more ceremony. A row that both sides construct is simpler to read and the
adapters are where the module-specific knowledge belongs.

## Language

The Tasks module's second view is the **Planner**, not the Agenda. An Agenda is
what is due (GLOSSARY.md), and half of what this surface holds has no date yet:
the tray is the point of it. The Projects overview keeps calling its own the
agenda, because there it is one, drawn by the same component with the tray
under it.

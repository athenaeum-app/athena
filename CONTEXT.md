# Athena

A self-hosted library server (moments, tags, archives) with shared modules:
to-do lists, canvases, and the Projects module under design.

## Language

### Projects module

**Project**:
A long-running effort (a game, a course, a launch) tracked as milestones and
cards. Owns its cards outright; it is not a view over the Tasks module.
_Avoid_: board, workspace

**Milestone**:
An ordered column of cards inside a project, optionally dated. Order is the
roadmap: left to right is the plan.
_Avoid_: stage, phase, sprint, list

**Card**:
One unit of work inside a project, from a one-liner to a full document. Belongs
to exactly one milestone, carries a priority, and drags within and across
milestones.
_Avoid_: task (that word belongs to the Tasks module), item, ticket

**Card body**:
A card's optional markdown document. Written through the same editor a moment
uses and embeds live content the same way: to-do lists, canvases, moment
links, projects.
_Avoid_: notes, description

**Project embed**:
`::project:id::` in any moment-pipeline text renders a summary card of that
project: completion meter in its accent, an excerpt of the overview, and the
open/done counts.

**Priority**:
None, Low, Med, or High on a card. Shared vocabulary with the Tasks module;
feeds sorting and the progress graphics.

**Portfolio**:
The Projects landing screen showing every live project's state at a glance,
with archived projects in a collapsed shelf.
_Avoid_: dashboard, overview

**Dismiss**:
Shelving a card without deleting it. Undoable in a deep Ctrl+Z stack and
permanently recoverable from the graveyard.
_Avoid_: delete, remove, cancel

**Graveyard**:
The per-project record of dismissed cards, restorable any time.
_Avoid_: trash, bin

**Archive**:
Shelving a whole project off the portfolio grid, restorable from the shelf.
_Avoid_: delete, close

**Hub**:
A single project's screen: its brief, milestones, cards, and documents.
_Avoid_: board, detail view

**Brief**:
The overview tab's markdown body: the project's current-state summary, written
through the moment pipeline. This is the field the overview tab used to head
"Document"; that word now names a different thing, so the heading follows.
_Avoid_: document (that is a Documents-tab entity), summary, readme

**Document**:
A project-owned unit of durable reference content: decisions, research,
resources. Composed and rendered exactly the way a moment is, but it is its own
entity, not a moment: it lives in the project, never in an archive or the
journal feed, is never "done", carries no priority, and cannot be dismissed. It
dies only by deliberate delete.
_Avoid_: moment, note, page, wiki

**Folder**:
A named container in a project's Documents tab. Holds documents and other
folders, nesting without limit; a document lives in exactly one folder, or at
the tab's root. Deleting a folder deletes its contents recursively, behind a
confirm that states the count, and the deletion is undoable.
_Avoid_: archive (that is the moments container), directory, category

**Document version**:
A snapshot of a document's title and body, taken manually or automatically on
meaningful edits, viewable and restorable any time. Restoring snapshots the
current state first, so a restore is itself undoable.
_Avoid_: revision, backup, history entry

**Document status**:
Draft, Final, or Locked on a document. Locked refuses title and body edits
until unlocked; it is the badge for "this decision is decided".
_Avoid_: state, stage

**Comment**:
A remark hung off one block of a document: a paragraph, a heading, a list, a
code sample, never a stretch of characters. Threads are one level deep, resolve
when they are settled, and can be deleted. A comment never changes the document
it is about, so a locked document still takes them; when the block it was left
on is gone, the comment says it is orphaned rather than moving somewhere else.
_Avoid_: annotation, suggestion, feedback, review

**Document embed**:
`::doc:id::` in any moment-pipeline text renders a compact preview card of that
document: its title and an excerpt. Clicking opens the document in its
project's Hub.

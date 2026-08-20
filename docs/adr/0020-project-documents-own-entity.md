# Project documents are their own entity

Projects needed a home for durable reference content: design decisions,
research, resources. The overview body is the project's current-state summary
and a card is a unit of work with a done-state, a priority, and a graveyard, so
reference material stuffed into either ends up somewhere with the wrong
lifecycle. The obvious candidate for the new home was the Moment.
[ADR-0018](0018-canvas-nodes-render-the-moment-pipeline.md) even calls the
moment the document primitive: "anything longer belongs in a moment".

The decision: a Document is its own entity in a `project_documents` table owned
by the project, sharing the moment *pipeline* (the same composer writes it, the
same renderer draws it, the same embed tokens work inside it) but not the
moment *entity*.

Reusing the entity fails on structure and on lifecycle:

- A moment must live in exactly one archive and dies with it on cascade.
  Project documents would either squat in hidden system archives, one per
  project, or inherit a deletion path no project owner ever chose.
- A moment is a journal entry: timestamp-stream identity, tags, pins,
  full-text feed search, soft-delete with pruning. Durable reference content
  wants none of that machinery, and hiding it is harder than not having it.
- Archives are flat by glossary law, and documents need folders.

The precedent is the one this module already set for cards: "Owns its cards
outright; it is not a view over the Tasks module." A project owns its
documents outright; the Documents tab is not a view over the Moments module,
and a document never appears in the journal feed or its search.

## Consequences

- Folders nest without limit via `parent_id`, the first unbounded tree in the
  app (todo subtasks cap at one level by convention).
- Deletion is hard and recursive, per
  [ADR-0010](0010-soft-delete-prune-vs-hard-delete-audit.md)'s rule that
  structural entities cascade rather than soft-delete. The confirm states the
  count, and the delete response returns the deleted subtree so the client's
  undo stack can restore it with identity intact.
- Version snapshots (a `project_document_versions` table) stand in for the
  safety net that soft delete gives moments.
- Documents become the fifth embed kind, `::doc:id::`, and a search target of
  the picker in [ADR-0019](0019-one-picker-every-embed-kind.md).

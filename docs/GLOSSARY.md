# Athena domain glossary

The vocabulary used throughout the codebase, the API, and the UI. Where a term
has an obvious synonym that is *not* used here, the _Avoid_ line records it. If
two names for one concept end up in the code, this file decides which one wins.

A **library** is one server ([ADR-0004](adr/0004-one-server-one-library.md));
everything below lives inside a single library.

## Core domain

**Library**:
The complete body of content hosted by a single Athena server: all archives,
moments, tags, chat, and assets. One server hosts exactly one library.
_Avoid_: workspace, project, collection.

**Server**:
A running instance of the Athena backend. Hosts one library and serves the PWA
client on the same origin. Each server is an independent identity island with its
own user accounts, roles, and settings.
_Avoid_: instance, node, host.

**Archive**:
A user-named container for moments within a library. Every Moment lives in
exactly one. Archives are not nested.
_Avoid_: folder, category, collection, notebook.

**Moment**:
A single journal entry: a titled piece of Markdown content with a timestamp, an
author, optional tags, and optional attachments. The primary unit of content in a
library.
_Avoid_: entry, post, note, page.

**Tag**:
A user-created label with a name and color, applicable to any moment in the
library. Tags are global to the library, not scoped to an archive.
_Avoid_: label, category, topic.

**Asset**:
A file (image, video, PDF, audio) uploaded to the server and referenced by URL
within moment content. Tracked by an `assets` row; stored on local disk under an
opaque UUID filename.
_Avoid_: attachment, file, upload, media.

**Tag graph**:
Whole-library counts of how often each tag is used, how often each pair of tags
shares a moment, and how often each tag is used inside each archive. The composer
ranks its tag suggestions from it, so picking one tag brings the tags most often
filed alongside it to the front, and choosing an archive sinks the tags that
archive has never carried. Always computed over the entire library, never the
loaded feed page or the reader's current filters. The per-archive slice is not an
exception to that: it is keyed by the archive a moment is being filed into, which
the writer chose, not the one they happen to be reading.
_Avoid_: tag affinity, related tags, co-occurrence matrix.

**Link preview**:
Server-side-scraped metadata (title, description, image) for a URL referenced in
moment content. Cached in the `link_previews` table with a TTL. Rendered either
as a stack of cards after the body (the default) or, with the inline preference
on, in place of the URL that produced it, with the content resuming below.
Inline placement only applies to a bare URL: one written as `[label](url)` keeps
its label and its card goes in the stack, because replacing that text would
destroy the link. Distinct from an Embed, which references another entity in
this library rather than an external page.
_Avoid_: embed, card, unfurl.

**Chat message**:
A message in the library-wide chat. Authored by a user; legacy (v1-imported)
messages may carry a `display_name` instead of an author. A message may answer
another, which makes it a Reply.
_Avoid_: buffer message, post.

**Reply**:
A Chat message that points at the one it answers, by id. It is drawn under a
single line naming that message, which leads back to it. The link is one level
and never a tree: a reply may answer a reply, and the line still shows only the
message directly answered. Nothing of the answered message is copied into the
reply, so the line says what that message says now, and reads as a tombstone
once it is deleted. Distinct from a project document comment thread, which is a
`parent_id` tree capped at one level of nesting.
_Avoid_: quote, thread, mention.

**Todo list**:
An embeddable checklist of items. A list is either `daily` (unchecks itself each
cycle, either at midnight or 24 hours after each tick, and never deletes) or
`general` (long-lived, multiple named lists, with a broom that deletes the
completed ones). Its items are Tasks: they carry a priority, one level of
subtasks, and an optional link to a Moment; on a general list they add a due
date and recurrence. See
[ADR-0013](adr/0013-server-synced-embeddable-modules.md).
_Avoid_: task list, checklist (as a proper noun), agenda (that is the view of
what is due across every list and project, not one list).

**Task**:
One item on a Todo list: a line of text that is ticked off, carrying a priority,
one level of subtasks, and (on a general list) a due date and a recurrence. This
is the word the Tasks module uses for its own rows and the word the Agenda uses
for them; a project's unit of work is a Card, and the two are kept apart on
purpose.
_Avoid_: card, todo, entry, ticket.

**Canvas**:
An embeddable free-form board: an infinite pan/zoom surface holding freely
positioned nodes (text, sticky, shape, image, link, and the Reference nodes)
joined by edges. Unlike a Moment it has no linear structure. See
[ADR-0013](adr/0013-server-synced-embeddable-modules.md).
_Avoid_: board, whiteboard, corkboard, diagram.

**Text node**:
A Canvas node whose content is written and rendered the way a Moment's body is:
markdown, images and Embeds, capped at 4000 characters. A new one takes a
colour off the node palette. The plain-scribble node is the sticky. See
[ADR-0018](adr/0018-canvas-nodes-render-the-moment-pipeline.md).
_Avoid_: note, label, card.

**Reference node**:
A Canvas node that points at another entity by id and renders its current state:
`moment-ref` renders the Moment's body, `todo-ref` a checkable list, and
`project-ref` and `canvas-ref` a summary. The node's box is the clip: content
that outgrows it is faded off, never scrolled. The header opens the real thing.
_Avoid_: link node (that is the URL node), card, embed node.

## Embeds

**Embed**:
An inline reference to another entity (a Moment, Todo list, Task, Canvas,
Project, project Card or Document) or to a view (the Agenda), written as a token
inside a Moment's or chat message's body and rendered as a Preview in read mode.
Eight kinds exist; each renders and behaves differently. Every kind but the
Agenda addresses one row by id; the Agenda's token carries a scope, because what
it points at is a question rather than a row. See
[ADR-0021](adr/0021-embeds-can-point-at-a-view.md).
A Canvas text node runs the same pipeline, so the same tokens work there.
_Avoid_: link, mention, transclusion, reference (as a proper noun). A moment
Embed is still an Embed even though its token looks like a wiki-link.

**Preview**:
The inline rendered representation of an Embed shown in read mode. A Preview is
either _compact_ (title + summary, click to open) or _live_ (interactive inline).
It never recurses: a Moment Preview shows a flattened excerpt, not a nested
render, so cycles are structurally impossible. See
[ADR-0015](adr/0015-embed-previews-compact-nonrecursive.md).
_Avoid_: card, thumbnail, snippet (these are visual treatments of a Preview, not
the term).

**Moment embed**:
An Embed of a Moment. Renders as a _compact_ Preview (title + excerpt); clicking
opens the Focused reader.

**Todo embed**:
An Embed of a Todo list. Renders as a _live_ Preview whose items can be checked
inline; clicking the header opens the todo board.

**Canvas embed**:
An Embed of a Canvas. Renders as a _compact_ Preview (name + node count);
clicking opens the canvas board.

**Project embed**:
An Embed of a Project. Renders as a _compact_ Preview: a completion meter in the
project's accent, an excerpt of the overview, and the open/done counts. Clicking
opens the project's Hub.

**Agenda**:
Everything open with a due date on it, wherever it lives: dated Todo list items
and the dated cards and milestones of every live Project, in one run sorted by
date and then by priority, grouped under Overdue, Today, Tomorrow, This week
and Later. It is a view, not a stored thing: nothing is filed on the Agenda,
things simply have dates. It is what the Planner draws on its days, and it is
embeddable on its own.
_Avoid_: schedule, calendar, due list. Distinct from the Planner, which also
holds the undated.

**Planner**:
The surface that answers when work is happening: a fortnight of day columns, a
month to drag onto, the same rows as a grouped list, and a tray of everything
with no date yet. One component draws it for both modules, over one row type,
and which work it holds is a scope (everything, tasks, project work) rather
than a separate screen. See
[ADR-0022](adr/0022-one-planner-two-modules.md).

The Tasks module's second view is called the Planner. The Projects overview's
is called its agenda, because there everything on it is dated; the tray sits
under it either way.
_Avoid_: schedule, timeline (that is one of its views), agenda (an Agenda is
what is due, and half of a planner has no date yet).

**Container** (on the planner):
A row that holds other rows rather than being work itself: a Milestone, or a
Todo list on a day several of its Tasks fall on. Drawn with its own surface,
its title in its colour, and a meter counting what is finished as well as what
is not. A container is never ticked off (its contents finish it) and a list
container is never dragged (it has no date of its own).

**Agenda embed**:
An Embed of the Agenda. Renders as a _live_ Preview: the same groups, capped
with a count of what was left off, to-do rows tickable inline and project rows
opening their project. Token: `::agenda::` for all of it, `::agenda:tasks::`
or `::agenda:projects::` for one half.

**Task embed**:
An Embed of one Task, rather than of the list holding it. Renders as a _live_
Preview: one row carrying a tick, the task's text, the list it came off and its
due date, overdue in the danger colour. The tick writes through both ways, and
the row stays after it is ticked rather than dropping off the way an Agenda row
does, because a note explaining what it was waiting on is worth reading once the
waiting is over. Token: `::task:id::`.

**Card embed**:
An Embed of one project Card (see `CONTEXT.md` for the Projects language).
Renders the same _live_ row a Task embed does, in the project's accent, saying
which project and milestone the card sits in; clicking opens the project.
Token: `::card:id::`.

**Document embed**:
An Embed of a project Document (see `CONTEXT.md` for the Projects language).
Renders as a _compact_ Preview (title + excerpt); clicking opens the document in
its project's Hub. Token: `::doc:id::`.

**Focused reader**:
The read-only expanded view of a single Moment (large, centered, full body +
attachments + link previews, with an Edit button). The expanded view a Moment
embed opens.
_Avoid_: detail modal, moment viewer, preview modal.

## Images

**Gallery**:
A run of consecutive image embeds in a Moment's body, rendered as one swipeable
inline group instead of stacked images. The run is broken by intervening text or
a `---` thematic break; each break starts a new Gallery (or a standalone image).
_Avoid_: carousel, slideshow, grid.

**Lightbox**:
The focused image viewer opened by clicking any content image: fit/zoom/pan,
filename caption, download, and arrow/swipe navigation across every image in that
Moment.
_Avoid_: image modal, viewer, preview.

## Formatting

**Inline formatting**:
Author-applied emphasis beyond standard markdown, written in the source as
`==text==` (highlight), `++text++` (underline), and `[text]{color=name}` with
six preset names (red, orange, yellow, green, blue, purple). Rendered as
theme-aware styling by the moment pipeline, so it works anywhere a moment's
body renders and stays plain text everywhere else.
_Avoid_: rich text, WYSIWYG, markup (as a proper noun).

## Identity and access

**User**:
A person with an account on a server. Has a username, password, and zero or more
roles. Per-server: there is no central or shared identity across servers.
_Avoid_: account, member, profile.

**Owner**:
The first user to register on a server. Holds the Owner role, which cannot be
removed or transferred. There is always exactly one owner per server.
_Avoid_: admin, superuser, root.

**Role**:
A named bundle of permission flags assigned to users. Users can hold multiple
roles; their effective permissions are the union of all their roles' flags. Roles
have a position for display ordering.
_Avoid_: group, rank, permission set.

**Member** (role):
The default role every user on a server automatically holds. Cannot be removed
from a user. Owner-editable; defines the baseline capabilities of any new user.
_Avoid_: @everyone, default role, base role.

**Preset role**:
A role that ships with every server (Owner, Admin, Editor, Viewer). Editable
except for Owner. Distinguished from custom roles by an `is_preset` flag.
_Avoid_: built-in role, system role.

**Permission**:
A single fine-grained boolean capability (for example `CREATE_MOMENT`,
`DELETE_ANY_MOMENT`, `MANAGE_USERS`). Represented as a bit in an integer stored
per role. See
[ADR-0009](adr/0009-fine-grained-permissions-multi-role.md).
_Avoid_: capability, right, privilege.

**Invite**:
A single-use (or N-use) token generated by a user with `MANAGE_USERS`. New users
register by consuming an invite link or code. Registration is invite-only; there
are no open signups. See
[ADR-0005](adr/0005-invite-based-self-registration.md).
_Avoid_: invite code (as a proper noun), registration token.

**Session**:
A server-side record representing an authenticated user's login. Referenced by an
httpOnly cookie; may have a sliding 30-day expiry or be permanent ("stay logged
in"). Revocable on logout. See
[ADR-0008](adr/0008-session-cookies-not-jwt.md).
_Avoid_: token, login, JWT.

## Sync and history

**Library version**:
A monotonically increasing integer representing the cumulative state of the
library. Bumped on every mutation. Used by clients to request deltas: "give me
everything since version X".
_Avoid_: revision, sequence, epoch.

**Event**:
A record in the `events` table describing a single mutation (create, update, or
delete of a resource). Clients consume events to stay current without re-fetching
the full library. See
[ADR-0007](adr/0007-delta-sync-versioned-events.md).
_Avoid_: change, delta, log entry.

**Audit log**:
A durable record of who did what, for accountability. Distinct from the event
stream, which exists for sync and is pruned aggressively; the audit log is
detailed and retained longer. See
[ADR-0010](adr/0010-soft-delete-prune-vs-hard-delete-audit.md).
_Avoid_: history, activity log.

**Legacy**:
A flag on moments and chat messages indicating the content was imported from a v1
server. Legacy moments are authored by the owner; legacy chat messages retain
their original `display_name`, which is the only record of who wrote them.
Badges for legacy content are toggleable per content type in server settings.
Nothing in the tree sets the flag any more: the v1 importer was personal to one
operator and no longer ships here, so this describes data that already exists in
a migrated library rather than anything a new server can produce.
_Avoid_: imported, v1, old.

## Client

**PWA**:
A Progressive Web App served by the Athena server on the same origin as the API.
Installable on desktop and mobile, works in any browser. See
[ADR-0002](adr/0002-server-bundled-pwa-client.md).
_Avoid_: web app, frontend, UI.

**Launcher**:
The Electron application that loads the PWA at a user-configured server URL. A
multi-server shell holding several server profiles at once and switching between
them. It has no data-access layer of its own. Each connection is an isolated PWA
view. See [ADR-0012](adr/0012-multi-server-desktop-client.md).
_Avoid_: desktop app, Electron app, wrapper.

**Server profile**:
A locally stored entry in the launcher's server rail: a server URL plus a display
name, with its own origin and session. The launcher keeps an ordered list of
them; the PWA has no concept of profiles.
_Avoid_: account, connection, workspace.

## Appearance

**Appearance**:
The whole client visual and UX surface: color theme, look, layout, libraries
placement, font, UI scale, animations. Treated as one unit for
global-versus-override purposes.
_Avoid_: theme (that is one axis of Appearance, not the whole thing), styling,
skin.

**Theme**:
A named color scheme applied via a `data-theme` attribute on the root element.
Eleven themes ship as defaults; users can create their own, stored in the browser
and shareable as an import/export string. The theme system defines CSS variables
for background, element, text, and highlight colors.
_Avoid_: skin, color scheme, mode.

**Look**:
A named typography and spacing treatment applied via a `data-look` attribute,
orthogonal to Theme. Six presets ship, plus a custom-look editor.
_Avoid_: style, variant, density.

**Global default**:
The single Appearance shared across every server, held by the desktop shell. The
baseline every server inherits unless it has an Override. See
[ADR-0016](adr/0016-appearance-global-with-per-server-overrides.md).
_Avoid_: base theme, root theme, default profile.

**Override**:
A per-server (or per-archive) deviation from the Global default, specified per
setting. Resolution is innermost-wins: archive override, then server Override,
then Global default.
_Avoid_: custom theme, local theme, exception.

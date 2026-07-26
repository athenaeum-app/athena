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

**Link preview**:
Server-side-scraped metadata (title, description, image) for a URL referenced in
moment content. Cached in the `link_previews` table with a TTL.
_Avoid_: embed, card, unfurl.

**Chat message**:
A message in the library-wide chat. Authored by a user; legacy (v1-imported)
messages may carry a `display_name` instead of an author.
_Avoid_: buffer message, post.

**Todo list**:
An embeddable checklist of items. A list is either `daily` (unchecks itself each
cycle, either at midnight or 24 hours after each tick, and never deletes) or
`general` (long-lived, multiple named lists, with a broom that deletes the
completed ones). Items carry a priority, one level of subtasks, and an optional
link to a Moment; general-list items add a due date and recurrence. See
[ADR-0013](adr/0013-server-synced-embeddable-modules.md).
_Avoid_: task list, checklist (as a proper noun), agenda.

**Canvas**:
An embeddable free-form board: an infinite pan/zoom surface holding freely
positioned nodes (moment-ref, text, image, sticky, shape, link, todo-ref) joined
by edges. Unlike a Moment it has no linear structure. See
[ADR-0013](adr/0013-server-synced-embeddable-modules.md).
_Avoid_: board, whiteboard, corkboard, diagram.

## Embeds

**Embed**:
An inline reference to another entity (a Moment, Todo list, or Canvas), written
as a token inside a Moment's or chat message's body and rendered as a Preview in
read mode. Three kinds exist; each renders and behaves differently.
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

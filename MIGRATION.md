# Migrating from athena-server (v1) to athenaeum (v2)

Migration is a one-shot import of a v1 SQLite database and uploads directory
into a fresh v2 server. It's performed by the `migrate` subcommand on the
`athena-server` binary (`server/cmd/athena-server/migrate.go`). See
`docs/GLOSSARY.md` ("Migration" entry) and `docs/adr/0001-big-bang-greenfield-rewrite.md`
for the rationale behind doing this as a big-bang rewrite instead of an
incremental migration.

## Before you start

- **Back up v1 data**: copy `athena-server/data/athenaeum.db` and
  `athena-server/data/uploads/` somewhere safe. The migrate command only
  reads from v1, but back up anyway.
- **v2 must already have an owner account.** Migrated moments and assets are
  attributed to the server owner (`users.is_owner = 1`), so you must complete
  v2's first-time setup (register the first user) *before* running migrate.
  Migration will refuse to run otherwise.
- **v2's database must be empty.** The command refuses to run if the v2
  `archives`, `moments`, `chat_messages` or `assets` tables already have rows,
  so it can't be run twice into the same database or over a server that
  already has real v2 content.

## Steps

1. Start the v2 server and complete first-time setup to create the owner
   account, then stop it so nothing else writes to the v2 DB during migration:
   ```bash
   cd athena
   docker compose up -d
   # visit http://localhost:8080, register the owner account
   docker compose down
   ```

2. Build the server binary and run `migrate`, pointing at v1's data files and
   v2's data directory (default `athenaeum/data/`):
   ```bash
   cd athena/server
   go build -o athena-server.exe ./cmd/athena-server
   ./athena-server.exe migrate \
     --v1-db="../../athena-server/data/athenaeum.db" \
     --v1-uploads="../../athena-server/data/uploads" \
     --v2-db="../data/athenaeum.db" \
     --v2-uploads="../data/uploads"
   ```
   This prints a row-count summary (archives, tags, moments, moment_tags,
   chat_messages, assets copied/skipped, asset links rewritten) when done.

3. Restart v2 and confirm archives, moments, tags, chat messages, and files
   show up, marked as legacy:
   ```bash
   docker compose up -d
   ```

## What gets migrated

| v1 table | v2 table | Transform |
| --- | --- | --- |
| `archives` (non-deleted) | `archives` | unchanged shape |
| `tags` (non-deleted) | `tags` | `colour` → `color`; `updated_at` reused for both v2 timestamps if v1 has no `created_at` |
| `moments` (non-deleted) | `moments` | `author_id` = owner's user id, `is_legacy` = 1 |
| `moment_tags` | `moment_tags` | re-checks both sides aren't soft-deleted; `INSERT OR IGNORE` |
| `buffer_messages` (non-deleted) | `chat_messages` | `author_name` → `display_name`, `author_id` = NULL, `is_legacy` = 1 |
| v1 uploads directory | `assets` + v2 uploads dir | every file is copied and renamed to a new UUID; `uploader_id` = owner's user id; `mime_type` guessed from the extension; `file_name` taken from the v1 `assets` row if one exists, else recovered from the on-disk name by dropping v1's upload-timestamp prefix |

Assets are migrated from the uploads **directory**, not from v1's `assets`
table. v1 created that table but its upload handler never wrote to it. Files
went straight to `data/uploads/` and the URL was embedded in the content, so
on a real v1 server the table is empty.

Because each file gets a new id, the URLs embedded in moment and chat content
are rewritten to match. v1 stored them as absolute URLs against whatever
address the old server was reachable at (`http://host:8080/uploads/<file>`);
those become `/api/v1/assets/<new-id>`. v1 embedded a bare URL and rendered any
bare media link as an attachment, whereas v2 renders markdown and only shows an
image for image syntax, so bare references are wrapped: `![name](url)` for
images and `[name](url)` for everything else. A reference already sitting in a
markdown destination keeps its syntax and only has the URL swapped, and a
reference whose file isn't in the uploads directory is left exactly as it was
rather than being repointed at an asset that doesn't exist.

Not migrated (no v1 equivalent): `users`, `roles`, `user_roles`, `invites`,
`sessions`, `link_previews`, `events`, `audit_log`, `library_meta`, `settings`.
These are new in v2 and start empty.

## Known issues fixed in this codebase

The `migrate` command originally had two bugs, fixed 2026-07-23:

- `migrateAssets` inserted `uploader_id=""`, but `assets.uploader_id` is
  `NOT NULL` with a foreign key to `users(id)`, and the v2 DB opens with
  `foreign_keys` enforcement on. This crashed on the first migrated asset
  whenever a server actually had uploaded files.
- `migrateMoments` hardcoded `author_id=NULL`, contradicting
  `docs/GLOSSARY.md`, which specifies migrated moments should be "authored by
  the owner."

Both now resolve the v2 owner's user id (`SELECT id FROM users WHERE
is_owner = 1`) before migrating and use it for `moments.author_id` and
`assets.uploader_id`. If no owner account exists, `migrate` now fails with an
explicit error instead of a foreign-key constraint violation.

- All four timestamp-copying steps (`archives`, `tags`, `moments`,
  `chat_messages`) wrote the v1 timestamp column through as a raw string,
  fixed 2026-07-24. SQLite stores `DATETIME` columns as TEXT and compares
  them byte-wise for `ORDER BY`. Live v2 writes bind a Go `time.Time`, which
  the `modernc.org/sqlite` driver formats as `"2006-01-02 15:04:05.999999999
  -0700 MST"` (space-separated, zone name); the migrated rows kept whatever
  string format v1 used (e.g. RFC3339, `T`-separated). Those two encodings
  only diverge partway through the string, so cross-day comparisons still
  came out right, but a legacy message and a new message landing on the same
  calendar date could sort in the wrong order. The symptom was legacy and
  new chat messages (and moments) shifting/swapping order after migrating.
  `migrate` now parses every v1 timestamp into a `time.Time`
  (`parseV1Timestamp`) and binds that, so migrated rows are written with the
  same encoding as live rows.

- No uploaded file was ever migrated, and every legacy image was broken on the
  new server, fixed 2026-07-24. `migrateAssets` drove off the v1 `assets`
  table, which v1 created but never wrote to: its upload handler saved files
  to `data/uploads/` and returned a URL that the client embedded directly in
  the content. So the query returned no rows, the summary honestly reported
  "0 copied", and the files stayed behind on the old server. Even where a v1
  database did have `assets` rows, files were renamed to fresh UUIDs while the
  URLs in the content were left pointing at `/uploads/<old-name>`, a path v2
  does not serve.

  `migrate` now walks the uploads directory, so what is on disk is what gets
  migrated, and rewrites the references in moment and chat content to the v2
  asset URLs (see "What gets migrated" above).

  If you already migrated with an older build, see "Repairing a library
  migrated before the fix" below.

## Repairing a library migrated before the fix

A server migrated before 2026-07-24 has no uploaded files and every legacy
image is broken. Re-running `migrate` is not the answer for a server that has
been in use since: it refuses to write into a populated database, and starting
over would discard everything created natively in v2.

`repair-legacy-assets` fixes such a library in place. Keep the original v1
uploads directory around. It is the only copy of those files.

```bash
docker compose stop            # stop writes first

athena-server repair-legacy-assets \
  --db=/app/data/athenaeum.db \
  --uploads=/app/data/uploads \
  --v1-uploads=/path/to/v1/uploads \
  --dry-run                    # preview; drop this flag to apply

docker compose start
```

It imports only the files the library's content still refers to, gives each one
a v2 asset row, and repoints the references, the same rewriting `migrate` now
does. Everything else is left alone: content with no legacy reference is not
touched, a reference whose file is no longer on disk is left as-is rather than
repointed at an asset that doesn't exist, and v1 files nothing points at stay
in v1 (the run reports how many). It is safe to run twice. Once a library is
repaired there are no legacy references left to match.

Back up `athenaeum.db` before running it, as with any in-place repair.

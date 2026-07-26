# AGENTS.md

Guidance for AI coding agents working in this repository. Humans should read
[CONTRIBUTING.md](CONTRIBUTING.md) first; this file covers the same ground more
directly, plus the things that are easy to get wrong here.

## Commands

Run these from the repository root. CI runs all of them and will reject a pull
request if any fail.

```bash
npm install          # installs client/ and electron/ dependencies too
npm run dev          # Go server + client hot reload + desktop launcher
npm run dev:web      # client only, against the Go server, in a browser
npm run demo         # wipe the local database and seed a populated library

npm run typecheck    # tsc --noEmit over the client
npm test             # client unit tests + go test ./...
npm run e2e          # Playwright critical path

cd server && gofmt -l .    # must print nothing
cd server && go vet ./...
```

`npm run demo` destroys the local database. Never run it against anything
holding real data.

## The thing that catches everyone

**`vite build` writes the client into `server/client/web/`, and the Go binary
embeds that directory at compile time.** There is no separately hosted frontend.

So if you change client code and then test the compiled server binary without
rebuilding the client first, you are looking at a stale bundle and your change
appears to have done nothing. Rebuild the client, then the server.

## Layout

```
server/     Go backend: HTTP API, SQLite, migrations, embedded PWA
client/     SolidJS PWA (Vite + Tailwind), builds into server/client/web
shared/     OpenAPI spec and generated TypeScript types
electron/   Multi-server desktop launcher
docs/       Glossary, ADRs, screenshots
```

The Go module is `github.com/athenaeum-app/athena/server`.

## Conventions

**Naming.** [`docs/GLOSSARY.md`](docs/GLOSSARY.md) is the authority on domain
vocabulary. If you add a concept, add it there. If you touch an existing one,
use the name the glossary uses. The `_Avoid_` lines are binding, and they exist
because two names for one thing is how a codebase rots.

**Identifiers are spelled out.** Prefer `archive` over `a`, `textarea` over
`ta`, `selectSQL` over `q`. Loop counters, `err`, `ok`, method receivers, and
conventional geometry and colour maths (`dx`, `dy`, `r`, `g`, `b`) stay short.
Go error values keep the standard `Err` prefix, matching `sql.ErrNoRows`.

**Punctuation is plain ASCII.** No em dashes or en dashes anywhere: code,
comments, docs, or commit messages. Use a comma, a colon, or a full stop. CI
fails the build on either character. Rewrite the sentence rather than
substituting the punctuation.

**Comments explain why, not what.** `server/internal/storage/mime.go` is the
model: it records that the alpine runtime image ships no `/etc/mime.types`, so
Go's built-in table is all there is, which is why the media types are declared
by hand. Do not narrate what the next line already says.

**No section-number references.** Do not cite plan documents or numbered
sections in comments. Cite an ADR, or state the fact outright. Comments
pointing at documents that are not in the repository are worse than no comment.

**Line endings.** `.gitattributes` normalizes everything to LF. On Windows, let
Git handle it rather than forcing CRLF in your editor, or `gofmt -l` will flag
files nobody touched.

**Permission bits are additive.** They are never renumbered, and existing roles
must keep working across upgrades. Add new bits at the end.

**Architectural decisions** live in [`docs/adr/`](docs/adr). If a change
contradicts an ADR, say so in the pull request and write a new ADR superseding
the old one. Do not silently diverge.

## Working through a batch of tasks

When handed several things at once, the order is: investigate everything, queue
everything, then build.

**1. Investigate before filing.** Read the code for every proposal first. What
is being asked for is often not what is wrong: a report that "editing a moment
does not update" turned out to be only pinned moments, because they render from
a second copy of the state. Filing an issue before finding that is filing the
wrong issue.

**2. Queue the whole batch, then build.** Open an issue per accepted proposal,
all of them, before writing any code. Say what is actually broken and why, not
just what to change. A proposal that turns out to be a non-issue gets said so
rather than filed.

**3. One commit per issue.** Group only work that cannot be separated, and say
in the body why it could not. A test-only fixup that came out of the same
session is its own commit; it closes nothing.

**4. Push in batches.** One push at the end, or every five or so tasks,
whichever keeps a red CI from sitting on top of unrelated finished work.

**5. Release anything that reaches a user.** A change to `client/` or `server/`
gets a version bump and a tag. `docs:`, `chore:` and repository plumbing do not.
Bump `package.json` in the root, `client/` and `electron/` together (the version
sync in CI checks all three), commit as the bare version number, tag `vX.Y.Z`,
and push the tag. Verify the release un-drafted and CI is green before saying it
shipped.

## Commits

Conventional Commits: `feat(scope):`, `fix(scope):`, `docs:`, `refactor:`,
`chore:`, `style:`. Keep the subject under about 72 characters and explain why
in the body when it is not obvious.

Close the issue from the commit (`Closes #12`), so the queue drains itself.

Agent-assisted commits carry a `Co-Authored-By:` trailer. Attribution is
expected here, not hidden. Put it last, after a blank line:

```
Co-Authored-By: Claude <noreply@anthropic.com>
```

## Tests

Bug fixes come with a regression test. Server behaviour goes in the relevant
`server/internal/*/*_test.go`. Client behaviour goes in a Vitest file beside the
component, or into the Playwright critical path if it is a user-visible flow.

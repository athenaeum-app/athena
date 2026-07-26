# Contributing to Athena

Thanks for taking a look. Athena is a small self-hosted project maintained by one
person, so the process here is deliberately light.

## Before you start

For anything larger than a bug fix, **open an issue first**. Athena has opinions
about its own scope. It is a personal journaling and archiving tool, not a
general-purpose CMS. It is much less frustrating to find out a feature is out of
scope before you build it than after.

Small fixes (a bug, a typo, a broken edge case) need no preamble. Just send the
pull request.

If you are working with an AI coding agent, point it at [AGENTS.md](AGENTS.md),
which covers the same conventions in a form agents read directly.

## Setting up

Requirements: Node.js 20 or newer, Go 1.25 or newer.

```bash
git clone https://github.com/athenaeum-app/athena.git
cd athena
npm install          # also installs client/ and electron/ dependencies
npm run dev          # Go server + client hot reload + desktop launcher
```

`npm run dev:web` runs just the client against the Go server if you would rather
work in a browser. `npm run demo` wipes the local database and seeds a populated
library, which is the fastest way to get a realistic UI to work against.

## Before you open a pull request

CI runs these, and it will reject the PR if any of them fail:

```bash
npm run typecheck    # tsc --noEmit over the client
npm test             # client unit tests + go test ./...
npm run e2e          # Playwright critical path
cd server && gofmt -l .   # must print nothing
cd server && go vet ./...
```

## How the pieces fit together

The one thing that surprises people: **`vite build` writes the client into
`server/client/web/`, which the Go binary embeds at compile time.** There is no
separately hosted frontend. If you change client code and then test the compiled
server binary without rebuilding the client first, you will be looking at a stale
bundle.

```
server/     Go backend (HTTP API, SQLite, migrations, embedded PWA)
client/     SolidJS PWA (Vite + Tailwind), builds into server/client/web
shared/     OpenAPI spec and generated TypeScript types
electron/   Multi-server desktop launcher
docs/       Glossary, ADRs, screenshots
```

## Conventions

**Naming.** [`docs/GLOSSARY.md`](docs/GLOSSARY.md) is the authority on domain
vocabulary. If you are adding a concept, add it there. If you are touching an
existing one, use the name the glossary uses. The _Avoid_ lines exist because
two names for one thing is how a codebase rots.

**Architectural decisions.** Significant choices are recorded in
[`docs/adr/`](docs/adr). If your change contradicts an ADR, that is not
automatically a problem, but say so in the PR and write a new ADR superseding the
old one.

**Commits.** Conventional Commits: `feat(scope):`, `fix(scope):`, `docs:`,
`refactor:`, `chore:`. Keep the subject under about 72 characters and explain
*why* in the body when it is not obvious.

**Punctuation.** Plain ASCII only. No em dashes or en dashes, in code, comments,
docs, or commit messages. Use a comma, a colon, or a full stop. CI fails the
build on either character.

**Line endings.** `.gitattributes` normalizes everything to LF in the repository.
On Windows, let Git handle it rather than configuring your editor to force CRLF.
Otherwise `gofmt -l` will flag files you never touched.

**Permissions.** Permission bits are additive and never renumbered; existing
roles must keep working across upgrades. Add new bits at the end.

**Tests.** Bug fixes should come with a regression test. New server behaviour
belongs in the relevant `internal/*/*_test.go`; new client behaviour goes in a
Vitest file next to the component, or into the Playwright critical path if it is
a user-visible flow.

A UI change should be checked at both a desktop and a mobile viewport before
you call it done. The client serves two different shells from one codebase
(the Feed/Menu column layout versus the phone-width swiper and bottom nav), so
a change eyeballed at only one width has only been half tested. The Playwright
suite standardizes on `1440x900` for desktop and `390x844` with `hasTouch: true`
for mobile; use the same two.

## Licensing

Athena is [AGPL-3.0-only](LICENSE). By contributing, you agree your work is
licensed under the same terms. There is no CLA.

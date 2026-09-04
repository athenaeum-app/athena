# Contributing

Thanks for looking. Contributions are welcome! But as this is a personal side project, pull requests are not guaranteed to be merged.

## Before opening a pull request

Open an issue first for anything larger than a fix, for documentation purposes.

Security problems do not go in an issue at all. See
[SECURITY.md](SECURITY.md).

## What the code expects of you

[`AGENTS.md`](AGENTS.md) is the working guide, written for AI agents and just as
applicable to people: how to build and test, what the conventions are, and the
things that are easy to get wrong here. The short version:

- **[`docs/GLOSSARY.md`](docs/GLOSSARY.md) is the authority on names.** If you
  add a concept, add it there. If you touch one, use the word the glossary
  uses. The `_Avoid_` lines are binding, and they exist because two names for
  one thing is how a codebase rots.
- **Comments explain why, not what.** Do not narrate what the next line already
  says. `server/internal/storage/mime.go` is the model.
- **Punctuation is plain ASCII.** No em or en dashes anywhere, including commit
  messages. CI fails on either character.
- **Bug fixes come with a regression test**, and a UI change is checked at both
  a desktop and a mobile viewport before it counts as done.
- **Architectural decisions live in [`docs/adr/`](docs/adr).** If a change
  contradicts one, say so and write a new ADR superseding it rather than
  quietly diverging.

## Running it

Requirements are Node.js 20 or newer and Go 1.25 or newer.

```bash
npm install
npm run dev
```

Before you push:

```bash
npm run typecheck
npm test
cd server && gofmt -l . && go vet ./...
```

`npm run e2e` runs the Playwright suite. It drives a real server binary, so
build the client and the server first; the one thing that catches everyone is
that `vite build` writes into `server/client/web/` and the Go binary embeds
that directory at compile time, so a client change you did not rebuild the
server for is a change you are not testing.

## Commits

Conventional Commits (`feat(scope):`, `fix(scope):`, `docs:`, `refactor:`,
`chore:`, `style:`), subject under about 72 characters, and the body explaining
why when it is not obvious. Close the issue from the commit (`Closes #12`).

Much of this repository was written with AI assistance, and those commits say
so in a `Co-Authored-By` trailer. If you work the same way, keep the trailer:
attribution here is expected rather than hidden.

## License

Contributions are made under [AGPL-3.0-only](LICENSE), the same terms the rest
of the project is under.

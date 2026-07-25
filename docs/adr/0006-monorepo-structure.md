# Monorepo: server, client, shared, electron in one repository

The v2 codebase is a single repository containing `server/` (Go), `client/` (PWA), `shared/` (OpenAPI spec + generated TS types), and `electron/` (launcher). The client build outputs into `server/web/` and is embedded into the Go binary via `go:embed`.

This was chosen over separate repos because the server-bundled-client architecture (ADR-0002) creates a build-time dependency: the server's build needs the client's `dist/` output. In separate repos this requires a cross-repo build pipeline that clones, builds, and copies. In a monorepo it is a single working tree. Additionally, the shared API contract (`shared/openapi.yaml`) is consumed by both sides at build time; in separate repos this would require publishing a versioned package, which is ceremony for a single-developer project.

The cost is slightly more complex CI and a larger repo. Both are negligible at this scale. Separate repos would be justified if the client and server had different release cadences, different owners, or if the client were not embedded in the server binary, none of which apply.

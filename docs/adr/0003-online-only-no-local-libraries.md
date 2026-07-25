# Online-only: drop offline/local libraries

v2 supports only server libraries. The v1 concept of a local-only library (data stored in a client-side JSON file, no server connection) is removed entirely. All content lives on a server; the client is a view layer over server state.

This was chosen because: (1) the server-bundled PWA architecture (ADR-0002) means the client is always loaded from a server, making "offline local library" architecturally awkward, (2) self-hosting is cheap and the operator runs servers for all users, (3) offline-local-library plumbing is roughly half of the v1 client's complexity (`data_migrate.ts`, per-library local caches, the local/server duality, the entire `API.ts` file read/write layer) and removing it is the single biggest simplification in the rewrite.

The cost is that users without a server cannot use Athena. This is acceptable given the deployment model (Docker Compose, one command to spin up a server) and the user base (the operator provisions servers for all users).

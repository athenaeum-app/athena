# Server-bundled PWA client, same origin as API

The v2 client is a Progressive Web App served by the Go server on the same origin as the API. The PWA bundle is embedded into the server binary via `go:embed` and served at `/`; the API is served at `/api/v1/`. The Electron app is reduced to a thin launcher that loads the PWA at a user-configured server URL.

This was chosen over a separate client repo or a traditional Electron-bundled client because: (1) the same-origin architecture eliminates CORS and its entire class of bugs, (2) one binary deploys both server and client, with no version skew between client and server, (3) the PWA is installable on mobile and desktop from the server URL, satisfying the mobile requirement without a separate mobile codebase, (4) the Electron app stops being a data-access layer and becomes a ~200-line browser shell, deleting the entire `app/main/src/modules/API.ts` surface from v1.

The cost is that the Electron launcher is useless offline and the client build must output into `server/web/` for the Go embed step. Both are acceptable given the online-only decision (ADR-0003) and the monorepo structure (ADR-0006).

> **Amended by ADR-0014 (v2.2).** The desktop shell is no longer a thin whole-window launcher: it is a persistent chrome host that embeds each server's PWA in a `WebContentsView`, and it attaches a *minimal, read-only* preload (`content-preload.cjs` → `window.athenaDesktop`) to that view, a bounded exception to this ADR's "the PWA runs with no preload." The bridge carries no library data (fonts/version/update-check + server switching only); content still flows solely over the same-origin API. See ADR-0014.

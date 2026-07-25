# Client appearance is a desktop-global preference with per-server overrides

The client's visual/UX surface (color theme, look, layout, libraries placement, font, UI
scale, animations) is a **single global preference** shared across every server, with
optional **per-server overrides**. This deliberately carves the appearance surface *out*
of the per-server isolation ADR-0012 established: everything else (auth, content caches)
stays partition-isolated per server, but appearance is unified.

Today appearance is not isolated on purpose. It is stored entirely in client
`localStorage` under global keys (`athena-active-theme`, `athena-active-look`,
`athena-prefs`, …) with no server id in them. It only *appears* per-server because the
Electron shell loads each server in its own session partition (`persist:srv-<id>`), and
`localStorage` is isolated per partition, so the same global key resolves to different
physical storage per server. That emergent split is the bug this ADR removes.

The source of truth moves to the **desktop shell**: the global default and the per-server
override map live in the main process's `electron-store` (partition-independent, already
the home of the server profiles), exposed to the PWA through a widened content bridge. The
PWA resolves each setting through a cascade (**archive-override → server-override →
global-default**), extending the existing per-archive theme override (`athena-archive-themes`)
as the innermost layer. Overrides are specified per-setting via a scope switch in
Appearance settings (Global default vs This server), so a user can inherit the global look
while overriding only, say, the color theme for one server. On upgrade, the first server
opened seeds the global default from its current appearance and all other servers inherit
it; their separate copies are dropped, matching the "start from one global theme" intent.

The alternatives were rejected for concrete reasons. Server-synced appearance (storing
theme in the `settings` table, ADR-0007) would make appearance *more* per-server, not
global, since accounts and servers are one-to-one (ADR-0004). There is no cross-server
identity to hang a global preference on. A shared Electron partition for prefs would break
ADR-0012's isolation for auth and content, which must stay per-server. Because a global
cross-server preference is only meaningful where one client federates many servers, this
is a **desktop-only** capability (ADR-0014 makes Electron the primary client); in a plain
browser you are on one server's origin at a time, so the scope switch is hidden and
appearance remains ordinary per-origin `localStorage`. The accepted cost is that the
global default cannot follow a user into a pure-browser session on another machine, an
acceptable limit given the desktop-primary posture.

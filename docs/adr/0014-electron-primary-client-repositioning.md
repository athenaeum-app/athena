# Electron becomes the primary Athena client; PWA demoted to mobile check-in

Athena repositions the **Electron desktop app as the primary, recommended
client**, and the server-hosted **PWA as a second-class mobile / "check-in"
client**, for people who want to periodically see, from a phone, whether
friends posted to their libraries. All new client investment goes to the
desktop shell. The PWA still keeps **all core content operations** (view/create/
edit moments, tags, archives, chat, search) so mobile stays genuinely usable;
what it does not get is the desktop chrome and power/customization features.

This **amends ADR-0011**, which framed the PWA as "the universal, installable,
mobile-capable client" and Electron as a superset layered on top. The honest-
split rule of ADR-0011 is unchanged and still governs: *all core content
operations stay in the PWA; only power, customization, and desktop-integration
features are client-exclusive.* Only the emphasis flips. Electron is now the
default experience we design for first, not the optional superset.

## What this phase changes

Two concrete stance changes ride along with the repositioning:

1. **Persistent chrome rail (completes ADR-0012's intent).** The desktop shell
   stops navigating the whole window between a local picker page and
   `loadURL(serverUrl)`. Instead the window is a permanent `shell.html` that
   renders a labeled, LibraryBar-style **server sidebar** as fixed left chrome,
   and embeds the active server's PWA in a child **`WebContentsView`** to its
   right. Each server view runs in a real per-server session partition
   (`persist:srv-<id>`), the isolation ADR-0012 described but the code had not
   actually set. Persistent partitions keep cookies, so the user stays logged
   into every server at once and switching is instant. We recreate a single
   content view per switch (cheap, since the cookie survives); keeping N views
   warm for zero-flicker switching is a deferred optimization.

2. **Minimal read-only preload for the embedded PWA (narrow exception to
   ADR-0002).** ADR-0002 established that "the Electron app is reduced to a thin
   launcher" and the PWA "runs in a normal web context" with no preload. The
   desktop shell now attaches a small `content-preload.cjs` to each content
   view, exposing a read-only `window.athenaDesktop` bridge:
   `listSystemFonts()`, `appVersion()`, `checkForUpdates()`, `switchServer(id)`,
   `openRail()`. This is a deliberate, bounded exception: it carries **no
   library data** (content still flows only over the server's same-origin API)
   and exists solely for desktop-integration reads (fonts, version, updates) and
   server switching. Its presence also serves as the signal that the PWA is
   running inside the desktop shell, gating desktop-only settings UI.

The zero-server first run adopts the Setup-wizard visual language (serif brand,
bookcase backdrop, installer-grade polish) as a full welcome hero rather than a
bare dashed empty-state. One `shell.html` surface with two states (welcome vs.
sidebar + content).

## Reaffirmed, unchanged

- **No local/offline libraries.** ADR-0003 and ADR-0004 stand. None of v1's
  local-library, publish, or import machinery is ported; the sidebar is a server
  selector only (it omits v1's `PushPullSection`).
- **One server hosts one library** (ADR-0004) and **same-origin session
  cookies** (ADR-0002, ADR-0008). Multi-server continues to live *only* in the
  Electron client, precisely because holding N same-origin sessions in one
  browser page is awkward (ADR-0012); the per-server partitions are what make it
  work.

## Why

The user wants v1's server selector and a polished first-run page back, plus the
missing power features (font/animation controls, update checks), while keeping
v2's architecture and aesthetic intact. Making the desktop shell primary is what
lets those live somewhere coherent, a persistent rail wrapping a live server
view, without dragging multi-server auth, CORS, or cookie-partitioning problems
into the same-origin PWA.

## Cost

The shell grows from a whole-window navigator into a stateful chrome host:
`WebContentsView` lifecycle, bounds/resize handling, session partitions, health
pings, and inline rename/remove. The preload exception widens the desktop
attack surface by exactly five read-only IPC calls, which we accept as the price
of desktop integration; it is reviewed as a fixed, enumerated surface rather
than an open channel. Mobile/web users see a deliberately smaller feature set,
consistent with their now-secondary "check-in" role.

## Addendum (v2.3, §8.3): in-PWA Libraries switcher

The read-only bridge gains two calls, `listLibraries()` (the saved server
profiles: `{id, name, url}`) and `activeLibraryId()`, so the PWA can render its
own Libraries switcher inline instead of relying on the native shell rail. This
keeps a single, themeable switcher inside the app, with a user-selectable
placement (inline above/below Archives, or a left rail; none in a browser /
single-server context). The native `shell.html` LibraryBar is now redundant and
should be reduced to window chrome or retired in a follow-up; the enumerated
preload surface widens from five to seven read-only calls, still fixed and
carrying no library content.

The in-PWA switcher's rail placement is a *port* of that native sidebar, not a
replacement design: the same full-height shelf, the same per-library spine
colours, the same serif titles and status lights. The first attempt at it was a
narrow strip of initials beside the Archives column, which read as a third and
worse switcher rather than the same one relocated. Carrying the shell's own
treatment across is what makes "inline or rail" a placement choice instead of a
choice between two different components.

The native sidebar was not retired outright, because adding, renaming, removing
and reordering servers is not ported into the PWA, so it survives as on-demand
management chrome, hidden by default and opened from the PWA's "manage" action
or Ctrl/Cmd+Shift+S. That leaves two switchers that can be on screen at once,
listing the same libraries and reading as a duplicate. Rather than pick one,
the bridge gains `railVisible()` and an `onRailVisibility(cb)` subscription
(nine calls now) and the PWA switcher stands down whenever the native sidebar is
up. Visibility stays owned by the main process, which is the only side that
knows the sidebar's width. The alternative, having each side track the other's
state, is what lets them disagree.

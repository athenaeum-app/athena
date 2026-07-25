# PWA-vs-desktop-client capability split

The feature surface is tiered between the two clients. The **PWA** (served same-origin by one server, ADR-0002) provides the core library experience: viewing, creating, and editing moments, tags, archives, chat, search, and settings/themes. The **Electron desktop client** is a superset: it adds power features, deep customization, and OS-level integrations that either do not fit the online-only same-origin PWA model or benefit from desktop capabilities: multi-server connections (ADR-0012), system font enumeration, native update checks, global keybinds, and heavier customization UIs.

This was chosen over full parity between the two clients because: (1) the PWA is bound by the browser sandbox and the same-origin/one-session model (ADR-0002, ADR-0008), so features like multi-server, installed-font enumeration, and auto-update are awkward or impossible there; (2) keeping the PWA lean preserves its role as the universal, installable, mobile-capable client; (3) it gives every Phase 4 feature a clear home instead of forcing each into the lowest common denominator.

The rule that keeps the split honest: **all core content operations stay in the PWA**; only power, customization, and desktop-integration features are client-exclusive. Server APIs remain the single source of truth, so a client-exclusive feature never forks the data model. It only adds a richer view or a local preference.

The cost is two capability tiers to reason about, and a feature added to the client only is unavailable on mobile/web. This is acceptable because the tiers are defined by a clear boundary (core content vs. power/customization/desktop-integration) rather than an ad-hoc list.

> **Amended by ADR-0014 (v2.2).** The tiers are unchanged, but their emphasis flips: the **Electron desktop app is now the primary, recommended client** and the **PWA is a second-class mobile "check-in" client**, not the universal client this ADR framed it as. The honest-split rule still holds verbatim: all core content operations stay in the PWA; only power/customization/desktop-integration features are client-exclusive. See ADR-0014.

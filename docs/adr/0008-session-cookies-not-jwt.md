# Session cookies for auth, not JWT

Authentication uses server-side sessions referenced by an httpOnly, sameSite cookie. The `sessions` table stores session IDs (hashed), user IDs, expiry, and metadata. No JWTs.

This was chosen over JWT-in-localStorage because the PWA and API are same-origin (ADR-0002), so cross-origin token portability is unnecessary. httpOnly cookies cannot be read by JavaScript, which eliminates the XSS token-theft attack surface: significant because the PWA renders user-generated markdown (moments, chat) and is therefore an XSS surface. Logout is trivial (delete the server-side session row); JWT would require a server-side blocklist or short expiry + refresh tokens.

Session expiry is 30-day sliding by default, configurable via env var. A "stay logged in" option on the login screen creates a session with no expiry (far-future date) for users who want the v1 "never log in" experience.

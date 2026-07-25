package auth

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/athenaeum-app/athena/server/internal/permissions"
	"github.com/athenaeum-app/athena/server/internal/presence"
)

// contextKey is an unexported type so context keys defined here cannot
// collide with keys from any other package.
type contextKey int

const (
	userKey contextKey = iota
	permsKey
)

// UserFromContext returns the authenticated user attached by RequireAuth,
// or nil if no user is present.
func UserFromContext(ctx context.Context) *models.User {
	v, _ := ctx.Value(userKey).(*models.User)
	return v
}

// PermissionsFromContext returns the authenticated user's effective
// permission bitmask, or 0 if no permissions are present.
func PermissionsFromContext(ctx context.Context) permissions.Flag {
	v, _ := ctx.Value(permsKey).(permissions.Flag)
	return v
}

// RequireAuth wraps a handler so that only authenticated requests proceed.
// It reads the session cookie, resolves it to a session and user, computes
// the user's effective permissions, and attaches both to the request
// context. Unauthenticated requests get a 401 with a small JSON body.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(SessionCookieName)
		if err != nil {
			writeAuthError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		session, err := GetSession(cookie.Value)
		if err != nil {
			writeAuthError(w, http.StatusUnauthorized, "invalid or expired session")
			return
		}

		user, err := GetUser(session.UserID)
		if err != nil {
			writeAuthError(w, http.StatusUnauthorized, "user not found")
			return
		}

		perms, err := GetUserPermissions(user.ID)
		if err != nil {
			writeAuthError(w, http.StatusInternalServerError, "failed to resolve permissions")
			return
		}

		presence.Touch(user.ID)

		ctx := context.WithValue(r.Context(), userKey, user)
		ctx = context.WithValue(ctx, permsKey, perms)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequirePermission wraps RequireAuth and additionally checks that the
// authenticated user holds the given permission flag. Lacking it returns
// 403. The Administrator wildcard is honored via permissions.Has.
func RequirePermission(flag permissions.Flag) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			perms := PermissionsFromContext(r.Context())
			if !permissions.Has(perms, flag) {
				writeAuthError(w, http.StatusForbidden, "insufficient permissions")
				return
			}
			next.ServeHTTP(w, r)
		}))
	}
}

// writeAuthError emits a small JSON error body consistent with the rest of
// the API. It does not write a body if headers have already been sent.
func writeAuthError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

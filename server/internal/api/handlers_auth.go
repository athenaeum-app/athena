package api

import (
	"errors"
	"log"
	"net/http"

	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/athenaeum-app/athena/server/internal/permissions"
	"github.com/athenaeum-app/athena/server/internal/sync"
)

type registerRequest struct {
	Username     string  `json:"username"`
	Password     string  `json:"password"`
	InviteID     *string `json:"invite_id"`
	StayLoggedIn bool    `json:"stay_logged_in"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password are required")
		return
	}

	user, err := auth.Register(req.Username, req.Password, req.InviteID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	session, err := auth.Login(req.Username, req.Password, req.StayLoggedIn, r.RemoteAddr, r.UserAgent())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "registered but session creation failed")
		return
	}

	s.setSessionCookie(w, r, session, req.StayLoggedIn)
	sync.RecordAudit(user.ID, "user.register", "USER", user.ID, nil)
	writeJSON(w, http.StatusCreated, user)
}

type loginRequest struct {
	Username     string `json:"username"`
	Password     string `json:"password"`
	StayLoggedIn bool   `json:"stay_logged_in"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password are required")
		return
	}

	session, err := auth.Login(req.Username, req.Password, req.StayLoggedIn, r.RemoteAddr, r.UserAgent())
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	user, err := auth.GetUser(session.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "session created but user lookup failed")
		return
	}

	s.setSessionCookie(w, r, session, req.StayLoggedIn)
	sync.RecordAudit(user.ID, "user.login", "USER", user.ID, nil)
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	if user == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}

	cookie, err := r.Cookie("athenaeum_session")
	if err == nil && cookie != nil {
		auth.Logout(cookie.Value)
	}

	s.clearSessionCookie(w)
	sync.RecordAudit(user.ID, "user.logout", "USER", user.ID, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "logged out"})
}

func (s *Server) handleGetMe(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	perms := auth.PermissionsFromContext(r.Context())

	roles, _ := auth.GetUserRoles(user.ID)
	roleNames := make([]string, 0, len(roles))
	for _, role := range roles {
		roleNames = append(roleNames, role.Name)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":          user.ID,
		"username":    user.Username,
		"is_owner":    user.IsOwner,
		"roles":       roleNames,
		"permissions": uint32(perms),
	})
}

type updateMeRequest struct {
	// Both optional; at least one must be present. A nil field means "leave
	// this alone", which is why they are pointers rather than plain strings.
	// Otherwise a client sending only a new password would read as a request
	// to blank the username.
	Username    *string `json:"username"`
	NewPassword *string `json:"new_password"`
	// Always required, for either change.
	CurrentPassword string `json:"current_password"`
}

// handleUpdateMe lets a signed-in user change their own username or password.
// Both are gated on the current password: the session cookie proves you are
// using the account, not that you own it, and a borrowed session should not be
// enough to take it over permanently.
func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())

	var req updateMeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Username == nil && req.NewPassword == nil {
		writeError(w, http.StatusBadRequest, "nothing to change")
		return
	}
	if req.CurrentPassword == "" {
		writeError(w, http.StatusBadRequest, "your current password is required")
		return
	}

	if err := auth.VerifyPassword(user.ID, req.CurrentPassword); err != nil {
		if errors.Is(err, auth.ErrInvalidCredentials) {
			writeError(w, http.StatusForbidden, "current password is incorrect")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to verify password")
		return
	}

	// Username first: if it is rejected (taken, empty), nothing has changed
	// yet, so the request fails cleanly rather than half-applied.
	renamed := false
	if req.Username != nil {
		switch err := auth.ChangeUsername(user.ID, *req.Username); {
		case err == nil:
			renamed = true
		case errors.Is(err, auth.ErrUsernameUnchanged):
			// Submitting the form without touching the name is not an error.
		case errors.Is(err, auth.ErrUsernameTaken),
			errors.Is(err, auth.ErrUsernameEmpty),
			errors.Is(err, auth.ErrUsernameTooLong):
			writeError(w, http.StatusBadRequest, err.Error())
			return
		default:
			writeError(w, http.StatusInternalServerError, "failed to change username")
			return
		}
	}

	if req.NewPassword != nil {
		if err := auth.ChangePassword(user.ID, *req.NewPassword); err != nil {
			if errors.Is(err, auth.ErrPasswordTooShort) {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			writeError(w, http.StatusInternalServerError, "failed to change password")
			return
		}
		// Sign every other session out. Keeping them alive would make a
		// password change useless against exactly the case it is meant for.
		keep := ""
		if cookie, err := r.Cookie(auth.SessionCookieName); err == nil && cookie != nil {
			keep = cookie.Value
		}
		if _, err := auth.RevokeOtherSessions(user.ID, keep); err != nil {
			log.Printf("api: failed to revoke other sessions for %s: %v", user.ID, err)
		}
		sync.RecordAudit(user.ID, "user.password.change", "USER", user.ID, nil)
	}

	if renamed {
		sync.RecordAudit(user.ID, "user.username.change", "USER", user.ID, map[string]string{
			"from": user.Username,
			"to":   *req.Username,
		})
		// Signal only: every client caches the user directory to render author
		// names, and a rename makes those caches stale. No payload. Clients
		// react by re-reading the directory.
		sync.RecordEvent("USER_UPDATED", "USER", user.ID, &user.ID, nil)
	}

	updated, err := auth.GetUser(user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "changes saved but user lookup failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       updated.ID,
		"username": updated.Username,
		"is_owner": updated.IsOwner,
	})
}

// handleUserDirectory serves the member-visible user directory: a lightweight
// list of {id, username} that any authenticated member can read to resolve
// author IDs to usernames (chat, audit log, canvas). It never exposes
// password hashes, emails, or session data.
func (s *Server) handleUserDirectory(w http.ResponseWriter, r *http.Request) {
	users, err := auth.ListUserDirectory()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list users")
		return
	}
	writeJSON(w, http.StatusOK, users)
}

// handleListUsers serves the admin user-management list (full user records)
// and is gated by ManageUsers. The lightweight member directory lives at
// GET /api/v1/users (see handleUserDirectory).
func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := auth.ListUsersWithRoles()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list users")
		return
	}
	writeJSON(w, http.StatusOK, users)
}

type assignRolesRequest struct {
	RoleIDs []string `json:"role_ids"`
}

func (s *Server) handleAssignUserRoles(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	if userID == "" {
		writeError(w, http.StatusBadRequest, "missing user id")
		return
	}

	var req assignRolesRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	actor := auth.UserFromContext(r.Context())
	if err := auth.SetUserRoles(userID, req.RoleIDs); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	sync.RecordAudit(actor.ID, "user.roles.assign", "USER", userID, req.RoleIDs)
	// Signal only, no payload: which roles a given user holds is admin-facing,
	// and every authenticated client polls this feed. Clients react by
	// re-reading their own /users/me.
	sync.RecordEvent("USER_ROLES_UPDATED", "USER", userID, &actor.ID, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "roles updated"})
}

func (s *Server) setSessionCookie(w http.ResponseWriter, r *http.Request, session *models.Session, stayLoggedIn bool) {
	maxAge := 0
	if stayLoggedIn {
		// A Go MaxAge of 0 omits the Max-Age attribute, which makes browsers
		// treat the cookie as session-only (cleared when the browser/app
		// process exits), the opposite of "stay logged in". Give it a long
		// explicit lifetime so it survives restarts, matching the
		// never-expiring session row created in auth.Login (ADR-0008).
		maxAge = 10 * 365 * 86400
	} else if s.cfg.SessionExpiryDays > 0 {
		maxAge = s.cfg.SessionExpiryDays * 86400
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "athenaeum_session",
		Value:    session.ID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
		MaxAge:   maxAge,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     "athenaeum_session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

var _ = permissions.ViewMoments

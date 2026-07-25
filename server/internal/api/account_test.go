package api_test

import (
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"strings"
	"testing"
)

// Self-service account editing: PATCH /api/v1/users/me.

func TestChangeUsername(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	status, body := env.do(t, "PATCH", "/api/v1/users/me", map[string]any{
		"username":         "renamed",
		"current_password": "password123",
	})
	if status != http.StatusOK {
		t.Fatalf("rename: %d %v, want 200", status, body)
	}
	if body["username"] != "renamed" {
		t.Errorf("response says username is %v, want renamed", body["username"])
	}

	_, me := env.do(t, "GET", "/api/v1/users/me", nil)
	if me["username"] != "renamed" {
		t.Errorf("/users/me still reports %v", me["username"])
	}

	// The rename is the login identifier, so the new name must actually work.
	fresh := env.anon(t)
	if status, body := fresh.do(t, "POST", "/api/v1/auth/login", map[string]any{
		"username": "renamed", "password": "password123",
	}); status != http.StatusOK {
		t.Errorf("login with the new username: %d %v, want 200", status, body)
	}
	if status, _ := env.anon(t).do(t, "POST", "/api/v1/auth/login", map[string]any{
		"username": "owner", "password": "password123",
	}); status != http.StatusUnauthorized {
		t.Errorf("login with the old username: %d, want 401", status)
	}
}

func TestChangePassword(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	if status, body := env.do(t, "PATCH", "/api/v1/users/me", map[string]any{
		"new_password":     "a-longer-secret",
		"current_password": "password123",
	}); status != http.StatusOK {
		t.Fatalf("change password: %d %v, want 200", status, body)
	}

	if status, _ := env.anon(t).do(t, "POST", "/api/v1/auth/login", map[string]any{
		"username": "owner", "password": "a-longer-secret",
	}); status != http.StatusOK {
		t.Errorf("login with the new password: %d, want 200", status)
	}
	if status, _ := env.anon(t).do(t, "POST", "/api/v1/auth/login", map[string]any{
		"username": "owner", "password": "password123",
	}); status != http.StatusUnauthorized {
		t.Errorf("login with the old password: %d, want 401", status)
	}
}

// The session you changed the password from stays signed in. Being logged out
// of the tab you just used would be a poor way to end the interaction.
func TestPasswordChangeKeepsTheCurrentSessionAndDropsTheRest(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	// A second sign-in as the same user, i.e. another device.
	other := env.anon(t)
	if status, _ := other.do(t, "POST", "/api/v1/auth/login", map[string]any{
		"username": "owner", "password": "password123",
	}); status != http.StatusOK {
		t.Fatalf("second login failed")
	}
	if status, _ := other.do(t, "GET", "/api/v1/users/me", nil); status != http.StatusOK {
		t.Fatalf("second session should start out valid")
	}

	if status, body := env.do(t, "PATCH", "/api/v1/users/me", map[string]any{
		"new_password":     "a-longer-secret",
		"current_password": "password123",
	}); status != http.StatusOK {
		t.Fatalf("change password: %d %v", status, body)
	}

	if status, _ := env.do(t, "GET", "/api/v1/users/me", nil); status != http.StatusOK {
		t.Errorf("the session that changed the password was signed out (%d)", status)
	}
	if status, _ := other.do(t, "GET", "/api/v1/users/me", nil); status != http.StatusUnauthorized {
		t.Errorf("the other session survived the password change (%d, want 401)", status)
	}
}

// A borrowed session should not be enough to take an account over, so every
// change re-checks the password rather than trusting the cookie.
func TestAccountChangesRequireTheCurrentPassword(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	cases := []struct {
		name string
		body map[string]any
		want int
	}{
		{"wrong password", map[string]any{"username": "hijacked", "current_password": "nope"}, http.StatusForbidden},
		{"no password", map[string]any{"username": "hijacked"}, http.StatusBadRequest},
		{"nothing to change", map[string]any{"current_password": "password123"}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if status, body := env.do(t, "PATCH", "/api/v1/users/me", tc.body); status != tc.want {
				t.Errorf("got %d %v, want %d", status, body, tc.want)
			}
		})
	}

	_, me := env.do(t, "GET", "/api/v1/users/me", nil)
	if me["username"] != "owner" {
		t.Errorf("username changed despite every attempt being rejected: %v", me["username"])
	}
}

func TestUsernameChangeIsValidated(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)
	env.invite(t, "tobias")

	cases := []struct {
		name     string
		username string
		wantErr  string
	}{
		{"already taken", "tobias", "already taken"},
		{"blank", "   ", "cannot be empty"},
		{"too long", strings.Repeat("n", 33), "at most"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := env.do(t, "PATCH", "/api/v1/users/me", map[string]any{
				"username": tc.username, "current_password": "password123",
			})
			if status != http.StatusBadRequest {
				t.Fatalf("got %d %v, want 400", status, body)
			}
			if msg, _ := body["error"].(string); !strings.Contains(msg, tc.wantErr) {
				t.Errorf("error was %q, want it to mention %q", msg, tc.wantErr)
			}
		})
	}
}

// Submitting the account form without touching the name is not an error, and
// must not report the user's own name as taken.
func TestSubmittingTheSameUsernameSucceeds(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	if status, body := env.do(t, "PATCH", "/api/v1/users/me", map[string]any{
		"username": "owner", "new_password": "a-longer-secret", "current_password": "password123",
	}); status != http.StatusOK {
		t.Fatalf("got %d %v, want 200", status, body)
	}
}

func TestShortPasswordRejected(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	status, body := env.do(t, "PATCH", "/api/v1/users/me", map[string]any{
		"new_password": "abc", "current_password": "password123",
	})
	if status != http.StatusBadRequest {
		t.Fatalf("got %d %v, want 400", status, body)
	}
	// The old password must still work: a rejected change is not a half-change.
	if status, _ := env.anon(t).do(t, "POST", "/api/v1/auth/login", map[string]any{
		"username": "owner", "password": "password123",
	}); status != http.StatusOK {
		t.Errorf("the original password stopped working after a rejected change (%d)", status)
	}
}

// A rename makes every client's cached user directory stale, so it has to
// reach them the same way every other change does.
func TestRenameEmitsASyncEvent(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	_, before := env.do(t, "GET", "/api/v1/events?since=0", nil)
	from := int64(before["current_version"].(float64))

	if status, _ := env.do(t, "PATCH", "/api/v1/users/me", map[string]any{
		"username": "renamed", "current_password": "password123",
	}); status != http.StatusOK {
		t.Fatalf("rename failed")
	}

	_, feed := env.do(t, "GET", "/api/v1/events?since="+strconv.FormatInt(from, 10), nil)
	events, _ := feed["events"].([]any)
	found := false
	for _, e := range events {
		if m, ok := e.(map[string]any); ok && m["type"] == "USER_UPDATED" {
			found = true
		}
	}
	if !found {
		t.Errorf("no USER_UPDATED event after a rename; got %v", events)
	}
}

// anon returns a client sharing this server but with an empty cookie jar.
func (e *testEnv) anon(t *testing.T) *testEnv {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	return &testEnv{srv: e.srv, client: &http.Client{Jar: jar}}
}

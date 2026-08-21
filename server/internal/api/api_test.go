package api_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/athenaeum-app/athena/server/internal/api"
	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/config"
	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/domain"
)

// testEnv bundles a running httptest server and a cookie-jar client so tests
// can drive the real router end-to-end with session cookies flowing.
type testEnv struct {
	srv    *httptest.Server
	client *http.Client
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()

	cfg := &config.Config{
		Port:              "0",
		UploadsPath:       t.TempDir(),
		SessionExpiryDays: 30,
		// Without this every upload is refused: MaxBytesReader treats a zero
		// ceiling as zero bytes allowed, so a harness that leaves it unset
		// answers 413 to anything with a body.
		MaxUploadBytes: 8 << 20,
	}
	auth.SetConfig(cfg)
	domain.Config = cfg

	if err := db.Open(t.TempDir() + "/test.db"); err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
		db.DB = nil
	})

	srv := httptest.NewServer(api.NewServer(cfg))
	jar, _ := cookiejar.New(nil)
	env := &testEnv{srv: srv, client: &http.Client{Jar: jar}}
	t.Cleanup(srv.Close)
	return env
}

// do issues a JSON request and returns the status code and decoded body.
func (e *testEnv) do(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var buf io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		buf = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, buf)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := e.client.Do(req)
	if err != nil {
		t.Fatalf("do %s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	data, _ := io.ReadAll(resp.Body)
	if len(data) > 0 && data[0] == '{' {
		json.Unmarshal(data, &out)
	}
	return resp.StatusCode, out
}

// doList issues a request expecting a JSON array response.
func (e *testEnv) doList(t *testing.T, method, path string) (int, []map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, e.srv.URL+path, nil)
	resp, err := e.client.Do(req)
	if err != nil {
		t.Fatalf("do %s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	var out []map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (e *testEnv) registerOwner(t *testing.T) {
	t.Helper()
	status, _ := e.do(t, "POST", "/api/v1/auth/register", map[string]any{
		"username": "owner",
		"password": "password123",
	})
	if status != http.StatusCreated {
		t.Fatalf("register owner: status %d", status)
	}
}

func TestSetupAndRegisterFlow(t *testing.T) {
	env := newTestEnv(t)

	// Fresh server needs setup.
	status, body := env.do(t, "GET", "/api/v1/setup", nil)
	if status != http.StatusOK || body["needs_setup"] != true {
		t.Fatalf("expected needs_setup=true, got %d %v", status, body)
	}

	env.registerOwner(t)

	// After first registration, setup is no longer needed.
	_, body = env.do(t, "GET", "/api/v1/setup", nil)
	if body["needs_setup"] != false {
		t.Errorf("expected needs_setup=false after owner registers, got %v", body)
	}

	// /users/me reflects the owner.
	status, body = env.do(t, "GET", "/api/v1/users/me", nil)
	if status != http.StatusOK {
		t.Fatalf("me: status %d", status)
	}
	if body["is_owner"] != true || body["username"] != "owner" {
		t.Errorf("unexpected me payload: %v", body)
	}
}

func TestUnauthenticatedRejected(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	// A separate client with no session cookie.
	jar, _ := cookiejar.New(nil)
	anon := &testEnv{srv: env.srv, client: &http.Client{Jar: jar}}

	status, _ := anon.do(t, "GET", "/api/v1/moments", nil)
	if status != http.StatusUnauthorized {
		t.Errorf("expected 401 for unauthenticated moments list, got %d", status)
	}
}

func TestSecondUserRequiresInvite(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	// A brand-new client tries to register with no invite.
	jar, _ := cookiejar.New(nil)
	newcomer := &testEnv{srv: env.srv, client: &http.Client{Jar: jar}}
	status, body := newcomer.do(t, "POST", "/api/v1/auth/register", map[string]any{
		"username": "bob",
		"password": "password123",
	})
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 without invite, got %d", status)
	}
	if body["error"] == nil {
		t.Error("expected an error message")
	}
}

// TestSingleUseInviteRejectedOnReuse exercises the invite-only integrity fix
// through the full HTTP stack.
func TestSingleUseInviteRejectedOnReuse(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	// Owner creates a single-use invite.
	status, body := env.do(t, "POST", "/api/v1/invites", map[string]any{"uses": 1})
	if status != http.StatusCreated {
		t.Fatalf("create invite: status %d", status)
	}
	inviteID, _ := body["id"].(string)
	if inviteID == "" {
		t.Fatalf("no invite id in response: %v", body)
	}

	register := func(username string) int {
		jar, _ := cookiejar.New(nil)
		invitedEnv := &testEnv{srv: env.srv, client: &http.Client{Jar: jar}}
		status, _ := invitedEnv.do(t, "POST", "/api/v1/auth/register", map[string]any{
			"username":  username,
			"password":  "password123",
			"invite_id": inviteID,
		})
		return status
	}

	if s := register("bob"); s != http.StatusCreated {
		t.Fatalf("first invite use should succeed, got %d", s)
	}
	if s := register("carol"); s == http.StatusCreated {
		t.Fatal("single-use invite was accepted twice: invite integrity broken")
	}
}

func TestMomentLifecycle(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	// Create an archive.
	status, arch := env.do(t, "POST", "/api/v1/archives", map[string]any{"name": "Journal"})
	if status != http.StatusCreated {
		t.Fatalf("create archive: %d %v", status, arch)
	}
	archiveID := arch["id"].(string)

	// Create a moment.
	status, moment := env.do(t, "POST", "/api/v1/moments", map[string]any{
		"archive_id": archiveID,
		"title":      "First entry",
		"content":    "Hello **world**",
	})
	if status != http.StatusCreated {
		t.Fatalf("create moment: %d %v", status, moment)
	}
	momentID := moment["id"].(string)

	// It appears in the listing.
	status, list := env.doList(t, "GET", "/api/v1/moments?archive="+archiveID)
	if status != http.StatusOK || len(list) != 1 {
		t.Fatalf("expected 1 moment, got %d (status %d)", len(list), status)
	}

	// Update it.
	status, updated := env.do(t, "PATCH", "/api/v1/moments/"+momentID, map[string]any{
		"title": "Edited entry",
	})
	if status != http.StatusOK {
		t.Fatalf("update moment: %d %v", status, updated)
	}
	if updated["title"] != "Edited entry" {
		t.Errorf("title not updated: %v", updated["title"])
	}

	// Delete it (soft delete).
	status, _ = env.do(t, "DELETE", "/api/v1/moments/"+momentID, nil)
	if status != http.StatusOK {
		t.Fatalf("delete moment: %d", status)
	}
	status, list = env.doList(t, "GET", "/api/v1/moments?archive="+archiveID)
	if len(list) != 0 {
		t.Errorf("deleted moment should not appear, got %d", len(list))
	}
}

// TestEmptyListsAreJSONArrays guards the API contract that list endpoints
// return `[]` (not `null`) when empty: a null body crashes the client feed.
func TestEmptyListsAreJSONArrays(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	// Note: /api/v1/archives is intentionally excluded: it now always seeds a
	// default "GENERAL" archive (a library must keep >= 1), so it is never
	// empty. The guard still covers the endpoints that can legitimately be empty.
	for _, path := range []string{
		"/api/v1/moments",
		"/api/v1/tags",
	} {
		req, _ := http.NewRequest("GET", env.srv.URL+path, nil)
		resp, err := env.client.Do(req)
		if err != nil {
			t.Fatalf("get %s: %v", path, err)
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		body := strings.TrimSpace(string(data))
		if body != "[]" {
			t.Errorf("%s empty response = %q, want []", path, body)
		}
	}
}

func TestHealthEndpoint(t *testing.T) {
	env := newTestEnv(t)
	status, body := env.do(t, "GET", "/api/v1/health", nil)
	if status != http.StatusOK || body["status"] != "ok" {
		t.Errorf("unexpected health response: %d %v", status, body)
	}
}

// invite creates an invite as the current (owner) client and registers a new
// user against it, returning a client already carrying that user's session.
func (e *testEnv) invite(t *testing.T, username string) *testEnv {
	t.Helper()
	status, body := e.do(t, "POST", "/api/v1/invites", map[string]any{"uses": 1})
	if status != http.StatusCreated {
		t.Fatalf("create invite: status %d", status)
	}
	inviteID, _ := body["id"].(string)

	jar, _ := cookiejar.New(nil)
	invitedEnv := &testEnv{srv: e.srv, client: &http.Client{Jar: jar}}
	status, _ = invitedEnv.do(t, "POST", "/api/v1/auth/register", map[string]any{
		"username":  username,
		"password":  "password123",
		"invite_id": inviteID,
	})
	if status != http.StatusCreated {
		t.Fatalf("register %s: status %d", username, status)
	}
	return invitedEnv
}

// TestNewMemberCanReadTheLibrary covers the reported symptom that moments were
// visible only to their author: an invited user holds the default role, which
// shipped with permissions = 0, and every read endpoint is gated on
// VIEW_MOMENTS.
func TestNewMemberCanReadTheLibrary(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	status, arch := env.do(t, "POST", "/api/v1/archives", map[string]any{"name": "Journal"})
	if status != http.StatusCreated {
		t.Fatalf("create archive: %d %v", status, arch)
	}
	if status, m := env.do(t, "POST", "/api/v1/moments", map[string]any{
		"archive_id": arch["id"].(string),
		"title":      "Owner's entry",
		"content":    "visible to everyone",
	}); status != http.StatusCreated {
		t.Fatalf("create moment: %d %v", status, m)
	}

	member := env.invite(t, "bob")

	for _, path := range []string{"/api/v1/moments", "/api/v1/archives", "/api/v1/tags"} {
		status, list := member.doList(t, "GET", path)
		if status != http.StatusOK {
			t.Errorf("GET %s as a new member: status %d, want 200", path, status)
		}
		if path == "/api/v1/moments" && len(list) != 1 {
			t.Errorf("new member sees %d moments, want 1", len(list))
		}
	}
}

// TestMemberCannotEditOthersContent is the other half of the baseline: a
// member reads everything but may not edit content they don't own, or touch
// administration.
func TestMemberCannotEditOthersContent(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	_, arch := env.do(t, "POST", "/api/v1/archives", map[string]any{"name": "Journal"})
	_, moment := env.do(t, "POST", "/api/v1/moments", map[string]any{
		"archive_id": arch["id"].(string),
		"title":      "Owner's entry",
		"content":    "hands off",
	})
	momentID := moment["id"].(string)

	member := env.invite(t, "bob")

	if status, _ := member.do(t, "PATCH", "/api/v1/moments/"+momentID, map[string]any{
		"title": "vandalised",
	}); status != http.StatusForbidden {
		t.Errorf("member editing someone else's moment: status %d, want 403", status)
	}
	if status, _ := member.do(t, "POST", "/api/v1/archives", map[string]any{"name": "Nope"}); status != http.StatusForbidden {
		t.Errorf("member creating an archive: status %d, want 403", status)
	}
	if status, _ := member.doList(t, "GET", "/api/v1/users/all"); status != http.StatusForbidden {
		t.Errorf("member reading the admin user list: status %d, want 403", status)
	}
}

// TestInvitedUserCannotAddToTheLibrary: the default role is the floor for the
// whole library, so anything it grants is granted to anyone who gets in with an
// invite. Since migration 0008 that floor adds nothing to the library, and
// contributing is something an admin grants deliberately.
func TestInvitedUserCannotAddToTheLibrary(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)
	_, arch := env.do(t, "POST", "/api/v1/archives", map[string]any{"name": "Journal"})
	archiveID := arch["id"].(string)

	member := env.invite(t, "bob")

	for _, tc := range []struct {
		what string
		path string
		body map[string]any
	}{
		{"a moment", "/api/v1/moments", map[string]any{"archive_id": archiveID, "title": "mine", "content": "hello"}},
		{"an archive", "/api/v1/archives", map[string]any{"name": "Mine"}},
		{"a tag", "/api/v1/tags", map[string]any{"name": "mine", "color": "#fff"}},
	} {
		if status, body := member.do(t, "POST", tc.path, tc.body); status != http.StatusForbidden {
			t.Errorf("invited user creating %s: %d %v, want 403", tc.what, status, body)
		}
	}

	// Reading is unaffected. That is the whole point of the default role.
	if status, list := member.doList(t, "GET", "/api/v1/moments"); status != http.StatusOK || len(list) != 0 {
		t.Errorf("invited user reading moments: %d (%d rows), want 200", status, len(list))
	}
	if status, _ := member.doList(t, "GET", "/api/v1/chat"); status != http.StatusOK {
		t.Errorf("invited user reading chat: %d, want 200", status)
	}
}

// TestInvitedUserCanChat: chat is deliberately not treated as writing to the
// library. Someone who cannot post a moment can still ask about one, which is
// most of the point of having them in the library.
func TestInvitedUserCanChat(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)
	member := env.invite(t, "bob")

	if status, body := member.do(t, "POST", "/api/v1/chat", map[string]any{
		"content": "hello, can someone point me at the trip photos?",
	}); status != http.StatusCreated {
		t.Errorf("invited user sending a chat message: %d %v, want 201", status, body)
	}
}

// TestOwnerCanAdministerTheirServer covers the reported "Insufficient
// Permissions" the owner hit on their own server. The owner holds Owner plus
// the default role, and the two overlap, so summing their bitmasks carried
// away ADMINISTRATOR and MANAGE_ROLES.
func TestOwnerCanAdministerTheirServer(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	status, me := env.do(t, "GET", "/api/v1/users/me", nil)
	if status != http.StatusOK {
		t.Fatalf("me: %d", status)
	}
	perms := uint32(me["permissions"].(float64))
	if perms&(1<<19) == 0 {
		t.Errorf("owner's effective permissions (%d) lack the ADMINISTRATOR wildcard", perms)
	}

	status, role := env.do(t, "POST", "/api/v1/roles", map[string]any{
		"name": "Moderator", "color": "#abcdef", "position": 5, "permissions": 1,
	})
	if status != http.StatusCreated {
		t.Fatalf("owner creating a role: %d %v, want 201", status, role)
	}
	roleID := role["id"].(string)

	if status, body := env.do(t, "PATCH", "/api/v1/roles/"+roleID, map[string]any{
		"permissions": 3,
	}); status != http.StatusOK {
		t.Errorf("owner editing a role: %d %v, want 200", status, body)
	}
	if status, body := env.do(t, "PATCH", "/api/v1/roles/role_viewer", map[string]any{
		"permissions": 1,
	}); status != http.StatusOK {
		t.Errorf("owner editing the default-role baseline: %d %v, want 200", status, body)
	}
	if status, _ := env.do(t, "DELETE", "/api/v1/roles/"+roleID, nil); status != http.StatusOK {
		t.Errorf("owner deleting a role: %d, want 200", status)
	}
}

// TestPermissionChangesEmitSyncEvents is what lets a client notice a
// permission change on its own. Without an event the library version never
// moves, so a client kept serving the permissions it started with until it was
// torn down and rebuilt, the "swap to another library and back" workaround.
func TestPermissionChangesEmitSyncEvents(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)
	member := env.invite(t, "bob")

	// Baseline: whatever version registration left us at.
	_, body := env.do(t, "GET", "/api/v1/events?since=0&limit=500", nil)
	since := int64(body["current_version"].(float64))

	status, role := env.do(t, "POST", "/api/v1/roles", map[string]any{
		"name": "Moderator", "color": "#abcdef", "position": 5, "permissions": 1,
	})
	if status != http.StatusCreated {
		t.Fatalf("create role: %d %v", status, role)
	}
	roleID := role["id"].(string)

	if status, b := env.do(t, "PATCH", "/api/v1/roles/"+roleID, map[string]any{"permissions": 3}); status != http.StatusOK {
		t.Fatalf("update role: %d %v", status, b)
	}

	// Find bob so we can reassign his roles.
	_, users := env.doList(t, "GET", "/api/v1/users/all")
	var bobID string
	for _, u := range users {
		if u["username"] == "bob" {
			bobID = u["id"].(string)
		}
	}
	if bobID == "" {
		t.Fatal("bob not found in the user list")
	}
	if status, b := env.do(t, "PATCH", "/api/v1/users/"+bobID+"/roles", map[string]any{
		"role_ids": []string{roleID},
	}); status != http.StatusOK {
		t.Fatalf("assign roles: %d %v", status, b)
	}

	// The member's own poll must see all three, so its client can react.
	status, feed := member.do(t, "GET", fmt.Sprintf("/api/v1/events?since=%d&limit=500", since), nil)
	if status != http.StatusOK {
		t.Fatalf("member polling events: %d %v", status, feed)
	}
	seen := map[string]bool{}
	for _, e := range feed["events"].([]any) {
		seen[e.(map[string]any)["type"].(string)] = true
	}
	for _, want := range []string{"ROLE_CREATED", "ROLE_UPDATED", "USER_ROLES_UPDATED"} {
		if !seen[want] {
			t.Errorf("no %s event was recorded; clients cannot notice the change", want)
		}
	}
}

// TestDeleteEventDoesNotBreakTheSyncFeed pins a bug that disabled delta sync
// library-wide. Events that carry no body store a NULL payload, and scanning
// NULL into the Event model's string field failed the whole query, not just
// that row: after the first delete of anything, every client's poll answered
// 500 for as long as the event stayed in the retention window. The client
// swallows poll errors, so live updates simply stopped, including any
// permission change a client was waiting to notice.
func TestDeleteEventDoesNotBreakTheSyncFeed(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	_, arch := env.do(t, "POST", "/api/v1/archives", map[string]any{"name": "Journal"})
	_, moment := env.do(t, "POST", "/api/v1/moments", map[string]any{
		"archive_id": arch["id"].(string),
		"title":      "Doomed",
		"content":    "about to be deleted",
	})
	if status, _ := env.do(t, "DELETE", "/api/v1/moments/"+moment["id"].(string), nil); status != http.StatusOK {
		t.Fatalf("delete moment: %d", status)
	}

	status, feed := env.do(t, "GET", "/api/v1/events?since=0&limit=500", nil)
	if status != http.StatusOK {
		t.Fatalf("polling events after a delete: %d %v, want 200", status, feed)
	}

	seen := false
	for _, e := range feed["events"].([]any) {
		eventMap := e.(map[string]any)
		if eventMap["type"] == "MOMENT_DELETED" {
			seen = true
			if p, ok := eventMap["payload"]; ok && p != nil && p != "" {
				t.Errorf("MOMENT_DELETED should carry no payload, got %v", p)
			}
		}
	}
	if !seen {
		t.Error("the MOMENT_DELETED event never reached the feed")
	}
}

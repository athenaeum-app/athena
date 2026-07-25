package api_test

import (
	"net/http"
	"net/http/cookiejar"
	"testing"
)

func TestLegacyStatsUnauthenticated(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	arch := mustCreateArchive(t, env, "Journal")
	mustCreateMoment(t, env, arch, "First entry", "Hello world from a moment")

	// A separate client with no session cookie: legacy stats must not
	// require auth, matching the athena-server v1 endpoint it replaces.
	jar, _ := cookiejar.New(nil)
	anon := &testEnv{srv: env.srv, client: &http.Client{Jar: jar}}

	status, body := anon.do(t, "GET", "/api/stats", nil)
	if status != http.StatusOK {
		t.Fatalf("expected 200 for unauthenticated legacy stats, got %d %v", status, body)
	}

	if body["total_moments"] != float64(1) {
		t.Errorf("expected total_moments=1, got %v", body["total_moments"])
	}
	if body["total_words"] != float64(5) {
		t.Errorf("expected total_words=5, got %v", body["total_words"])
	}
	if body["untagged_moments"] != float64(1) {
		t.Errorf("expected untagged_moments=1, got %v", body["untagged_moments"])
	}
	if body["moments_this_week"] != float64(1) {
		t.Errorf("expected moments_this_week=1, got %v", body["moments_this_week"])
	}
	if body["total_days_active"] != float64(1) {
		t.Errorf("expected total_days_active=1, got %v", body["total_days_active"])
	}
	for _, field := range []string{"total_tags", "total_assets", "total_archives", "total_messages",
		"avg_words_per_moment", "unique_chatters", "chat_messages_this_week", "total_assets_size"} {
		if _, ok := body[field]; !ok {
			t.Errorf("expected legacy stats to include %q, got %v", field, body)
		}
	}
}

func TestStatsRequiresAuthentication(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	jar, _ := cookiejar.New(nil)
	anon := &testEnv{srv: env.srv, client: &http.Client{Jar: jar}}

	status, _ := anon.do(t, "GET", "/api/v1/stats", nil)
	if status != http.StatusUnauthorized {
		t.Errorf("expected 401 for unauthenticated /api/v1/stats, got %d", status)
	}
}

// Stats are library counts, not host details, and the Menu widget that shows
// them is on by default for everyone. An invited member holding the default
// role (no admin permissions) has to be able to read them.
func TestStatsReadableByOrdinaryMember(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)
	member := env.invite(t, "mia")

	status, body := member.do(t, "GET", "/api/v1/stats", nil)
	if status != http.StatusOK {
		t.Fatalf("expected 200 for a member reading stats, got %d %v", status, body)
	}
	if _, ok := body["stats"].(map[string]any); !ok {
		t.Errorf("expected a stats object, got %v", body)
	}
}

func TestStatsIncludesNewFields(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	arch := mustCreateArchive(t, env, "Journal")
	mustCreateMoment(t, env, arch, "First entry", "one two three")

	status, body := env.do(t, "GET", "/api/v1/stats", nil)
	if status != http.StatusOK {
		t.Fatalf("get stats: %d %v", status, body)
	}
	stats, ok := body["stats"].(map[string]any)
	if !ok {
		t.Fatalf("expected stats object, got %v", body)
	}
	if stats["total_words"] != float64(3) {
		t.Errorf("expected total_words=3, got %v", stats["total_words"])
	}
	if stats["moments_this_week"] != float64(1) {
		t.Errorf("expected moments_this_week=1, got %v", stats["moments_this_week"])
	}
}

func mustCreateArchive(t *testing.T, env *testEnv, name string) string {
	t.Helper()
	status, arch := env.do(t, "POST", "/api/v1/archives", map[string]any{"name": name})
	if status != http.StatusCreated {
		t.Fatalf("create archive: %d %v", status, arch)
	}
	return arch["id"].(string)
}

func mustCreateMoment(t *testing.T, env *testEnv, archiveID, title, content string) string {
	t.Helper()
	status, moment := env.do(t, "POST", "/api/v1/moments", map[string]any{
		"archive_id": archiveID,
		"title":      title,
		"content":    content,
	})
	if status != http.StatusCreated {
		t.Fatalf("create moment: %d %v", status, moment)
	}
	return moment["id"].(string)
}

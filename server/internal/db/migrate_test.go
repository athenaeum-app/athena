package db

import (
	"path/filepath"
	"testing"
)

// A server upgrading from an earlier version carries invites that counted down
// to 0 and were left behind. Migration 0009 clears them out, and leaves both
// live and unlimited invites alone.
func TestMigration0009_ClearsExhaustedInvites(t *testing.T) {
	dir := t.TempDir()
	if err := Open(filepath.Join(dir, "test.db")); err != nil {
		t.Fatalf("open: %v", err)
	}
	defer DB.Close()

	// Simulate the pre-0009 state: rewind the recorded version and put back
	// rows the way an older server would have left them.
	if _, err := DB.Exec(`DELETE FROM schema_migrations WHERE version = 9`); err != nil {
		t.Fatalf("rewind: %v", err)
	}
	if _, err := DB.Exec(
		`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', 'x')`,
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	for _, r := range []struct {
		id   string
		uses int
	}{{"spent", 0}, {"live", 3}, {"unlimited", -1}} {
		if _, err := DB.Exec(
			`INSERT INTO invites (id, created_by, uses_remaining) VALUES (?, 'u1', ?)`, r.id, r.uses,
		); err != nil {
			t.Fatalf("seed invite %s: %v", r.id, err)
		}
	}

	if err := migrate(); err != nil {
		t.Fatalf("re-run migrations: %v", err)
	}

	for _, tc := range []struct {
		id   string
		want bool
	}{{"spent", false}, {"live", true}, {"unlimited", true}} {
		var n int
		if err := DB.QueryRow(`SELECT COUNT(*) FROM invites WHERE id = ?`, tc.id).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", tc.id, err)
		}
		if got := n == 1; got != tc.want {
			t.Errorf("invite %q present = %v, want %v", tc.id, got, tc.want)
		}
	}
}

package domain

import (
	"testing"

	"github.com/athenaeum-app/athena/server/internal/db"
)

// setupDB opens a fresh migrated database in a temp directory for each test.
func setupDB(t *testing.T) {
	t.Helper()
	path := t.TempDir() + "/test.db"
	if err := db.Open(path); err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
		db.DB = nil
	})
}

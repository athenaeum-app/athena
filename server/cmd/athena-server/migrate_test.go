package main

import (
	"database/sql"
	"testing"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/domain"
	_ "modernc.org/sqlite"
)

// openV1Fixture creates a minimal v1 database containing a single
// buffer_messages table with one row, timestamped with a raw RFC3339 string
// as v1 wrote them.
func openV1Fixture(t *testing.T, timestamp string) *sql.DB {
	t.Helper()
	path := t.TempDir() + "/v1.db"
	v1, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open v1 fixture: %v", err)
	}
	t.Cleanup(func() { v1.Close() })

	if _, err := v1.Exec(`CREATE TABLE buffer_messages (
		id TEXT PRIMARY KEY, author_name TEXT, content TEXT,
		timestamp TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0
	)`); err != nil {
		t.Fatalf("create buffer_messages: %v", err)
	}
	if _, err := v1.Exec(
		`INSERT INTO buffer_messages (id, author_name, content, timestamp, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)`,
		"legacy-1", "Old User", "a legacy message", timestamp, timestamp,
	); err != nil {
		t.Fatalf("insert legacy buffer_message: %v", err)
	}
	return v1
}

// openV2Fixture opens a fresh, migrated v2 database.
func openV2Fixture(t *testing.T) {
	t.Helper()
	path := t.TempDir() + "/v2.db"
	if err := db.Open(path); err != nil {
		t.Fatalf("open v2 db: %v", err)
	}
	t.Cleanup(func() {
		db.Close()
		db.DB = nil
	})
}

// TestMigrateChatMessages_OrderingSurvivesMigration reproduces the reported
// bug: after migrating a v1 chat message and then posting a brand-new v2
// message on the same calendar date, ListChatMessages must still return the
// new message first (it's chronologically later). Before the fix,
// migrateChatMessages wrote the v1 timestamp string through verbatim, which
// used a different text encoding than the driver uses for live time.Time
// writes; SQLite's ORDER BY does a byte-wise TEXT compare, so same-day
// legacy/live rows could sort in the wrong order.
func TestMigrateChatMessages_OrderingSurvivesMigration(t *testing.T) {
	openV2Fixture(t)

	// A legacy message from earlier today, in v1's raw string format.
	legacyTimestamp := time.Now().UTC().Add(-8 * time.Hour).Format(time.RFC3339)
	v1 := openV1Fixture(t, legacyTimestamp)

	summary := migrationSummary{}
	if err := migrateChatMessages(v1, db.DB, nil, &summary); err != nil {
		t.Fatalf("migrateChatMessages: %v", err)
	}
	if summary.chatMessages != 1 {
		t.Fatalf("expected 1 migrated chat message, got %d", summary.chatMessages)
	}

	live, err := domain.CreateChatMessage(nil, nil, "a brand new message")
	if err != nil {
		t.Fatalf("create live message: %v", err)
	}

	msgs, err := domain.ListChatMessages(nil, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].ID != live.ID {
		t.Errorf("expected the brand-new message to sort first (most recent), got %q first instead of %q", msgs[0].ID, live.ID)
	}
}

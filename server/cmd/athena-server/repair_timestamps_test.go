package main

import (
	"testing"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/domain"
)

// TestRepairTimestamps_FixesOrderingWithoutTouchingNativeRows simulates a v2
// database migrated before the timestamp fix: a chat_messages row with a raw
// v1-style timestamp string sitting alongside a normally-created live row.
// Before repair, ListChatMessages returns them in the wrong order (the bug
// reported against migrate); after repair, the order is correct, and the
// live row's canonical timestamp string is left byte-for-byte unchanged.
func TestRepairTimestamps_FixesOrderingWithoutTouchingNativeRows(t *testing.T) {
	openV2Fixture(t)

	live, err := domain.CreateChatMessage(nil, nil, "a brand new message")
	if err != nil {
		t.Fatalf("create live message: %v", err)
	}

	// A legacy row inserted the way pre-fix `migrate` would have: a raw v1
	// timestamp string, earlier on the same UTC day as the live row above.
	//
	// The day has to match. The bug is a within-day mis-sort. The two
	// encodings are byte-identical up to the character after the date, where
	// RFC3339's 'T' sorts after the Go format's ' ', so a legacy row from a
	// previous day sorts correctly and proves nothing. Pinning it to the start
	// of the live row's own day keeps that true at every hour; the earlier
	// "eight hours ago" form quietly stopped reproducing the bug (and tripped
	// the guard below) whenever the suite ran between 00:00 and 08:00 UTC.
	now := time.Now().UTC()
	legacyTimestamp := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Format(time.RFC3339)
	if _, err := db.DB.Exec(
		`INSERT INTO chat_messages (id, author_id, display_name, content, is_legacy, deleted_at, created_at, updated_at)
		 VALUES (?, NULL, ?, ?, 1, NULL, ?, ?)`,
		"legacy-1", "Old User", "a legacy message", legacyTimestamp, legacyTimestamp,
	); err != nil {
		t.Fatalf("insert legacy message: %v", err)
	}
	var liveRawBefore string
	if err := db.DB.QueryRow(`SELECT CAST(created_at AS TEXT) FROM chat_messages WHERE id = ?`, live.ID).Scan(&liveRawBefore); err != nil {
		t.Fatalf("read live raw created_at: %v", err)
	}

	// Confirm the bug is actually present before repairing (guards against
	// this test silently passing for the wrong reason).
	before, err := domain.ListChatMessages(nil, 10)
	if err != nil {
		t.Fatalf("list before repair: %v", err)
	}
	if before[0].ID != "legacy-1" {
		t.Fatalf("test setup didn't reproduce the bug: expected legacy-1 first before repair, got %q", before[0].ID)
	}

	if err := runRepairTimestamps(db.DB); err != nil {
		t.Fatalf("runRepairTimestamps: %v", err)
	}

	after, err := domain.ListChatMessages(nil, 10)
	if err != nil {
		t.Fatalf("list after repair: %v", err)
	}
	if len(after) != 2 || after[0].ID != live.ID {
		t.Fatalf("expected the live message first after repair, got order %v", []string{after[0].ID, after[1].ID})
	}

	var liveRawAfter string
	if err := db.DB.QueryRow(`SELECT CAST(created_at AS TEXT) FROM chat_messages WHERE id = ?`, live.ID).Scan(&liveRawAfter); err != nil {
		t.Fatalf("read live raw created_at after repair: %v", err)
	}
	if liveRawAfter != liveRawBefore {
		t.Errorf("repair modified an already-canonical live row: before=%q after=%q", liveRawBefore, liveRawAfter)
	}

	// Running it again should be a no-op (idempotent).
	if err := runRepairTimestamps(db.DB); err != nil {
		t.Fatalf("second runRepairTimestamps: %v", err)
	}
	again, err := domain.ListChatMessages(nil, 10)
	if err != nil {
		t.Fatalf("list after second repair: %v", err)
	}
	if again[0].ID != live.ID {
		t.Fatalf("order changed on second repair run: %v", []string{again[0].ID, again[1].ID})
	}
}

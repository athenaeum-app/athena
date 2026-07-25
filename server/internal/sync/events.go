// Package sync implements delta sync via versioned events, audit logging,
// database backups, and background pruning.
//
// Event recording and retrieval live here. Every mutation in the system
// calls RecordEvent so clients can stay current by polling events since
// their last known library version (see ADR-0007).
package sync

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
)

const (
	defaultEventLimit = 100
	maxEventLimit     = 500
)

// RecordEvent atomically bumps library_version and inserts an event row.
// The version increment and the insert run in a single transaction so that
// concurrent mutations receive distinct, sequential version numbers; this
// is the correctness invariant the delta sync protocol relies on.
//
// payload is JSON-encoded before storage. A nil payload produces a NULL
// payload column (used for DELETED events). The new library version is
// returned so callers can surface it in responses.
func RecordEvent(eventType, targetType, targetID string, authorID *string, payload any) (int64, error) {
	tx, err := db.DB.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin event transaction: %w", err)
	}
	defer tx.Rollback()

	var version int64
	if err := tx.QueryRow(`UPDATE library_meta SET library_version = library_version + 1 WHERE id = 1 RETURNING library_version`).Scan(&version); err != nil {
		return 0, fmt.Errorf("bump library_version: %w", err)
	}

	var payloadArg any
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return 0, fmt.Errorf("encode event payload: %w", err)
		}
		payloadArg = string(encoded)
	}

	var authorArg any
	if authorID != nil {
		authorArg = *authorID
	}

	if _, err := tx.Exec(
		`INSERT INTO events (library_version, type, target_type, target_id, author_id, payload) VALUES (?, ?, ?, ?, ?, ?)`,
		version, eventType, targetType, targetID, authorArg, payloadArg,
	); err != nil {
		return 0, fmt.Errorf("insert event: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit event transaction: %w", err)
	}
	return version, nil
}

// GetEventsSince returns events with library_version > sinceVersion, ordered
// ascending by version. limit is clamped to (0, maxEventLimit] with
// defaultEventLimit used when limit <= 0. This is the data source for the
// delta sync endpoint.
func GetEventsSince(sinceVersion int64, limit int) ([]models.Event, error) {
	if limit <= 0 {
		limit = defaultEventLimit
	}
	if limit > maxEventLimit {
		limit = maxEventLimit
	}

	rows, err := db.DB.Query(
		`SELECT id, library_version, type, target_type, target_id, author_id, payload, created_at
		 FROM events
		 WHERE library_version > ?
		 ORDER BY library_version ASC
		 LIMIT ?`,
		sinceVersion, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query events: %w", err)
	}
	defer rows.Close()

	events := []models.Event{}
	for rows.Next() {
		var e models.Event
		// payload is nullable and RecordEvent deliberately writes NULL for
		// events that carry no body (every *_DELETED, and the role events).
		// Scanning that straight into a string fails, and because the failure
		// is per-query rather than per-row it took the whole feed down: one
		// delete anywhere in the retention window made every client's poll
		// return 500 forever, silently killing delta sync for the library.
		var payload sql.NullString
		if err := rows.Scan(&e.ID, &e.LibraryVersion, &e.Type, &e.TargetType, &e.TargetID, &e.AuthorID, &payload, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		e.Payload = payload.String
		events = append(events, e)
	}
	return events, rows.Err()
}

// GetCurrentVersion reads the singleton library_meta row's library_version.
func GetCurrentVersion() (int64, error) {
	var version int64
	err := db.DB.QueryRow(`SELECT library_version FROM library_meta WHERE id = 1`).Scan(&version)
	if err != nil {
		return 0, fmt.Errorf("query current library version: %w", err)
	}
	return version, nil
}

// PruneEvents deletes events older than olderThanDays and returns the count
// removed. The events table is pruned aggressively (90 days default per
// ADR-0010) since it is a compact sync log, not a durable audit trail.
func PruneEvents(olderThanDays int) (int64, error) {
	res, err := db.DB.Exec(
		`DELETE FROM events WHERE created_at < datetime('now', ?)`,
		fmt.Sprintf("-%d days", olderThanDays),
	)
	if err != nil {
		return 0, fmt.Errorf("prune events: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("get pruned event count: %w", err)
	}
	return n, nil
}

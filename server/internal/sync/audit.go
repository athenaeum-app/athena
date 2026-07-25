package sync

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
)

const (
	defaultAuditLimit = 100
	maxAuditLimit     = 500
)

// AuditCursor is the opaque pagination cursor for GetAuditLog. It carries
// the last-seen audit entry id so callers can page backwards (newest first)
// without skipping or duplicating rows.
type AuditCursor struct {
	ID int64
}

// RecordAudit inserts a row into audit_log. The audit log is the durable
// "who did what" record (ADR-0010): it overlaps in content with events but
// is retained longer (365 days default) and is never merged with events.
// details is JSON-encoded; a nil details yields a NULL column.
func RecordAudit(actorID, action, targetType, targetID string, details any) error {
	var detailsArg any
	if details != nil {
		encoded, err := json.Marshal(details)
		if err != nil {
			return fmt.Errorf("encode audit details: %w", err)
		}
		detailsArg = string(encoded)
	}

	_, err := db.DB.Exec(
		`INSERT INTO audit_log (actor_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)`,
		actorID, action, targetType, targetID, detailsArg,
	)
	if err != nil {
		return fmt.Errorf("insert audit entry: %w", err)
	}
	return nil
}

// GetAuditLog returns audit entries newest-first using cursor pagination.
// A nil cursor starts from the newest entry; a non-nil cursor returns
// entries with id strictly less than cursor.ID. limit is clamped to
// (0, maxAuditLimit] with defaultAuditLimit as the default. The next
// cursor is the id of the last returned entry (callers track it
// themselves; this function does not return it).
func GetAuditLog(cursor *AuditCursor, limit int) ([]models.AuditEntry, error) {
	if limit <= 0 {
		limit = defaultAuditLimit
	}
	if limit > maxAuditLimit {
		limit = maxAuditLimit
	}

	var (
		rows *sql.Rows
		err  error
	)
	if cursor == nil {
		rows, err = db.DB.Query(
			`SELECT id, actor_id, action, target_type, target_id, details, created_at
			 FROM audit_log
			 ORDER BY id DESC
			 LIMIT ?`,
			limit,
		)
	} else {
		rows, err = db.DB.Query(
			`SELECT id, actor_id, action, target_type, target_id, details, created_at
			 FROM audit_log
			 WHERE id < ?
			 ORDER BY id DESC
			 LIMIT ?`,
			cursor.ID, limit,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("query audit log: %w", err)
	}
	defer rows.Close()

	entries := []models.AuditEntry{}
	for rows.Next() {
		var e models.AuditEntry
		if err := rows.Scan(&e.ID, &e.ActorID, &e.Action, &e.TargetType, &e.TargetID, &e.Details, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan audit entry: %w", err)
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// PruneAuditLog deletes audit entries older than olderThanDays and returns
// the count removed. The audit log is retained longer than the events
// table (ADR-0010).
func PruneAuditLog(olderThanDays int) (int64, error) {
	res, err := db.DB.Exec(
		`DELETE FROM audit_log WHERE created_at < datetime('now', ?)`,
		fmt.Sprintf("-%d days", olderThanDays),
	)
	if err != nil {
		return 0, fmt.Errorf("prune audit log: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("get pruned audit count: %w", err)
	}
	return n, nil
}

package domain

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/google/uuid"
)

// MomentCursor is the compound cursor for moment pagination. Results are
// ordered by (timestamp DESC, id DESC); a cursor identifies the last item
// already seen so the next page starts strictly after it.
type MomentCursor struct {
	Timestamp time.Time
	ID        string
}

// MomentFilter carries the optional feed filters added in v2.2 (date range +
// media/source). A nil *MomentFilter means "no extra filtering". Date bounds
// are inclusive and matched against the `timestamp` column (feed order, not
// created_at). HasMedia/HasLink are content heuristics (ADR-0014 / v2.2 plan):
// the schema has no asset<->moment link, so we scan `content` for an asset URL
// path ("has media") or any http(s) URL ("has link"). This mirrors what v1
// effectively did; it is fuzzy and unindexed but needs no migration.
type MomentFilter struct {
	From     *time.Time
	To       *time.Time
	HasMedia bool
	HasLink  bool
}

// appendMomentFilter appends the MomentFilter's WHERE clauses to an existing
// query being built with incremental " AND ..." concatenation. prefix is the
// column qualifier ("" for the plain moments table, "moment." for the FTS join).
// The LIKE patterns are compile-time constants (no user input), so they are
// inlined rather than bound; the date bounds are bound parameters.
func appendMomentFilter(q string, args []any, filter *MomentFilter, prefix string) (string, []any) {
	if filter == nil {
		return q, args
	}
	if filter.From != nil {
		q += ` AND ` + prefix + `timestamp >= ?`
		args = append(args, *filter.From)
	}
	if filter.To != nil {
		q += ` AND ` + prefix + `timestamp <= ?`
		args = append(args, *filter.To)
	}
	if filter.HasMedia {
		q += ` AND ` + prefix + `content LIKE '%/api/v1/assets/%'`
	}
	if filter.HasLink {
		q += ` AND ` + prefix + `content LIKE '%http%'`
	}
	return q, args
}

// CreateMoment inserts a new moment, sets its timestamp to now, and links
// the given tag IDs via moment_tags. authorID may be empty for migrated
// legacy entries.
func CreateMoment(archiveID, authorID, title, content string, tagIDs []string) (*models.Moment, error) {
	now := time.Now().UTC()
	moment := &models.Moment{
		ID:        uuid.NewString(),
		ArchiveID: archiveID,
		Title:     title,
		Content:   content,
		Timestamp: now,
		CreatedAt: now,
		UpdatedAt: now,
		TagIDs:    tagIDs,
	}
	if authorID != "" {
		aid := authorID
		moment.AuthorID = &aid
	}

	tx, err := db.DB.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`INSERT INTO moments (id, archive_id, author_id, title, content, timestamp, is_legacy, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		moment.ID, moment.ArchiveID, moment.AuthorID, moment.Title, moment.Content, moment.Timestamp, moment.CreatedAt, moment.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("insert moment: %w", err)
	}

	if err := insertMomentTags(tx, moment.ID, tagIDs); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit moment: %w", err)
	}
	return moment, nil
}

// GetMoment fetches a single moment including its tag IDs. Returns nil
// (without error) if not found.
func GetMoment(id string) (*models.Moment, error) {
	moment := &models.Moment{}
	var deletedAt sql.NullTime
	err := db.DB.QueryRow(
		`SELECT id, archive_id, author_id, title, content, timestamp, is_legacy, pinned, deleted_at, created_at, updated_at
		 FROM moments WHERE id = ?`,
		id,
	).Scan(&moment.ID, &moment.ArchiveID, &moment.AuthorID, &moment.Title, &moment.Content, &moment.Timestamp, &moment.IsLegacy, &moment.Pinned, &deletedAt, &moment.CreatedAt, &moment.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get moment %s: %w", id, err)
	}
	if deletedAt.Valid {
		moment.DeletedAt = &deletedAt.Time
	}

	tags, err := getMomentTags(id)
	if err != nil {
		return nil, err
	}
	moment.TagIDs = tags
	return moment, nil
}

// ListMoments returns a page of non-deleted moments, optionally scoped to
// an archive. archiveID nil means across all archives. cursor nil means
// first page. limit <= 0 is clamped to a sane default.
func ListMoments(archiveID *string, cursor *MomentCursor, limit int, filter *MomentFilter) ([]models.Moment, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}

	selectSQL := `SELECT id, archive_id, author_id, title, content, timestamp, is_legacy, pinned, deleted_at, created_at, updated_at
	      FROM moments
	      WHERE deleted_at IS NULL`
	args := []any{}
	if archiveID != nil {
		selectSQL += ` AND archive_id = ?`
		args = append(args, *archiveID)
	}
	selectSQL, args = appendMomentFilter(selectSQL, args, filter, "")
	if cursor != nil {
		selectSQL += ` AND (timestamp < ? OR (timestamp = ? AND id < ?))`
		args = append(args, cursor.Timestamp, cursor.Timestamp, cursor.ID)
	}
	selectSQL += ` ORDER BY timestamp DESC, id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := db.DB.Query(selectSQL, args...)
	if err != nil {
		return nil, fmt.Errorf("list moments: %w", err)
	}
	defer rows.Close()
	return scanMoments(rows)
}

// SearchMoments runs an FTS5 query against moments_fts, joins back to
// moments, optionally filters by archive, and applies cursor pagination.
func SearchMoments(query string, archiveID *string, cursor *MomentCursor, limit int, filter *MomentFilter) ([]models.Moment, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}

	selectSQL := `SELECT moment.id, moment.archive_id, moment.author_id, moment.title, moment.content, moment.timestamp, moment.is_legacy, moment.pinned, moment.deleted_at, moment.created_at, moment.updated_at
	      FROM moments_fts fts
	      JOIN moments moment ON moment.rowid = fts.rowid
	      WHERE moments_fts MATCH ? AND moment.deleted_at IS NULL`
	args := []any{query}
	if archiveID != nil {
		selectSQL += ` AND moment.archive_id = ?`
		args = append(args, *archiveID)
	}
	selectSQL, args = appendMomentFilter(selectSQL, args, filter, "moment.")
	if cursor != nil {
		selectSQL += ` AND (moment.timestamp < ? OR (moment.timestamp = ? AND moment.id < ?))`
		args = append(args, cursor.Timestamp, cursor.Timestamp, cursor.ID)
	}
	selectSQL += ` ORDER BY rank LIMIT ?`
	args = append(args, limit)

	rows, err := db.DB.Query(selectSQL, args...)
	if err != nil {
		return nil, fmt.Errorf("search moments: %w", err)
	}
	defer rows.Close()
	return scanMoments(rows)
}

// UpdateMoment replaces title/content and the full set of tag IDs, and
// bumps updated_at. The returned moment reflects the new state so the API
// layer can use updated_at for If-Match conflict detection.
func UpdateMoment(id, title, content string, tagIDs []string) (*models.Moment, error) {
	now := time.Now().UTC()

	tx, err := db.DB.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	res, err := tx.Exec(
		`UPDATE moments SET title = ?, content = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
		title, content, now, id,
	)
	if err != nil {
		return nil, fmt.Errorf("update moment %s: %w", id, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, nil
	}

	if _, err := tx.Exec(`DELETE FROM moment_tags WHERE moment_id = ?`, id); err != nil {
		return nil, fmt.Errorf("clear moment_tags: %w", err)
	}
	if err := insertMomentTags(tx, id, tagIDs); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit moment update: %w", err)
	}
	return GetMoment(id)
}

// ListPinnedMoments returns all non-deleted pinned moments, newest first.
// Pins are library-shared: everyone sees the same pinned set, so this
// is unpaginated (the pinned set is expected to stay small).
func ListPinnedMoments() ([]models.Moment, error) {
	rows, err := db.DB.Query(
		`SELECT id, archive_id, author_id, title, content, timestamp, is_legacy, pinned, deleted_at, created_at, updated_at
		 FROM moments
		 WHERE deleted_at IS NULL AND pinned = 1
		 ORDER BY timestamp DESC, id DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("list pinned moments: %w", err)
	}
	defer rows.Close()
	return scanMoments(rows)
}

// SetMomentPinned sets the pinned flag on a moment and bumps updated_at.
// Returns the updated moment, or nil if the moment does not exist / is
// soft-deleted.
func SetMomentPinned(id string, pinned bool) (*models.Moment, error) {
	res, err := db.DB.Exec(
		`UPDATE moments SET pinned = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
		pinned, time.Now().UTC(), id,
	)
	if err != nil {
		return nil, fmt.Errorf("set moment %s pinned: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, nil
	}
	return GetMoment(id)
}

// DeleteMoment soft-deletes a moment by setting deleted_at.
func DeleteMoment(id string) error {
	_, err := db.DB.Exec(
		`UPDATE moments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
		time.Now().UTC(), id,
	)
	if err != nil {
		return fmt.Errorf("soft-delete moment %s: %w", id, err)
	}
	return nil
}

// RestoreMoment clears deleted_at.
func RestoreMoment(id string) error {
	_, err := db.DB.Exec(
		`UPDATE moments SET deleted_at = NULL WHERE id = ?`,
		id,
	)
	if err != nil {
		return fmt.Errorf("restore moment %s: %w", id, err)
	}
	return nil
}

// PruneDeletedMoments hard-deletes moments soft-deleted more than
// olderThanDays ago. Returns the number of rows deleted.
func PruneDeletedMoments(olderThanDays int) (int64, error) {
	cutoff := time.Now().UTC().Add(time.Duration(-olderThanDays) * 24 * time.Hour)
	res, err := db.DB.Exec(
		`DELETE FROM moments WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
		cutoff,
	)
	if err != nil {
		return 0, fmt.Errorf("prune moments: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// insertMomentTags inserts the moment_tags join rows for the given tags.
// Unknown tag IDs are skipped silently; the API layer is expected to
// validate tags before calling.
func insertMomentTags(tx *sql.Tx, momentID string, tagIDs []string) error {
	if len(tagIDs) == 0 {
		return nil
	}
	stmt, err := tx.Prepare(`INSERT INTO moment_tags (moment_id, tag_id) VALUES (?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare moment_tags insert: %w", err)
	}
	defer stmt.Close()
	for _, t := range tagIDs {
		if _, err := stmt.Exec(momentID, t); err != nil {
			return fmt.Errorf("insert moment_tag (%s, %s): %w", momentID, t, err)
		}
	}
	return nil
}

func getMomentTags(momentID string) ([]string, error) {
	rows, err := db.DB.Query(
		`SELECT tag_id FROM moment_tags WHERE moment_id = ? ORDER BY tag_id`,
		momentID,
	)
	if err != nil {
		return nil, fmt.Errorf("get moment_tags: %w", err)
	}
	defer rows.Close()

	var tags []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, fmt.Errorf("scan moment_tag: %w", err)
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

func scanMoments(rows *sql.Rows) ([]models.Moment, error) {
	// Initialize as a non-nil empty slice so an empty result marshals to a
	// JSON `[]` rather than `null` (the client expects an array).
	out := []models.Moment{}
	ids := []string{}
	for rows.Next() {
		var moment models.Moment
		var deletedAt sql.NullTime
		if err := rows.Scan(&moment.ID, &moment.ArchiveID, &moment.AuthorID, &moment.Title, &moment.Content, &moment.Timestamp, &moment.IsLegacy, &moment.Pinned, &deletedAt, &moment.CreatedAt, &moment.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan moment: %w", err)
		}
		if deletedAt.Valid {
			moment.DeletedAt = &deletedAt.Time
		}
		out = append(out, moment)
		ids = append(ids, moment.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return out, nil
	}

	tagMap, err := getTagsForMoments(ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].TagIDs = tagMap[out[i].ID]
	}
	return out, nil
}

// getTagsForMoments batches a single query for the tag IDs of all given
// moments, returning a map of momentID -> []tagID.
func getTagsForMoments(momentIDs []string) (map[string][]string, error) {
	placeholders := strings.Repeat("?,", len(momentIDs))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, len(momentIDs))
	for i, id := range momentIDs {
		args[i] = id
	}
	rows, err := db.DB.Query(
		`SELECT moment_id, tag_id FROM moment_tags WHERE moment_id IN (`+placeholders+`) ORDER BY moment_id, tag_id`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("get tags for moments: %w", err)
	}
	defer rows.Close()

	tagsByMoment := map[string][]string{}
	for rows.Next() {
		var momentID, tagID string
		if err := rows.Scan(&momentID, &tagID); err != nil {
			return nil, fmt.Errorf("scan moment_tag: %w", err)
		}
		tagsByMoment[momentID] = append(tagsByMoment[momentID], tagID)
	}
	return tagsByMoment, rows.Err()
}

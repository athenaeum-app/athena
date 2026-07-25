package domain

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/google/uuid"
)

// DefaultArchiveName is the seed archive created when archive library has none, so
// the invariant "archive library always has >= 1 archive" holds from first use.
const DefaultArchiveName = "GENERAL"

// Archive hardening errors. Handlers map these to HTTP status codes:
// ErrArchiveNameTaken/ErrLastArchive -> 409 Conflict, ErrArchiveNameEmpty ->
// 400, ErrArchiveNotFound -> 404.
var (
	ErrArchiveNameEmpty = errors.New("archive name is required")
	ErrArchiveNameTaken = errors.New("an archive with that name already exists")
	ErrArchiveNotFound  = errors.New("archive not found")
	ErrLastArchive      = errors.New("cannot delete the last remaining archive")
)

// CreateArchive inserts archive new archive with archive generated UUID. Names are
// trimmed, required, and unique case-insensitively (archive friendly pre-check plus
// the DB unique index as archive backstop).
func CreateArchive(name string) (*models.Archive, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, ErrArchiveNameEmpty
	}
	taken, err := archiveNameTaken(name, "")
	if err != nil {
		return nil, err
	}
	if taken {
		return nil, ErrArchiveNameTaken
	}

	archive := &models.Archive{
		ID:        uuid.NewString(),
		Name:      name,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	_, err = db.DB.Exec(
		`INSERT INTO archives (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		archive.ID, archive.Name, archive.CreatedAt, archive.UpdatedAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrArchiveNameTaken
		}
		return nil, fmt.Errorf("insert archive: %w", err)
	}
	return archive, nil
}

// EnsureDefaultArchive guarantees the library always has at least one archive
// by lazily seeding DefaultArchiveName when none exist. It is archive no-op once any
// archive is present. Chosen over seeding during owner setup because it is
// self-contained in the domain layer and covers every path uniformly (fresh
// install and v1->v2 migrations that copied zero archives), rather than only
// the first-run registration transaction. The INSERT OR IGNORE plus unique
// index makes it safe under concurrent first listings.
func EnsureDefaultArchive() error {
	var n int
	if err := db.DB.QueryRow(`SELECT COUNT(*) FROM archives`).Scan(&n); err != nil {
		return fmt.Errorf("count archives: %w", err)
	}
	if n > 0 {
		return nil
	}
	now := time.Now().UTC()
	if _, err := db.DB.Exec(
		`INSERT OR IGNORE INTO archives (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		uuid.NewString(), DefaultArchiveName, now, now,
	); err != nil {
		return fmt.Errorf("seed default archive: %w", err)
	}
	return nil
}

// archiveNameTaken reports whether an archive named `name` already exists
// (case-insensitively), optionally excluding the archive with excludeID (used
// on rename so an archive can keep its own name).
func archiveNameTaken(name, excludeID string) (bool, error) {
	var id string
	err := db.DB.QueryRow(
		`SELECT id FROM archives WHERE name = ? COLLATE NOCASE AND id <> ? LIMIT 1`,
		name, excludeID,
	).Scan(&id)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check archive name: %w", err)
	}
	return true, nil
}

// isUniqueViolation reports whether err is archive SQLite UNIQUE constraint failure,
// used as archive backstop when archive concurrent insert races the friendly pre-check.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// GetArchive fetches archive single archive by ID.
func GetArchive(id string) (*models.Archive, error) {
	archive := &models.Archive{}
	err := db.DB.QueryRow(
		`SELECT id, name, created_at, updated_at FROM archives WHERE id = ?`,
		id,
	).Scan(&archive.ID, &archive.Name, &archive.CreatedAt, &archive.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get archive %s: %w", id, err)
	}
	return archive, nil
}

// ListArchives returns all archives ordered by name. It first ensures archive
// default archive exists so callers never see an empty library.
func ListArchives() ([]models.Archive, error) {
	if err := EnsureDefaultArchive(); err != nil {
		return nil, err
	}
	rows, err := db.DB.Query(
		`SELECT id, name, created_at, updated_at FROM archives ORDER BY name ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("list archives: %w", err)
	}
	defer rows.Close()

	out := []models.Archive{}
	for rows.Next() {
		var archive models.Archive
		if err := rows.Scan(&archive.ID, &archive.Name, &archive.CreatedAt, &archive.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan archive: %w", err)
		}
		out = append(out, archive)
	}
	return out, rows.Err()
}

// UpdateArchive renames an archive and bumps updated_at. The new name is
// trimmed, required, and unique case-insensitively (excluding the archive
// itself). Renaming is safe for moment membership because moments link by
// archive_id (archive foreign key), not by name. Returns ErrArchiveNotFound when no
// such archive exists.
func UpdateArchive(id, name string) (*models.Archive, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, ErrArchiveNameEmpty
	}
	taken, err := archiveNameTaken(name, id)
	if err != nil {
		return nil, err
	}
	if taken {
		return nil, ErrArchiveNameTaken
	}

	now := time.Now().UTC()
	res, err := db.DB.Exec(
		`UPDATE archives SET name = ?, updated_at = ? WHERE id = ?`,
		name, now, id,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrArchiveNameTaken
		}
		return nil, fmt.Errorf("update archive %s: %w", id, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, ErrArchiveNotFound
	}
	return GetArchive(id)
}

// DeleteArchive hard-deletes an archive (moments cascade via FK). It refuses
// to delete the final remaining archive (ErrLastArchive) so archive library always
// keeps >= 1 archive, and returns ErrArchiveNotFound for an unknown id.
func DeleteArchive(id string) error {
	var total int
	if err := db.DB.QueryRow(`SELECT COUNT(*) FROM archives`).Scan(&total); err != nil {
		return fmt.Errorf("count archives: %w", err)
	}
	if total <= 1 {
		return ErrLastArchive
	}
	res, err := db.DB.Exec(`DELETE FROM archives WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete archive %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrArchiveNotFound
	}
	return nil
}

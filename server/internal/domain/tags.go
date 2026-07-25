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

// CreateTag inserts a new tag with a generated UUID.
func CreateTag(name, color string) (*models.Tag, error) {
	now := time.Now().UTC()
	tag := &models.Tag{
		ID:        uuid.NewString(),
		Name:      name,
		Color:     color,
		CreatedAt: now,
		UpdatedAt: now,
	}
	_, err := db.DB.Exec(
		`INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		tag.ID, tag.Name, tag.Color, tag.CreatedAt, tag.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert tag: %w", err)
	}
	return tag, nil
}

// GetTag fetches a single tag by ID. Returns nil if not found.
func GetTag(id string) (*models.Tag, error) {
	tag := &models.Tag{}
	err := db.DB.QueryRow(
		`SELECT id, name, color, created_at, updated_at FROM tags WHERE id = ?`,
		id,
	).Scan(&tag.ID, &tag.Name, &tag.Color, &tag.CreatedAt, &tag.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get tag %s: %w", id, err)
	}
	return tag, nil
}

// ListTags returns all tags ordered by name.
func ListTags() ([]models.Tag, error) {
	rows, err := db.DB.Query(
		`SELECT id, name, color, created_at, updated_at FROM tags ORDER BY name ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("list tags: %w", err)
	}
	defer rows.Close()

	out := []models.Tag{}
	for rows.Next() {
		var tag models.Tag
		if err := rows.Scan(&tag.ID, &tag.Name, &tag.Color, &tag.CreatedAt, &tag.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan tag: %w", err)
		}
		out = append(out, tag)
	}
	return out, rows.Err()
}

// UpdateTag performs a partial update: only non-nil fields are written.
func UpdateTag(id string, name, color *string) (*models.Tag, error) {
	now := time.Now().UTC()

	sets := []string{}
	args := []any{}
	if name != nil {
		sets = append(sets, "name = ?")
		args = append(args, *name)
	}
	if color != nil {
		sets = append(sets, "color = ?")
		args = append(args, *color)
	}
	if len(sets) == 0 {
		return GetTag(id)
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, now, id)

	updateSQL := `UPDATE tags SET ` + strings.Join(sets, ", ") + ` WHERE id = ?`
	res, err := db.DB.Exec(updateSQL, args...)
	if err != nil {
		return nil, fmt.Errorf("update tag %s: %w", id, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, nil
	}
	return GetTag(id)
}

// RecolorTags applies new colors to many tags in a single transaction.
// colorByID maps tag ID -> new color; unknown IDs are ignored. Returns the
// full updated tag set so the API layer can emit per-tag sync events.
func RecolorTags(colorByID map[string]string) ([]models.Tag, error) {
	if len(colorByID) == 0 {
		return ListTags()
	}
	now := time.Now().UTC()

	tx, err := db.DB.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin recolor tx: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`UPDATE tags SET color = ?, updated_at = ? WHERE id = ?`)
	if err != nil {
		return nil, fmt.Errorf("prepare recolor: %w", err)
	}
	defer stmt.Close()
	for id, color := range colorByID {
		if _, err := stmt.Exec(color, now, id); err != nil {
			return nil, fmt.Errorf("recolor tag %s: %w", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit recolor: %w", err)
	}
	return ListTags()
}

// DeleteTag hard-deletes a tag. moment_tags rows cascade via FK.
func DeleteTag(id string) error {
	_, err := db.DB.Exec(`DELETE FROM tags WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete tag %s: %w", id, err)
	}
	return nil
}

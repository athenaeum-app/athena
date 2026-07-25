package domain

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/google/uuid"
)

// ChatCursor is the cursor for chat pagination. Results are ordered by
// created_at DESC, so a cursor identifies the last message already seen.
type ChatCursor struct {
	CreatedAt time.Time
	ID        string
}

// CreateChatMessage inserts a new chat message. authorID nil marks a legacy
// message (used during migration only); new messages always carry an author.
func CreateChatMessage(authorID *string, displayName *string, content string) (*models.ChatMessage, error) {
	now := time.Now().UTC()
	message := &models.ChatMessage{
		ID:          uuid.NewString(),
		AuthorID:    authorID,
		DisplayName: displayName,
		Content:     content,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	_, err := db.DB.Exec(
		`INSERT INTO chat_messages (id, author_id, display_name, content, is_legacy, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 0, ?, ?)`,
		message.ID, message.AuthorID, message.DisplayName, message.Content, message.CreatedAt, message.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert chat message: %w", err)
	}
	return message, nil
}

// GetChatMessage fetches a single chat message by ID. Returns nil if not found.
func GetChatMessage(id string) (*models.ChatMessage, error) {
	message := &models.ChatMessage{}
	var deletedAt sql.NullTime
	err := db.DB.QueryRow(
		`SELECT id, author_id, display_name, content, is_legacy, deleted_at, created_at, updated_at
		 FROM chat_messages WHERE id = ?`,
		id,
	).Scan(&message.ID, &message.AuthorID, &message.DisplayName, &message.Content, &message.IsLegacy, &deletedAt, &message.CreatedAt, &message.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get chat message %s: %w", id, err)
	}
	if deletedAt.Valid {
		message.DeletedAt = &deletedAt.Time
	}
	return message, nil
}

// ListChatMessages returns a page of non-deleted chat messages ordered by
// created_at DESC. cursor nil means first page.
func ListChatMessages(cursor *ChatCursor, limit int) ([]models.ChatMessage, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}

	query := `SELECT id, author_id, display_name, content, is_legacy, deleted_at, created_at, updated_at
	      FROM chat_messages
	      WHERE deleted_at IS NULL`
	args := []any{}
	if cursor != nil {
		query += ` AND (created_at < ? OR (created_at = ? AND id < ?))`
		args = append(args, cursor.CreatedAt, cursor.CreatedAt, cursor.ID)
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := db.DB.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list chat messages: %w", err)
	}
	defer rows.Close()

	out := []models.ChatMessage{}
	for rows.Next() {
		var message models.ChatMessage
		var deletedAt sql.NullTime
		if err := rows.Scan(&message.ID, &message.AuthorID, &message.DisplayName, &message.Content, &message.IsLegacy, &deletedAt, &message.CreatedAt, &message.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan chat message: %w", err)
		}
		if deletedAt.Valid {
			message.DeletedAt = &deletedAt.Time
		}
		out = append(out, message)
	}
	return out, rows.Err()
}

// UpdateChatMessage edits the content of a message and bumps updated_at.
func UpdateChatMessage(id, content string) (*models.ChatMessage, error) {
	now := time.Now().UTC()
	res, err := db.DB.Exec(
		`UPDATE chat_messages SET content = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
		content, now, id,
	)
	if err != nil {
		return nil, fmt.Errorf("update chat message %s: %w", id, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, nil
	}
	return GetChatMessage(id)
}

// DeleteChatMessage soft-deletes a chat message.
func DeleteChatMessage(id string) error {
	_, err := db.DB.Exec(
		`UPDATE chat_messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
		time.Now().UTC(), id,
	)
	if err != nil {
		return fmt.Errorf("soft-delete chat message %s: %w", id, err)
	}
	return nil
}

// PruneDeletedChatMessages hard-deletes chat messages soft-deleted more
// than olderThanDays ago. Returns the number of rows deleted.
func PruneDeletedChatMessages(olderThanDays int) (int64, error) {
	cutoff := time.Now().UTC().Add(time.Duration(-olderThanDays) * 24 * time.Hour)
	res, err := db.DB.Exec(
		`DELETE FROM chat_messages WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
		cutoff,
	)
	if err != nil {
		return 0, fmt.Errorf("prune chat messages: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

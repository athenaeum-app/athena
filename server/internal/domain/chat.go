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

// ChatCursor is the cursor for chat pagination. Results are ordered by
// created_at DESC, so a cursor identifies the last message already seen.
type ChatCursor struct {
	CreatedAt time.Time
	ID        string
}

// CreateChatMessage inserts a new chat message. authorID nil marks a legacy
// message (used during migration only); new messages always carry an author.
// replyToID nil is an ordinary message; set makes it a reply to that message.
func CreateChatMessage(authorID *string, displayName *string, content string, replyToID *string) (*models.ChatMessage, error) {
	now := time.Now().UTC()
	message := &models.ChatMessage{
		ID:          uuid.NewString(),
		AuthorID:    authorID,
		DisplayName: displayName,
		Content:     content,
		ReplyToID:   replyToID,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	_, err := db.DB.Exec(
		`INSERT INTO chat_messages (id, author_id, display_name, content, is_legacy, reply_to_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
		message.ID, message.AuthorID, message.DisplayName, message.Content, message.ReplyToID, message.CreatedAt, message.UpdatedAt,
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
		`SELECT id, author_id, display_name, content, is_legacy, reply_to_id, deleted_at, created_at, updated_at
		 FROM chat_messages WHERE id = ?`,
		id,
	).Scan(&message.ID, &message.AuthorID, &message.DisplayName, &message.Content, &message.IsLegacy, &message.ReplyToID, &deletedAt, &message.CreatedAt, &message.UpdatedAt)
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

	query := `SELECT id, author_id, display_name, content, is_legacy, reply_to_id, deleted_at, created_at, updated_at
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
	return scanChatMessages(rows)
}

func scanChatMessages(rows *sql.Rows) ([]models.ChatMessage, error) {
	out := []models.ChatMessage{}
	for rows.Next() {
		var message models.ChatMessage
		var deletedAt sql.NullTime
		if err := rows.Scan(&message.ID, &message.AuthorID, &message.DisplayName, &message.Content, &message.IsLegacy, &message.ReplyToID, &deletedAt, &message.CreatedAt, &message.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan chat message: %w", err)
		}
		if deletedAt.Valid {
			message.DeletedAt = &deletedAt.Time
		}
		out = append(out, message)
	}
	return out, rows.Err()
}

// AttachChatReplies fills in the ReplyTo preview of every message in a page
// that is a reply, in one query for the whole page.
//
// Done as a second query rather than a join. The row a reply points at is very
// often another message in the same page, and a join would send its text down
// twice; it also has to reach soft-deleted rows, which the page itself excludes,
// so the join would be an outer one against a different WHERE. Ids repeat too:
// ten answers to the same message read it once here.
//
// A reply whose parent has been pruned outright keeps no preview and no
// reply_to_id either, because the foreign key nulls the column, so it reads as
// the ordinary message it now is.
func AttachChatReplies(messages []models.ChatMessage) error {
	wanted := map[string]bool{}
	for _, message := range messages {
		if message.ReplyToID != nil {
			wanted[*message.ReplyToID] = true
		}
	}
	if len(wanted) == 0 {
		return nil
	}

	ids := make([]any, 0, len(wanted))
	placeholders := make([]string, 0, len(wanted))
	for id := range wanted {
		ids = append(ids, id)
		placeholders = append(placeholders, "?")
	}

	rows, err := db.DB.Query(
		`SELECT id, author_id, display_name, content, deleted_at
		 FROM chat_messages WHERE id IN (`+strings.Join(placeholders, ", ")+`)`,
		ids...,
	)
	if err != nil {
		return fmt.Errorf("list replied-to chat messages: %w", err)
	}
	defer rows.Close()

	previews := map[string]models.ChatReply{}
	for rows.Next() {
		var preview models.ChatReply
		var deletedAt sql.NullTime
		if err := rows.Scan(&preview.ID, &preview.AuthorID, &preview.DisplayName, &preview.Content, &deletedAt); err != nil {
			return fmt.Errorf("scan replied-to chat message: %w", err)
		}
		if deletedAt.Valid {
			// The flag is the whole answer: a message deleted for everyone
			// must not travel on in the reply that quoted it by id.
			preview.Deleted = true
			preview.Content = ""
		}
		previews[preview.ID] = preview
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("scan replied-to chat messages: %w", err)
	}

	for i := range messages {
		if messages[i].ReplyToID == nil {
			continue
		}
		if preview, ok := previews[*messages[i].ReplyToID]; ok {
			messages[i].ReplyTo = &preview
		}
	}
	return nil
}

// AttachChatReply is the one-message form, for a create or an edit answering
// with the row it just wrote.
func AttachChatReply(message *models.ChatMessage) error {
	if message == nil {
		return nil
	}
	page := []models.ChatMessage{*message}
	if err := AttachChatReplies(page); err != nil {
		return err
	}
	*message = page[0]
	return nil
}

// SearchChatMessages returns a page of non-deleted chat messages whose content
// holds the given text, newest first, with the same cursor contract as
// ListChatMessages.
//
// A substring match, not the FTS5 index moments use. Chat is written in
// fragments (a URL, an id, half a word someone is asking about) and searched
// for exactly those, which a tokenized index cannot find in the middle of a
// term; there is also no chat_fts table to maintain, and one message is small
// enough that a scan of the table costs less than keeping one in sync.
//
// The wildcards are escaped so a literal % or _ in the query stays literal.
func SearchChatMessages(query string, cursor *ChatCursor, limit int) ([]models.ChatMessage, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	needle := strings.TrimSpace(query)
	if needle == "" {
		return []models.ChatMessage{}, nil
	}

	selectSQL := `SELECT id, author_id, display_name, content, is_legacy, reply_to_id, deleted_at, created_at, updated_at
	      FROM chat_messages
	      WHERE deleted_at IS NULL AND content LIKE ? ESCAPE '\'`
	args := []any{"%" + escapeLike(needle) + "%"}
	if cursor != nil {
		selectSQL += ` AND (created_at < ? OR (created_at = ? AND id < ?))`
		args = append(args, cursor.CreatedAt, cursor.CreatedAt, cursor.ID)
	}
	selectSQL += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := db.DB.Query(selectSQL, args...)
	if err != nil {
		return nil, fmt.Errorf("search chat messages: %w", err)
	}
	defer rows.Close()
	return scanChatMessages(rows)
}

// escapeLike neutralises the LIKE wildcards, so searching for "100%" finds the
// messages that say "100%" rather than every message at all.
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`)
	return r.Replace(s)
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

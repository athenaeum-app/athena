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

// Comments on a project document: a remark hung off a block of the body, and
// replies to it. No permission checks here; the API layer gates on
// permissions.ManageProjects for writes.
//
// The anchor is stored, never interpreted. Resolving "which block is this
// about" needs the document split the same way the reader splits it, which is
// the client's own renderer, so the server keeps the pair the client sent and
// hands it back untouched.

// Comment validation errors. Handlers map these to 400 Bad Request.
var (
	ErrProjectDocumentCommentBody   = errors.New("a comment needs a body")
	ErrProjectDocumentCommentParent = errors.New("a reply belongs to a thread on the same document")
	ErrProjectDocumentCommentThread = errors.New("only the first comment of a thread can be resolved")
)

// How much of a block's text an anchor keeps. Long enough to tell two
// paragraphs apart, short enough that editing the tail of a long block does
// not lose the anchor. The client normalizes and truncates too; this is the
// backstop against a caller storing a whole chapter in the anchor.
const maxProjectDocumentAnchorText = 240

// A comment is a remark, not a document: the composer is a plain textarea and
// nothing renders embeds inside it, so a body past this length is a sign of
// something other than a remark.
const maxProjectDocumentCommentBody = 4000

// CreateProjectDocumentComment starts a thread on a block, or replies to one.
// parentID nil starts a thread; set makes it a reply, and the reply copies its
// parent's anchor rather than carrying one of its own. Returns nil if the
// document is gone or is a folder, which has no blocks to comment on.
func CreateProjectDocumentComment(documentID string, parentID *string, anchorIndex int, anchorText, body string, authorID *string) (*models.ProjectDocumentComment, error) {
	body = strings.TrimSpace(body)
	if body == "" {
		return nil, ErrProjectDocumentCommentBody
	}
	if len(body) > maxProjectDocumentCommentBody {
		body = body[:maxProjectDocumentCommentBody]
	}
	doc, err := getProjectDocument(documentID)
	if err != nil {
		return nil, err
	}
	if doc == nil || doc.Kind == models.ProjectDocumentKindFolder {
		return nil, nil
	}

	if anchorIndex < 0 {
		anchorIndex = 0
	}
	if len(anchorText) > maxProjectDocumentAnchorText {
		anchorText = anchorText[:maxProjectDocumentAnchorText]
	}
	if parentID != nil {
		parent, err := getProjectDocumentComment(*parentID)
		if err != nil {
			return nil, err
		}
		// Threads stay one level deep, the cap todo subtasks keep, so a
		// discussion reads as a list rather than a tree. A reply to a reply
		// joins the same thread instead of being refused.
		if parent == nil || parent.DocumentID != documentID {
			return nil, ErrProjectDocumentCommentParent
		}
		if parent.ParentID != nil {
			parentID = parent.ParentID
			root, err := getProjectDocumentComment(*parentID)
			if err != nil {
				return nil, err
			}
			if root == nil {
				return nil, ErrProjectDocumentCommentParent
			}
			parent = root
		}
		// A reply is about the block its thread is about, whatever the caller
		// sent, so the two can never drift apart.
		anchorIndex = parent.AnchorIndex
		anchorText = parent.AnchorText
	}

	now := time.Now().UTC()
	c := &models.ProjectDocumentComment{
		ID:          uuid.NewString(),
		DocumentID:  documentID,
		ParentID:    parentID,
		AnchorIndex: anchorIndex,
		AnchorText:  anchorText,
		Body:        body,
		AuthorID:    authorID,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if _, err := db.DB.Exec(
		`INSERT INTO project_document_comments (id, document_id, parent_id, anchor_index, anchor_text, body, resolved, author_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.DocumentID, c.ParentID, c.AnchorIndex, c.AnchorText, c.Body, c.Resolved, c.AuthorID, c.CreatedAt, c.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("insert comment: %w", err)
	}
	return c, nil
}

// ListProjectDocumentComments returns every comment on a document, oldest
// first, threads and replies alike flat. The client groups them by parent_id
// the same way it builds the folder tree from the flat document list. Returns
// nil if the document is gone.
func ListProjectDocumentComments(documentID string) ([]models.ProjectDocumentComment, error) {
	doc, err := getProjectDocument(documentID)
	if err != nil {
		return nil, err
	}
	if doc == nil {
		return nil, nil
	}
	rows, err := db.DB.Query(
		`SELECT `+projectDocumentCommentColumns+` FROM project_document_comments
		 WHERE document_id = ? ORDER BY created_at ASC`, documentID,
	)
	if err != nil {
		return nil, fmt.Errorf("list comments on %s: %w", documentID, err)
	}
	defer rows.Close()
	out := []models.ProjectDocumentComment{}
	for rows.Next() {
		c, err := scanProjectDocumentComment(rows)
		if err != nil {
			return nil, fmt.Errorf("scan comment: %w", err)
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// ProjectDocumentCommentPatch is a partial update. Non-nil means "set".
type ProjectDocumentCommentPatch struct {
	Body     *string
	Resolved *bool
}

// UpdateProjectDocumentComment edits a comment's text or resolves its thread.
// Resolving is a thread-level act, so it is refused on a reply: the thread is
// resolved through its first comment or not at all. Returns nil if the comment
// is gone.
func UpdateProjectDocumentComment(id string, p ProjectDocumentCommentPatch) (*models.ProjectDocumentComment, error) {
	current, err := getProjectDocumentComment(id)
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, nil
	}
	if p.Resolved != nil && current.ParentID != nil {
		return nil, ErrProjectDocumentCommentThread
	}

	sets := []string{}
	args := []any{}
	if p.Body != nil {
		body := strings.TrimSpace(*p.Body)
		if body == "" {
			return nil, ErrProjectDocumentCommentBody
		}
		if len(body) > maxProjectDocumentCommentBody {
			body = body[:maxProjectDocumentCommentBody]
		}
		sets = append(sets, "body = ?")
		args = append(args, body)
	}
	if p.Resolved != nil {
		sets = append(sets, "resolved = ?")
		args = append(args, *p.Resolved)
	}
	if len(sets) == 0 {
		return current, nil
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, time.Now().UTC(), id)

	if _, err := db.DB.Exec(`UPDATE project_document_comments SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
		return nil, fmt.Errorf("update comment %s: %w", id, err)
	}
	return getProjectDocumentComment(id)
}

// DeleteProjectDocumentComment removes a comment and, for a thread root, its
// replies through the parent_id cascade. It returns the removed rows so the
// audit record holds what was said before it went; a comment has no tombstone.
// Returns nil if the comment was already gone.
func DeleteProjectDocumentComment(id string) ([]models.ProjectDocumentComment, error) {
	current, err := getProjectDocumentComment(id)
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, nil
	}
	removed := []models.ProjectDocumentComment{*current}
	if current.ParentID == nil {
		rows, err := db.DB.Query(
			`SELECT `+projectDocumentCommentColumns+` FROM project_document_comments
			 WHERE parent_id = ? ORDER BY created_at ASC`, id,
		)
		if err != nil {
			return nil, fmt.Errorf("read replies of %s: %w", id, err)
		}
		defer rows.Close()
		for rows.Next() {
			reply, err := scanProjectDocumentComment(rows)
			if err != nil {
				return nil, fmt.Errorf("scan reply: %w", err)
			}
			removed = append(removed, *reply)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	if _, err := db.DB.Exec(`DELETE FROM project_document_comments WHERE id = ?`, id); err != nil {
		return nil, fmt.Errorf("delete comment %s: %w", id, err)
	}
	return removed, nil
}

// --- scanning ---

const projectDocumentCommentColumns = `id, document_id, parent_id, anchor_index, anchor_text, body, resolved, author_id, created_at, updated_at`

func scanProjectDocumentComment(s scannerT) (*models.ProjectDocumentComment, error) {
	c := &models.ProjectDocumentComment{}
	var parent, author sql.NullString
	if err := s.Scan(
		&c.ID, &c.DocumentID, &parent, &c.AnchorIndex, &c.AnchorText, &c.Body, &c.Resolved, &author, &c.CreatedAt, &c.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if parent.Valid {
		c.ParentID = &parent.String
	}
	if author.Valid {
		c.AuthorID = &author.String
	}
	return c, nil
}

func getProjectDocumentComment(id string) (*models.ProjectDocumentComment, error) {
	c, err := scanProjectDocumentComment(db.DB.QueryRow(
		`SELECT `+projectDocumentCommentColumns+` FROM project_document_comments WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get comment %s: %w", id, err)
	}
	return c, nil
}

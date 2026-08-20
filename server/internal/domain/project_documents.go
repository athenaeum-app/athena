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

// The Documents tab of the projects module: one tree of folders and documents
// per project, sharing the moment pipeline but owned by the project rather
// than by an archive (ADR-0020). No permission checks here; the API layer
// gates on permissions.ManageProjects.
//
// Ordering uses REAL positions with midpoint inserts within a sibling group,
// the same scheme the milestone and card boards use.

// Documents-tab validation errors. Handlers map these to HTTP status codes:
// ErrProjectDocumentLocked and ErrProjectDocumentIDTaken -> 409 Conflict, the
// rest -> 400 Bad Request.
var (
	ErrProjectDocumentKind       = errors.New("kind must be folder or document")
	ErrProjectDocumentStatus     = errors.New("status must be draft, final or locked")
	ErrProjectDocumentParent     = errors.New("parent must be a folder in the same project")
	ErrProjectDocumentCycle      = errors.New("a folder cannot be moved inside itself")
	ErrProjectDocumentLocked     = errors.New("this document is locked: unlock it before editing its title or body")
	ErrProjectDocumentFolderBody = errors.New("a folder has no body")
	ErrProjectDocumentProject    = errors.New("every restored row must belong to the project")
	ErrProjectDocumentIDTaken    = errors.New("a document with that id already exists")
)

// How stale the newest version has to be before an edit takes another one.
// A snapshot per save would mint a version per typing pause, and no snapshot
// at all would lose an afternoon's rewrite, so an edit opens at most one
// version an hour and the manual "save version" button covers the rest.
const projectDocumentSnapshotWindow = time.Hour

// Corruption guard for the ancestor walks. Folders nest without limit by
// design, so this is not a depth policy: it is what stops a ring that should
// be impossible from spinning a request forever.
const maxProjectDocumentDepth = 10000

// CreateProjectDocument adds a folder or a document to a project's tree.
// parentID nil puts it at the tab's root; position nil appends it to its
// sibling group. Returns nil if the project is gone.
func CreateProjectDocument(projectID, kind, title, body string, parentID *string, position *float64, authorID *string) (*models.ProjectDocument, error) {
	if kind != models.ProjectDocumentKindFolder && kind != models.ProjectDocumentKindDocument {
		return nil, ErrProjectDocumentKind
	}
	var exists int
	err := db.DB.QueryRow(`SELECT 1 FROM projects WHERE id = ?`, projectID).Scan(&exists)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if parentID != nil {
		if err := checkProjectDocumentParent(db.DB, projectID, *parentID); err != nil {
			return nil, err
		}
	}
	if kind == models.ProjectDocumentKindFolder {
		// A folder is a container, not content. Keeping it bodyless here means
		// no reader has to ask which kind a body belongs to.
		body = ""
	}

	now := time.Now().UTC()
	d := &models.ProjectDocument{
		ID:        uuid.NewString(),
		ProjectID: projectID,
		ParentID:  parentID,
		Kind:      kind,
		Title:     title,
		Body:      body,
		Status:    models.ProjectDocumentStatusDraft,
		AuthorID:  authorID,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if position != nil {
		d.Position = *position
	} else {
		// IS rather than = so the root group (parent_id NULL) matches too.
		_ = db.DB.QueryRow(
			`SELECT COALESCE(MAX(position)+1, 0) FROM project_documents WHERE project_id = ? AND parent_id IS ?`,
			projectID, parentID,
		).Scan(&d.Position)
	}
	if _, err := db.DB.Exec(
		`INSERT INTO project_documents (id, project_id, parent_id, kind, title, body, status, position, author_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d.ID, d.ProjectID, d.ParentID, d.Kind, d.Title, d.Body, d.Status, d.Position, d.AuthorID, d.CreatedAt, d.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("insert document: %w", err)
	}
	return d, nil
}

// ProjectDocumentPatch is a partial update. Non-nil means "set";
// ClearParentID sends the row to the tab root and wins over ParentID.
type ProjectDocumentPatch struct {
	Title    *string
	Body     *string
	Status   *string
	Position *float64
	// Moving is a parent_id write, so a drag between folders is one UPDATE.
	ParentID      *string
	ClearParentID bool
	// Who is editing. Recorded as the author of any snapshot this patch takes,
	// which is the only record of who caused a version to exist.
	ActorID *string
}

// UpdateProjectDocument applies a partial update, auto-snapshotting the
// pre-edit state first when the body changes and the newest version has aged
// out. Returns nil if the document is gone.
func UpdateProjectDocument(id string, p ProjectDocumentPatch) (*models.ProjectDocument, error) {
	current, err := getProjectDocument(id)
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, nil
	}

	// Locked is judged on the stored status, never on a status this same patch
	// also sets: "locked refuses title and body edits until unlocked" makes the
	// unlock a deliberate step of its own, not a flag smuggled in with the edit.
	if current.Status == models.ProjectDocumentStatusLocked && (p.Title != nil || p.Body != nil) {
		return nil, ErrProjectDocumentLocked
	}
	if p.Body != nil && current.Kind == models.ProjectDocumentKindFolder {
		return nil, ErrProjectDocumentFolderBody
	}
	if p.Status != nil {
		switch *p.Status {
		case models.ProjectDocumentStatusDraft, models.ProjectDocumentStatusFinal, models.ProjectDocumentStatusLocked:
		default:
			return nil, ErrProjectDocumentStatus
		}
	}

	sets := []string{}
	args := []any{}
	if p.Title != nil {
		sets = append(sets, "title = ?")
		args = append(args, *p.Title)
	}
	if p.Body != nil {
		sets = append(sets, "body = ?")
		args = append(args, *p.Body)
	}
	if p.Status != nil {
		sets = append(sets, "status = ?")
		args = append(args, *p.Status)
	}
	if p.ClearParentID {
		sets = append(sets, "parent_id = NULL")
	} else if p.ParentID != nil {
		if err := checkProjectDocumentParent(db.DB, current.ProjectID, *p.ParentID); err != nil {
			return nil, err
		}
		if err := checkProjectDocumentCycle(id, *p.ParentID); err != nil {
			return nil, err
		}
		sets = append(sets, "parent_id = ?")
		args = append(args, *p.ParentID)
	}
	if p.Position != nil {
		sets = append(sets, "position = ?")
		args = append(args, *p.Position)
	}
	if len(sets) == 0 {
		return current, nil
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, time.Now().UTC(), id)

	tx, err := db.DB.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin update document: %w", err)
	}
	defer tx.Rollback()
	if p.Body != nil && *p.Body != current.Body {
		if err := autoSnapshotProjectDocument(tx, current, p.ActorID); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(`UPDATE project_documents SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
		return nil, fmt.Errorf("update document %s: %w", id, err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit update document %s: %w", id, err)
	}
	return getProjectDocument(id)
}

// DeleteProjectDocument hard-deletes a row and, through the parent_id cascade,
// everything beneath it. It returns the removed subtree, parents first: a
// document has no tombstone (ADR-0010), so that payload is the undo, and
// RestoreProjectDocuments puts it back with the same ids. Returns nil if the
// row was already gone.
func DeleteProjectDocument(id string) ([]models.ProjectDocument, error) {
	subtree, err := projectDocumentSubtree(id)
	if err != nil {
		return nil, err
	}
	if len(subtree) == 0 {
		return nil, nil
	}
	if _, err := db.DB.Exec(`DELETE FROM project_documents WHERE id = ?`, id); err != nil {
		return nil, fmt.Errorf("delete document %s: %w", id, err)
	}
	return subtree, nil
}

// RestoreProjectDocuments reinserts a deleted subtree under its original ids,
// so an undo brings back the identity that embeds and links already point at
// rather than a copy. Rows are inserted parents first. Returns nil if the
// project is gone.
func RestoreProjectDocuments(projectID string, docs []models.ProjectDocument) ([]models.ProjectDocument, error) {
	if len(docs) == 0 {
		return []models.ProjectDocument{}, nil
	}
	var exists int
	err := db.DB.QueryRow(`SELECT 1 FROM projects WHERE id = ?`, projectID).Scan(&exists)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	ordered := sortProjectDocumentsParentsFirst(docs)
	inPayload := map[string]bool{}
	for _, d := range ordered {
		if d.ID == "" || d.ProjectID != projectID {
			return nil, ErrProjectDocumentProject
		}
		if d.Kind != models.ProjectDocumentKindFolder && d.Kind != models.ProjectDocumentKindDocument {
			return nil, ErrProjectDocumentKind
		}
		switch d.Status {
		case models.ProjectDocumentStatusDraft, models.ProjectDocumentStatusFinal, models.ProjectDocumentStatusLocked:
		default:
			return nil, ErrProjectDocumentStatus
		}
		inPayload[d.ID] = true
	}

	tx, err := db.DB.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin restore documents: %w", err)
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	for i := range ordered {
		d := &ordered[i]
		var taken int
		err := tx.QueryRow(`SELECT 1 FROM project_documents WHERE id = ?`, d.ID).Scan(&taken)
		if err == nil {
			return nil, ErrProjectDocumentIDTaken
		}
		if err != sql.ErrNoRows {
			return nil, err
		}
		// A parent outside the payload is the folder the subtree hung from. It
		// has to still exist, or the rows would come back somewhere with no
		// route to them from the tab root.
		if d.ParentID != nil && !inPayload[*d.ParentID] {
			if err := checkProjectDocumentParent(tx, projectID, *d.ParentID); err != nil {
				return nil, err
			}
		}
		if d.CreatedAt.IsZero() {
			d.CreatedAt = now
		}
		if d.UpdatedAt.IsZero() {
			d.UpdatedAt = now
		}
		if d.Kind == models.ProjectDocumentKindFolder {
			d.Body = ""
		}
		if _, err := tx.Exec(
			`INSERT INTO project_documents (id, project_id, parent_id, kind, title, body, status, position, author_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			d.ID, d.ProjectID, d.ParentID, d.Kind, d.Title, d.Body, d.Status, d.Position, d.AuthorID, d.CreatedAt, d.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("restore document %s: %w", d.ID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit restore documents: %w", err)
	}
	return ordered, nil
}

// --- versions ---

// CreateProjectDocumentVersion snapshots a document's current title and body:
// the manual "save version". Returns nil if the document is gone or is a
// folder, which has nothing to snapshot.
func CreateProjectDocumentVersion(documentID string, actorID *string) (*models.ProjectDocumentVersion, error) {
	doc, err := getProjectDocument(documentID)
	if err != nil {
		return nil, err
	}
	if doc == nil || doc.Kind == models.ProjectDocumentKindFolder {
		return nil, nil
	}
	tx, err := db.DB.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin snapshot document: %w", err)
	}
	defer tx.Rollback()
	v, err := insertProjectDocumentVersion(tx, doc, actorID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit snapshot document: %w", err)
	}
	return v, nil
}

// ListProjectDocumentVersions returns a document's snapshots newest first,
// without their bodies: the list is a history to pick from, and carrying every
// past body through it would dwarf the document itself. Returns nil if the
// document is gone.
func ListProjectDocumentVersions(documentID string) ([]models.ProjectDocumentVersion, error) {
	doc, err := getProjectDocument(documentID)
	if err != nil {
		return nil, err
	}
	if doc == nil {
		return nil, nil
	}
	rows, err := db.DB.Query(
		`SELECT id, document_id, title, author_id, created_at FROM project_document_versions
		 WHERE document_id = ? ORDER BY created_at DESC`, documentID,
	)
	if err != nil {
		return nil, fmt.Errorf("list versions of %s: %w", documentID, err)
	}
	defer rows.Close()
	out := []models.ProjectDocumentVersion{}
	for rows.Next() {
		v := models.ProjectDocumentVersion{}
		var author sql.NullString
		if err := rows.Scan(&v.ID, &v.DocumentID, &v.Title, &author, &v.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan version: %w", err)
		}
		if author.Valid {
			v.AuthorID = &author.String
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetProjectDocumentVersion returns one snapshot with its body. Returns nil if
// it is gone.
func GetProjectDocumentVersion(id string) (*models.ProjectDocumentVersion, error) {
	v, err := scanProjectDocumentVersion(db.DB.QueryRow(
		`SELECT `+projectDocumentVersionColumns+` FROM project_document_versions WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get version %s: %w", id, err)
	}
	return v, nil
}

// RestoreProjectDocumentVersion writes a snapshot back over its document,
// snapshotting the current state first so the restore is itself undoable. The
// pre-restore snapshot ignores the hourly window: a restore always leaves a
// way back, however recently the last version was taken. Returns nil if the
// version is gone.
func RestoreProjectDocumentVersion(versionID string, actorID *string) (*models.ProjectDocument, error) {
	v, err := GetProjectDocumentVersion(versionID)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	doc, err := getProjectDocument(v.DocumentID)
	if err != nil {
		return nil, err
	}
	if doc == nil {
		return nil, nil
	}
	// A restore rewrites title and body, so a locked document refuses it for
	// the same reason it refuses an edit.
	if doc.Status == models.ProjectDocumentStatusLocked {
		return nil, ErrProjectDocumentLocked
	}

	tx, err := db.DB.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin restore version: %w", err)
	}
	defer tx.Rollback()
	if _, err := insertProjectDocumentVersion(tx, doc, actorID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(
		`UPDATE project_documents SET title = ?, body = ?, updated_at = ? WHERE id = ?`,
		v.Title, v.Body, time.Now().UTC(), doc.ID,
	); err != nil {
		return nil, fmt.Errorf("restore version %s: %w", versionID, err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit restore version %s: %w", versionID, err)
	}
	return getProjectDocument(doc.ID)
}

// autoSnapshotProjectDocument records the pre-edit state when the document has
// no version yet or its newest has aged past the snapshot window.
func autoSnapshotProjectDocument(tx *sql.Tx, doc *models.ProjectDocument, actorID *string) error {
	var newest time.Time
	err := tx.QueryRow(
		`SELECT created_at FROM project_document_versions WHERE document_id = ?
		 ORDER BY created_at DESC LIMIT 1`, doc.ID,
	).Scan(&newest)
	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("newest version of %s: %w", doc.ID, err)
	}
	if err == nil && time.Since(newest) < projectDocumentSnapshotWindow {
		return nil
	}
	_, err = insertProjectDocumentVersion(tx, doc, actorID)
	return err
}

func insertProjectDocumentVersion(tx *sql.Tx, doc *models.ProjectDocument, actorID *string) (*models.ProjectDocumentVersion, error) {
	v := &models.ProjectDocumentVersion{
		ID:         uuid.NewString(),
		DocumentID: doc.ID,
		Title:      doc.Title,
		Body:       doc.Body,
		AuthorID:   actorID,
		CreatedAt:  time.Now().UTC(),
	}
	if _, err := tx.Exec(
		`INSERT INTO project_document_versions (id, document_id, title, body, author_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		v.ID, v.DocumentID, v.Title, v.Body, v.AuthorID, v.CreatedAt,
	); err != nil {
		return nil, fmt.Errorf("insert document version: %w", err)
	}
	return v, nil
}

// --- tree helpers ---

// queryRower is the QueryRow half of *sql.DB and *sql.Tx, so a validation
// check reads the same inside a transaction as outside one.
type queryRower interface {
	QueryRow(query string, args ...any) *sql.Row
}

// checkProjectDocumentParent refuses a parent that is not a folder in the same
// project: a document holds content rather than children, and a tree spanning
// two projects is not a tree.
func checkProjectDocumentParent(q queryRower, projectID, parentID string) error {
	var kind string
	err := q.QueryRow(`SELECT kind FROM project_documents WHERE id = ? AND project_id = ?`, parentID, projectID).Scan(&kind)
	if err == sql.ErrNoRows {
		return ErrProjectDocumentParent
	}
	if err != nil {
		return err
	}
	if kind != models.ProjectDocumentKindFolder {
		return ErrProjectDocumentParent
	}
	return nil
}

// checkProjectDocumentCycle walks the proposed parent's ancestry and refuses
// the move if the moving row is on it. Dropping a folder into its own
// descendant would cut that whole branch out of the tree and leave it circling
// with no route to the root.
func checkProjectDocumentCycle(id, parentID string) error {
	next := parentID
	for depth := 0; depth < maxProjectDocumentDepth; depth++ {
		if next == id {
			return ErrProjectDocumentCycle
		}
		var parent sql.NullString
		err := db.DB.QueryRow(`SELECT parent_id FROM project_documents WHERE id = ?`, next).Scan(&parent)
		if err == sql.ErrNoRows {
			return ErrProjectDocumentParent
		}
		if err != nil {
			return err
		}
		if !parent.Valid {
			return nil
		}
		next = parent.String
	}
	return ErrProjectDocumentCycle
}

// projectDocumentSubtree returns a row and every descendant, parents first.
func projectDocumentSubtree(id string) ([]models.ProjectDocument, error) {
	rows, err := db.DB.Query(
		`WITH RECURSIVE subtree(id) AS (
			SELECT id FROM project_documents WHERE id = ?
			UNION ALL
			SELECT d.id FROM project_documents d JOIN subtree s ON d.parent_id = s.id
		 )
		 SELECT `+projectDocumentColumns+` FROM project_documents
		 WHERE id IN (SELECT id FROM subtree)
		 ORDER BY position ASC, created_at ASC`, id,
	)
	if err != nil {
		return nil, fmt.Errorf("read subtree of %s: %w", id, err)
	}
	defer rows.Close()
	docs := []models.ProjectDocument{}
	for rows.Next() {
		d, err := scanProjectDocument(rows)
		if err != nil {
			return nil, fmt.Errorf("scan document: %w", err)
		}
		docs = append(docs, *d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return sortProjectDocumentsParentsFirst(docs), nil
}

// sortProjectDocumentsParentsFirst orders a set of rows so no row precedes its
// parent. A restore inserts in this order, and a child inserted ahead of its
// parent violates the parent_id foreign key. Rows whose parent is outside the
// set lead: for a deleted subtree that is its root, for a restore payload it is
// whatever hung off a folder still in the tree.
func sortProjectDocumentsParentsFirst(docs []models.ProjectDocument) []models.ProjectDocument {
	inSet := map[string]bool{}
	for _, d := range docs {
		inSet[d.ID] = true
	}
	children := map[string][]models.ProjectDocument{}
	out := make([]models.ProjectDocument, 0, len(docs))
	for _, d := range docs {
		if d.ParentID != nil && inSet[*d.ParentID] {
			children[*d.ParentID] = append(children[*d.ParentID], d)
			continue
		}
		out = append(out, d)
	}
	for i := 0; i < len(out); i++ {
		out = append(out, children[out[i].ID]...)
	}
	if len(out) == len(docs) {
		return out
	}
	// Only reachable if the caller handed us a ring, which no delete can
	// produce. Keep those rows rather than dropping them silently and let the
	// foreign key be the one to object.
	placed := map[string]bool{}
	for _, d := range out {
		placed[d.ID] = true
	}
	for _, d := range docs {
		if !placed[d.ID] {
			out = append(out, d)
		}
	}
	return out
}

// --- scanning ---

// The open-comment count rides in the column list rather than in a second
// query so every serialization of a document carries it: the tile badges it,
// and a PATCH response that answered 0 would blank the badge the client had
// just drawn. Unresolved thread roots only, since a reply is part of the thread
// its root already counts.
const projectDocumentColumns = `id, project_id, parent_id, kind, title, body, status, position,
	(SELECT COUNT(*) FROM project_document_comments c
	 WHERE c.document_id = project_documents.id AND c.parent_id IS NULL AND c.resolved = 0),
	author_id, created_at, updated_at`

func scanProjectDocument(s scannerT) (*models.ProjectDocument, error) {
	d := &models.ProjectDocument{}
	var parent, author sql.NullString
	if err := s.Scan(
		&d.ID, &d.ProjectID, &parent, &d.Kind, &d.Title, &d.Body, &d.Status, &d.Position, &d.OpenComments, &author, &d.CreatedAt, &d.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if parent.Valid {
		d.ParentID = &parent.String
	}
	if author.Valid {
		d.AuthorID = &author.String
	}
	return d, nil
}

func getProjectDocument(id string) (*models.ProjectDocument, error) {
	d, err := scanProjectDocument(db.DB.QueryRow(`SELECT `+projectDocumentColumns+` FROM project_documents WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get document %s: %w", id, err)
	}
	return d, nil
}

const projectDocumentVersionColumns = `id, document_id, title, body, author_id, created_at`

func scanProjectDocumentVersion(s scannerT) (*models.ProjectDocumentVersion, error) {
	v := &models.ProjectDocumentVersion{}
	var author sql.NullString
	if err := s.Scan(&v.ID, &v.DocumentID, &v.Title, &v.Body, &author, &v.CreatedAt); err != nil {
		return nil, err
	}
	if author.Valid {
		v.AuthorID = &author.String
	}
	return v, nil
}

func getDocumentsForProjects(ids []string) (map[string][]models.ProjectDocument, error) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := db.DB.Query(
		`SELECT `+projectDocumentColumns+` FROM project_documents WHERE project_id IN (`+placeholders+`)
		 ORDER BY position ASC, created_at ASC`, args...,
	)
	if err != nil {
		return nil, fmt.Errorf("get documents: %w", err)
	}
	defer rows.Close()
	out := map[string][]models.ProjectDocument{}
	for rows.Next() {
		d, err := scanProjectDocument(rows)
		if err != nil {
			return nil, fmt.Errorf("scan document: %w", err)
		}
		out[d.ProjectID] = append(out[d.ProjectID], *d)
	}
	return out, rows.Err()
}

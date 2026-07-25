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

// Package-local note: the todo module (ADR-0013) is
// server-synced and library-shared with last-write-wins concurrency. These
// functions perform no permission checks; the API layer gates on
// permissions.ManageTodos.

// ListTodoLists returns every todo list with its items attached, ordered by
// position then creation time.
func ListTodoLists() ([]models.TodoList, error) {
	rows, err := db.DB.Query(
		`SELECT id, kind, title, notes, author_id, position, last_reset_at, created_at, updated_at
		 FROM todo_lists ORDER BY position ASC, created_at ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("list todo lists: %w", err)
	}
	defer rows.Close()

	lists := []models.TodoList{}
	ids := []string{}
	for rows.Next() {
		list, err := scanTodoList(rows)
		if err != nil {
			return nil, err
		}
		lists = append(lists, *list)
		ids = append(ids, list.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return lists, nil
	}

	itemsByList, err := getTodoItemsForLists(ids)
	if err != nil {
		return nil, err
	}
	for i := range lists {
		// Only overwrite when the list actually has items; a missing map
		// entry is a nil slice, which would marshal to JSON null and crash
		// clients that call .length/.filter on list.items. scanTodoList
		// already seeded Items with an empty (non-nil) slice.
		if items := itemsByList[lists[i].ID]; items != nil {
			lists[i].Items = items
		}
	}
	return lists, nil
}

// GetTodoList fetches one list with its items. Returns nil if not found.
func GetTodoList(id string) (*models.TodoList, error) {
	list, err := scanTodoList(db.DB.QueryRow(
		`SELECT id, kind, title, notes, author_id, position, last_reset_at, created_at, updated_at
		 FROM todo_lists WHERE id = ?`, id,
	))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get todo list %s: %w", id, err)
	}
	items, err := getTodoItemsForLists([]string{id})
	if err != nil {
		return nil, err
	}
	// Preserve the non-nil empty slice from scanTodoList when the list has
	// no items, so the JSON payload is [] rather than null (see ListTodoLists).
	if items[id] != nil {
		list.Items = items[id]
	}
	return list, nil
}

// CreateTodoList inserts a new list. kind is "daily" or "general".
func CreateTodoList(kind, title string, authorID *string) (*models.TodoList, error) {
	if kind != models.TodoKindDaily && kind != models.TodoKindGeneral {
		kind = models.TodoKindGeneral
	}
	now := time.Now().UTC()
	list := &models.TodoList{
		ID:        uuid.NewString(),
		Kind:      kind,
		Title:     title,
		AuthorID:  authorID,
		CreatedAt: now,
		UpdatedAt: now,
		Items:     []models.TodoItem{},
	}
	var pos int
	_ = db.DB.QueryRow(`SELECT COALESCE(MAX(position)+1, 0) FROM todo_lists`).Scan(&pos)
	list.Position = pos
	_, err := db.DB.Exec(
		`INSERT INTO todo_lists (id, kind, title, notes, author_id, position, created_at, updated_at)
		 VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
		list.ID, list.Kind, list.Title, list.AuthorID, list.Position, list.CreatedAt, list.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert todo list: %w", err)
	}
	return list, nil
}

// UpdateTodoList partially updates title/notes/position. nil = unchanged.
func UpdateTodoList(id string, title, notes *string, position *int) (*models.TodoList, error) {
	sets := []string{}
	args := []any{}
	if title != nil {
		sets = append(sets, "title = ?")
		args = append(args, *title)
	}
	if notes != nil {
		sets = append(sets, "notes = ?")
		args = append(args, *notes)
	}
	if position != nil {
		sets = append(sets, "position = ?")
		args = append(args, *position)
	}
	if len(sets) == 0 {
		return GetTodoList(id)
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, time.Now().UTC(), id)
	res, err := db.DB.Exec(`UPDATE todo_lists SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("update todo list %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, nil
	}
	return GetTodoList(id)
}

// DeleteTodoList hard-deletes a list; items cascade via FK.
func DeleteTodoList(id string) error {
	_, err := db.DB.Exec(`DELETE FROM todo_lists WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete todo list %s: %w", id, err)
	}
	return nil
}

// ResetDailyList applies the daily-reset rules: completed items are
// removed, and unchecked items are flagged rolled_over (the "unfinished from
// yesterday" pile) so the client can offer to pull them into the new day.
// last_reset_at is stamped. Returns the refreshed list.
func ResetDailyList(id string) (*models.TodoList, error) {
	now := time.Now().UTC()
	tx, err := db.DB.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin daily reset: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM todo_items WHERE list_id = ? AND done = 1`, id); err != nil {
		return nil, fmt.Errorf("clear done items: %w", err)
	}
	if _, err := tx.Exec(
		`UPDATE todo_items SET rolled_over = 1, updated_at = ? WHERE list_id = ?`, now, id,
	); err != nil {
		return nil, fmt.Errorf("roll over items: %w", err)
	}
	if _, err := tx.Exec(
		`UPDATE todo_lists SET last_reset_at = ?, updated_at = ? WHERE id = ?`, now, now, id,
	); err != nil {
		return nil, fmt.Errorf("stamp reset: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit daily reset: %w", err)
	}
	return GetTodoList(id)
}

// CreateTodoItem appends an item to a list. parentID, when non-nil, nests the
// item as a subtask (one level). Returns nil if the list is gone.
func CreateTodoItem(listID, text string, parentID *string) (*models.TodoItem, error) {
	var exists int
	if err := db.DB.QueryRow(`SELECT 1 FROM todo_lists WHERE id = ?`, listID).Scan(&exists); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	now := time.Now().UTC()
	todoItem := &models.TodoItem{
		ID:        uuid.NewString(),
		ListID:    listID,
		Text:      text,
		ParentID:  parentID,
		CreatedAt: now,
		UpdatedAt: now,
	}
	_ = db.DB.QueryRow(`SELECT COALESCE(MAX(position)+1, 0) FROM todo_items WHERE list_id = ?`, listID).Scan(&todoItem.Position)
	_, err := db.DB.Exec(
		`INSERT INTO todo_items (id, list_id, text, done, position, parent_id, created_at, updated_at)
		 VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
		todoItem.ID, todoItem.ListID, todoItem.Text, todoItem.Position, parentID, todoItem.CreatedAt, todoItem.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert todo item: %w", err)
	}
	return todoItem, nil
}

// TodoItemPatch is a partial update for a todo item. A non-nil pointer means
// "set to this value"; the Clear* flags explicitly null out a nullable field
// (they win over the corresponding pointer when both are set).
type TodoItemPatch struct {
	Text          *string
	Done          *bool
	Position      *int
	RolledOver    *bool
	Priority      *int
	Recurrence    *string
	DueAt         *time.Time
	ClearDueAt    bool
	MomentID      *string
	ClearMomentID bool
}

// UpdateTodoItem applies a partial update. Setting done true stamps
// completed_at; done false clears it.
//
// Recurrence: when this update *transitions* a recurring item to done,
// a fresh (undone) copy is spawned with its due date advanced by the rule,
// generalizing the daily-reset roll-over to any single task. The spawned item
// is returned as the second value (nil when nothing was regenerated) so the
// API layer can emit a TODO_ITEM_CREATED event for it.
func UpdateTodoItem(id string, p TodoItemPatch) (*models.TodoItem, *models.TodoItem, error) {
	// Snapshot the pre-update state so we can detect the not-done → done edge
	// (and read the recurrence/due/priority we need to spawn the next one).
	before, err := getTodoItem(id)
	if err != nil {
		return nil, nil, err
	}
	if before == nil {
		return nil, nil, nil
	}

	sets := []string{}
	args := []any{}
	if p.Text != nil {
		sets = append(sets, "text = ?")
		args = append(args, *p.Text)
	}
	if p.Done != nil {
		sets = append(sets, "done = ?")
		args = append(args, *p.Done)
		if *p.Done {
			sets = append(sets, "completed_at = ?")
			args = append(args, time.Now().UTC())
		} else {
			sets = append(sets, "completed_at = NULL")
		}
	}
	if p.Position != nil {
		sets = append(sets, "position = ?")
		args = append(args, *p.Position)
	}
	if p.RolledOver != nil {
		sets = append(sets, "rolled_over = ?")
		args = append(args, *p.RolledOver)
	}
	if p.Priority != nil {
		sets = append(sets, "priority = ?")
		args = append(args, *p.Priority)
	}
	if p.Recurrence != nil {
		sets = append(sets, "recurrence = ?")
		args = append(args, *p.Recurrence)
	}
	if p.ClearDueAt {
		sets = append(sets, "due_at = NULL")
	} else if p.DueAt != nil {
		sets = append(sets, "due_at = ?")
		args = append(args, *p.DueAt)
	}
	if p.ClearMomentID {
		sets = append(sets, "moment_id = NULL")
	} else if p.MomentID != nil {
		sets = append(sets, "moment_id = ?")
		args = append(args, *p.MomentID)
	}
	if len(sets) == 0 {
		return before, nil, nil
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, time.Now().UTC(), id)
	res, err := db.DB.Exec(`UPDATE todo_items SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("update todo item %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, nil, nil
	}
	updated, err := getTodoItem(id)
	if err != nil {
		return nil, nil, err
	}

	// Regenerate on the completion edge: the item must now be done, must not
	// have been done before, and must carry a recurrence rule. Subtasks don't
	// recur on their own (their parent's rule governs the cycle).
	var regenerated *models.TodoItem
	if updated != nil && updated.Done && !before.Done && updated.Recurrence != "" && updated.ParentID == nil {
		regenerated, err = spawnNextOccurrence(updated)
		if err != nil {
			return nil, nil, err
		}
	}
	return updated, regenerated, nil
}

// spawnNextOccurrence inserts a fresh, undone copy of a completed recurring
// item with its due date advanced to the next occurrence strictly in the
// future. The base is the item's own due date when set, otherwise now; the
// step is daily/weekly/monthly. Returns the new item.
func spawnNextOccurrence(item *models.TodoItem) (*models.TodoItem, error) {
	now := time.Now().UTC()
	base := now
	if item.DueAt != nil {
		base = *item.DueAt
	}
	next := advanceRecurrence(base, item.Recurrence)
	// If the item was overdue by several periods, roll forward until the next
	// occurrence is actually in the future (cap the loop defensively).
	for i := 0; i < 1000 && !next.After(now); i++ {
		next = advanceRecurrence(next, item.Recurrence)
	}

	spawn := &models.TodoItem{
		ID:         uuid.NewString(),
		ListID:     item.ListID,
		Text:       item.Text,
		Priority:   item.Priority,
		Recurrence: item.Recurrence,
		MomentID:   item.MomentID,
		DueAt:      &next,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	_ = db.DB.QueryRow(`SELECT COALESCE(MAX(position)+1, 0) FROM todo_items WHERE list_id = ?`, item.ListID).Scan(&spawn.Position)
	_, err := db.DB.Exec(
		`INSERT INTO todo_items (id, list_id, text, done, position, due_at, priority, moment_id, recurrence, created_at, updated_at)
		 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
		spawn.ID, spawn.ListID, spawn.Text, spawn.Position, spawn.DueAt, spawn.Priority, spawn.MomentID, spawn.Recurrence, spawn.CreatedAt, spawn.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("spawn recurring item: %w", err)
	}
	return spawn, nil
}

// advanceRecurrence returns t advanced by one step of the given rule. An
// unknown rule advances by a day so a misconfigured item still progresses.
func advanceRecurrence(t time.Time, rule string) time.Time {
	switch rule {
	case "weekly":
		return t.AddDate(0, 0, 7)
	case "monthly":
		return t.AddDate(0, 1, 0)
	default: // "daily" and any unknown rule
		return t.AddDate(0, 0, 1)
	}
}

// DeleteTodoItem hard-deletes a single item.
func DeleteTodoItem(id string) error {
	_, err := db.DB.Exec(`DELETE FROM todo_items WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete todo item %s: %w", id, err)
	}
	return nil
}

// todoItemColumns is the canonical SELECT list, kept in one place so the two
// readers and scanTodoItem never drift.
const todoItemColumns = `id, list_id, text, done, position, rolled_over, completed_at,
	 due_at, priority, moment_id, recurrence, parent_id, created_at, updated_at`

func scanTodoItem(s scannerT) (*models.TodoItem, error) {
	todoItem := &models.TodoItem{}
	var completedAt, dueAt sql.NullTime
	var momentID, parentID sql.NullString
	if err := s.Scan(
		&todoItem.ID, &todoItem.ListID, &todoItem.Text, &todoItem.Done, &todoItem.Position, &todoItem.RolledOver, &completedAt,
		&dueAt, &todoItem.Priority, &momentID, &todoItem.Recurrence, &parentID, &todoItem.CreatedAt, &todoItem.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if completedAt.Valid {
		todoItem.CompletedAt = &completedAt.Time
	}
	if dueAt.Valid {
		todoItem.DueAt = &dueAt.Time
	}
	if momentID.Valid {
		todoItem.MomentID = &momentID.String
	}
	if parentID.Valid {
		todoItem.ParentID = &parentID.String
	}
	return todoItem, nil
}

func getTodoItem(id string) (*models.TodoItem, error) {
	it, err := scanTodoItem(db.DB.QueryRow(`SELECT `+todoItemColumns+` FROM todo_items WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get todo item %s: %w", id, err)
	}
	return it, nil
}

func getTodoItemsForLists(listIDs []string) (map[string][]models.TodoItem, error) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(listIDs)), ",")
	args := make([]any, len(listIDs))
	for i, id := range listIDs {
		args[i] = id
	}
	rows, err := db.DB.Query(
		`SELECT `+todoItemColumns+` FROM todo_items WHERE list_id IN (`+placeholders+`) ORDER BY position ASC, created_at ASC`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("get todo items: %w", err)
	}
	defer rows.Close()

	out := map[string][]models.TodoItem{}
	for rows.Next() {
		it, err := scanTodoItem(rows)
		if err != nil {
			return nil, fmt.Errorf("scan todo item: %w", err)
		}
		out[it.ListID] = append(out[it.ListID], *it)
	}
	return out, rows.Err()
}

func scanTodoList(s scannerT) (*models.TodoList, error) {
	list := &models.TodoList{Items: []models.TodoItem{}}
	var lastReset sql.NullTime
	if err := s.Scan(&list.ID, &list.Kind, &list.Title, &list.Notes, &list.AuthorID, &list.Position, &lastReset, &list.CreatedAt, &list.UpdatedAt); err != nil {
		return nil, err
	}
	if lastReset.Valid {
		list.LastResetAt = &lastReset.Time
	}
	return list, nil
}

// scannerT is the row-scanner interface shared by *sql.Row and *sql.Rows.
type scannerT interface {
	Scan(dest ...any) error
}

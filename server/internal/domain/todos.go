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
	if err := sweepRecurringItems(); err != nil {
		return nil, err
	}
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
	if err := sweepRecurringItems(); err != nil {
		return nil, err
	}
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
//
// Recurring items are the exception to the clear-out. They are the list's
// standing habits rather than one-off entries, and deleting a completed one
// would retire the habit for good, so a reset unchecks them in place instead
// (the same thing their own cycle does, just early). Their subtasks come with
// them, since the parent's rule governs the whole routine.
func ResetDailyList(id string) (*models.TodoList, error) {
	now := time.Now().UTC()
	tx, err := db.DB.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin daily reset: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`DELETE FROM todo_items WHERE list_id = ? AND done = 1 AND `+notRecurring, id,
	); err != nil {
		return nil, fmt.Errorf("clear done items: %w", err)
	}
	// Only what is still unchecked counts as "unfinished from yesterday"; the
	// recurring items are still done at this point, and are cleared below.
	if _, err := tx.Exec(
		`UPDATE todo_items SET rolled_over = 1, updated_at = ? WHERE list_id = ? AND done = 0`, now, id,
	); err != nil {
		return nil, fmt.Errorf("roll over items: %w", err)
	}
	// Everything still done is recurring (or a subtask of something that is):
	// uncheck rather than delete.
	if _, err := tx.Exec(
		`UPDATE todo_items SET done = 0, completed_at = NULL, updated_at = ? WHERE list_id = ? AND done = 1`, now, id,
	); err != nil {
		return nil, fmt.Errorf("reset recurring items: %w", err)
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
		ID:     uuid.NewString(),
		ListID: listID,
		Text:   text,
		// Mirror the column default rather than leaving the returned struct
		// with an empty mode the client would have to guess at.
		ResetMode: ResetModeCalendar,
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
	ResetMode     *string
	DueAt         *time.Time
	ClearDueAt    bool
	MomentID      *string
	ClearMomentID bool
}

// UpdateTodoItem applies a partial update. Setting done true stamps
// completed_at; done false clears it.
//
// Recurrence: when this update *transitions* a recurring item to done, the
// item stays done and its due date moves to the next occurrence. It is the
// same task all the way through, one row, one history, and it unchecks
// itself once that occurrence arrives (see sweepRecurringItems). Completing
// one used to insert a fresh undone copy instead, which read as the task
// respawning the instant you ticked it off.
func UpdateTodoItem(id string, p TodoItemPatch) (*models.TodoItem, error) {
	// Snapshot the pre-update state so we can detect the not-done → done edge
	// (and read the recurrence/due date we need to schedule the next one).
	before, err := getTodoItem(id)
	if err != nil {
		return nil, err
	}
	if before == nil {
		return nil, nil
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
	if p.ResetMode != nil {
		sets = append(sets, "reset_mode = ?")
		args = append(args, normalizeResetMode(*p.ResetMode))
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
		return before, nil
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, time.Now().UTC(), id)
	res, err := db.DB.Exec(`UPDATE todo_items SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("update todo item %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, nil
	}
	updated, err := getTodoItem(id)
	if err != nil {
		return nil, err
	}

	// Schedule on the completion edge: the item must now be done, must not
	// have been done before, and must carry a recurrence rule. Subtasks don't
	// recur on their own (their parent's rule governs the cycle).
	if updated != nil && updated.Done && !before.Done && updated.Recurrence != "" && updated.ParentID == nil {
		if err := scheduleNextOccurrence(updated); err != nil {
			return nil, err
		}
	}
	return updated, nil
}

// scheduleNextOccurrence points a just-completed recurring item at its next
// occurrence, which is also the moment it unchecks itself.
//
// The base is the completion time, NOT the item's existing due date. That
// matters: unchecking an item leaves its due date alone, so basing the next
// occurrence on it made every uncheck-and-recheck advance the schedule another
// period. Toggling a daily task five times pushed it five days out and it
// stopped being daily. Deriving from completed_at makes repeated completion
// idempotent, because the last completion simply recomputes the same answer.
func scheduleNextOccurrence(item *models.TodoItem) error {
	now := time.Now().UTC()
	base := now
	if item.CompletedAt != nil {
		base = *item.CompletedAt
	}
	next := nextOccurrence(base, item.Recurrence, item.ResetMode)
	// Defensive: a rule that failed to advance past the completion time would
	// uncheck the item immediately, so step it on until it is in the future.
	for i := 0; i < recurrenceLoopCap && !next.After(base); i++ {
		next = nextOccurrence(next, item.Recurrence, item.ResetMode)
	}
	if _, err := db.DB.Exec(
		`UPDATE todo_items SET due_at = ?, updated_at = ? WHERE id = ?`, next, now, item.ID,
	); err != nil {
		return fmt.Errorf("schedule next occurrence for %s: %w", item.ID, err)
	}
	item.DueAt = &next
	item.UpdatedAt = now
	return nil
}

// nextOccurrence is when a task completed at `from` comes back.
//
// ResetModeInterval adds one whole period, so finishing early pushes the next
// one out. ResetModeCalendar jumps to the start of the next period instead, so
// a daily task resets each day whatever time it was ticked off, which is what
// "daily task" is usually taken to mean. Calendar boundaries are computed in
// the server's local time: this is a self-hosted, one-library-per-server app
// (ADR-0004), so the server's clock is the library's clock. A member in
// another timezone sees the reset happen at the host's midnight, not theirs.
func nextOccurrence(from time.Time, rule string, mode string) time.Time {
	if mode != ResetModeCalendar {
		return advanceRecurrence(from, rule)
	}
	local := from.Local()
	midnight := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	switch rule {
	case "weekly":
		// The Monday after the week `from` falls in. Go weeks start on Sunday,
		// so shift the index to make Monday day 0.
		offset := (int(midnight.Weekday()) + 6) % 7
		return midnight.AddDate(0, 0, 7-offset).UTC()
	case "monthly":
		return time.Date(local.Year(), local.Month()+1, 1, 0, 0, 0, 0, local.Location()).UTC()
	default: // "daily" and any unknown rule
		return midnight.AddDate(0, 0, 1).UTC()
	}
}

// sweepRecurringItems unchecks completed recurring items whose next occurrence
// has come round, which is what makes a repeating task repeat. It runs on the
// read path because nothing polls this module server-side and the board is
// fetched fresh every time it opens, so "when you next look at it" is exactly
// when a stale checkbox would be visible.
//
// An item's next occurrence is its due date (scheduleNextOccurrence put it
// there on completion); an item completed before it was given a rule has no
// due date, so its completion time plus one step stands in. On reset the due
// date rolls forward to the occurrence that has just come round rather than
// staying at the one first missed, so a daily task left for a week reads as
// due today instead of a week overdue.
func sweepRecurringItems() error {
	now := time.Now().UTC()
	rows, err := db.DB.Query(
		`SELECT ` + todoItemColumns + ` FROM todo_items
		 WHERE done = 1 AND recurrence != '' AND parent_id IS NULL`,
	)
	if err != nil {
		return fmt.Errorf("scan recurring items: %w", err)
	}
	defer rows.Close()

	due := []*models.TodoItem{}
	for rows.Next() {
		item, err := scanTodoItem(rows)
		if err != nil {
			return fmt.Errorf("scan recurring item: %w", err)
		}
		at := occurrenceDue(item)
		if at == nil || at.After(now) {
			continue
		}
		due = append(due, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()

	for _, item := range due {
		if err := resetRecurringItem(item, now); err != nil {
			return err
		}
	}
	return nil
}

// occurrenceDue is when a completed recurring item is next owed, i.e. when it
// unchecks. nil means "can't tell" (no due date and never stamped complete),
// which leaves the item alone rather than guessing.
func occurrenceDue(item *models.TodoItem) *time.Time {
	if item.DueAt != nil {
		return item.DueAt
	}
	if item.CompletedAt != nil {
		at := nextOccurrence(*item.CompletedAt, item.Recurrence, item.ResetMode)
		return &at
	}
	return nil
}

// resetRecurringItem unchecks one recurring item and its subtasks, and parks
// its due date on the occurrence that has just come round.
func resetRecurringItem(item *models.TodoItem, now time.Time) error {
	at := occurrenceDue(item)
	if at == nil {
		return nil // nothing to reset against; the sweep already filters these out
	}
	occurrence := *at
	for i := 0; i < recurrenceLoopCap; i++ {
		next := nextOccurrence(occurrence, item.Recurrence, item.ResetMode)
		if next.After(now) {
			break
		}
		occurrence = next
	}

	tx, err := db.DB.Begin()
	if err != nil {
		return fmt.Errorf("begin recurrence reset: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`UPDATE todo_items SET done = 0, completed_at = NULL, due_at = ?, updated_at = ? WHERE id = ?`,
		occurrence, now, item.ID,
	); err != nil {
		return fmt.Errorf("reset recurring item %s: %w", item.ID, err)
	}
	// The routine starts over as a whole, so its steps come back unticked too.
	if _, err := tx.Exec(
		`UPDATE todo_items SET done = 0, completed_at = NULL, updated_at = ? WHERE parent_id = ? AND done = 1`,
		now, item.ID,
	); err != nil {
		return fmt.Errorf("reset subtasks of %s: %w", item.ID, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit recurrence reset: %w", err)
	}
	return nil
}

// notRecurring matches items that take no part in a recurring cycle: no rule
// of their own, and not a step of something that has one.
const notRecurring = `recurrence = '' AND NOT EXISTS (
	SELECT 1 FROM todo_items parent WHERE parent.id = todo_items.parent_id AND parent.recurrence != ''
)`

// Reset modes for a repeating task. Anything unrecognised is normalised to
// ResetModeCalendar, which is also the column default, so a task always has a
// well-defined answer to "when does this come back".
const (
	ResetModeCalendar = "calendar"
	ResetModeInterval = "interval"
)

// normalizeResetMode keeps an unknown value from silently behaving as interval.
func normalizeResetMode(mode string) string {
	if mode == ResetModeInterval {
		return ResetModeInterval
	}
	return ResetModeCalendar
}

// recurrenceLoopCap bounds the roll-forward loops. An item can be arbitrarily
// stale (a daily task untouched for years), but the loop must terminate even
// if a rule ever advances by zero.
const recurrenceLoopCap = 10000

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
	 due_at, priority, moment_id, recurrence, reset_mode, parent_id, created_at, updated_at`

func scanTodoItem(s scannerT) (*models.TodoItem, error) {
	todoItem := &models.TodoItem{}
	var completedAt, dueAt sql.NullTime
	var momentID, parentID sql.NullString
	if err := s.Scan(
		&todoItem.ID, &todoItem.ListID, &todoItem.Text, &todoItem.Done, &todoItem.Position, &todoItem.RolledOver, &completedAt,
		&dueAt, &todoItem.Priority, &momentID, &todoItem.Recurrence, &todoItem.ResetMode, &parentID, &todoItem.CreatedAt, &todoItem.UpdatedAt,
	); err != nil {
		return nil, err
	}
	todoItem.ResetMode = normalizeResetMode(todoItem.ResetMode)
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

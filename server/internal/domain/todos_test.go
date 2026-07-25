package domain

import (
	"testing"
	"time"
)

// helper: make a general list and return it.
func newGeneralList(t *testing.T) string {
	t.Helper()
	l, err := CreateTodoList("general", "Tasks", nil)
	if err != nil {
		t.Fatalf("create list: %v", err)
	}
	return l.ID
}

func TestUpdateTodoItem_TogglePreservesSignature(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, err := CreateTodoItem(listID, "plain task", nil)
	if err != nil {
		t.Fatalf("create item: %v", err)
	}

	done := true
	updated, regen, err := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated == nil || !updated.Done {
		t.Fatalf("expected item done, got %+v", updated)
	}
	if updated.CompletedAt == nil {
		t.Error("completing an item should stamp completed_at")
	}
	// A non-recurring item must not spawn anything.
	if regen != nil {
		t.Errorf("non-recurring item should not regenerate, got %+v", regen)
	}
}

func TestUpdateTodoItem_MissingItem(t *testing.T) {
	setupDB(t)
	updated, regen, err := UpdateTodoItem("does-not-exist", TodoItemPatch{})
	if err != nil {
		t.Fatalf("update missing: %v", err)
	}
	if updated != nil || regen != nil {
		t.Errorf("missing item should return nils, got %+v / %+v", updated, regen)
	}
}

func TestUpdateTodoItem_RecurrenceRegeneratesNextOccurrence(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, _ := CreateTodoItem(listID, "water plants", nil)

	// Give it a weekly recurrence and a due date in the recent past.
	due := time.Now().UTC().AddDate(0, 0, -2)
	weekly := "weekly"
	if _, _, err := UpdateTodoItem(item.ID, TodoItemPatch{Recurrence: &weekly, DueAt: &due}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}

	// Completing it should spawn the next occurrence.
	done := true
	updated, regen, err := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if !updated.Done {
		t.Fatal("original item should be done")
	}
	if regen == nil {
		t.Fatal("completing a recurring item should regenerate the next occurrence")
	}
	if regen.Done {
		t.Error("regenerated item should be undone")
	}
	if regen.Recurrence != "weekly" || regen.Text != "water plants" {
		t.Errorf("regenerated item lost fields: %+v", regen)
	}
	if regen.DueAt == nil || !regen.DueAt.After(time.Now().UTC()) {
		t.Errorf("regenerated due date should be in the future, got %v", regen.DueAt)
	}

	// The list now holds two items (the completed one + the fresh one).
	list, _ := GetTodoList(listID)
	if len(list.Items) != 2 {
		t.Fatalf("expected 2 items after regeneration, got %d", len(list.Items))
	}
}

func TestUpdateTodoItem_NoRegenerationOnReComplete(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, _ := CreateTodoItem(listID, "daily standup", nil)
	daily := "daily"
	if _, _, err := UpdateTodoItem(item.ID, TodoItemPatch{Recurrence: &daily}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}

	done := true
	if _, regen, _ := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done}); regen == nil {
		t.Fatal("first completion should regenerate")
	}
	// Patching an already-done item again must not spawn a second occurrence.
	if _, regen, _ := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done}); regen != nil {
		t.Errorf("re-completing an already-done item should not regenerate, got %+v", regen)
	}
}

func TestUpdateTodoItem_SubtaskDoesNotRecur(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	parent, _ := CreateTodoItem(listID, "parent", nil)
	sub, _ := CreateTodoItem(listID, "child", &parent.ID)
	weekly := "weekly"
	if _, _, err := UpdateTodoItem(sub.ID, TodoItemPatch{Recurrence: &weekly}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}

	done := true
	if _, regen, _ := UpdateTodoItem(sub.ID, TodoItemPatch{Done: &done}); regen != nil {
		t.Errorf("a subtask should not spawn its own recurrence, got %+v", regen)
	}
}

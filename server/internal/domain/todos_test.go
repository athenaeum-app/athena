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

// helper: mark an item done and fail on error.
func complete(t *testing.T, id string) {
	t.Helper()
	done := true
	if _, err := UpdateTodoItem(id, TodoItemPatch{Done: &done}); err != nil {
		t.Fatalf("complete %s: %v", id, err)
	}
}

func TestUpdateTodoItem_TogglePreservesSignature(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, err := CreateTodoItem(listID, "plain task", nil)
	if err != nil {
		t.Fatalf("create item: %v", err)
	}

	done := true
	updated, err := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated == nil || !updated.Done {
		t.Fatalf("expected item done, got %+v", updated)
	}
	if updated.CompletedAt == nil {
		t.Error("completing an item should stamp completed_at")
	}
	// A non-recurring item gets no schedule of its own.
	if updated.DueAt != nil {
		t.Errorf("non-recurring item should not gain a due date, got %v", updated.DueAt)
	}
}

func TestUpdateTodoItem_MissingItem(t *testing.T) {
	setupDB(t)
	updated, err := UpdateTodoItem("does-not-exist", TodoItemPatch{})
	if err != nil {
		t.Fatalf("update missing: %v", err)
	}
	if updated != nil {
		t.Errorf("missing item should return nil, got %+v", updated)
	}
}

// Completing a repeating task must not put a second copy of it on the board:
// the one item stays done and simply comes due again later.
func TestUpdateTodoItem_RecurrenceReschedulesInPlace(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, _ := CreateTodoItem(listID, "water plants", nil)

	// Give it a weekly recurrence and a due date in the recent past.
	due := time.Now().UTC().AddDate(0, 0, -2)
	weekly := "weekly"
	if _, err := UpdateTodoItem(item.ID, TodoItemPatch{Recurrence: &weekly, DueAt: &due}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}

	done := true
	updated, err := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done})
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if !updated.Done {
		t.Error("a completed recurring item should stay completed")
	}
	if updated.DueAt == nil || !updated.DueAt.After(time.Now().UTC()) {
		t.Errorf("next occurrence should be in the future, got %v", updated.DueAt)
	}

	// The whole point: still one task, not two.
	list, _ := GetTodoList(listID)
	if len(list.Items) != 1 {
		t.Fatalf("completing a recurring item should not spawn a copy; got %d items", len(list.Items))
	}
	if !list.Items[0].Done {
		t.Error("the item should still read as done until its next occurrence arrives")
	}
}

func TestUpdateTodoItem_NoRescheduleOnReComplete(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, _ := CreateTodoItem(listID, "daily standup", nil)
	daily := "daily"
	if _, err := UpdateTodoItem(item.ID, TodoItemPatch{Recurrence: &daily}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}

	done := true
	first, _ := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done})
	if first.DueAt == nil {
		t.Fatal("first completion should schedule the next occurrence")
	}
	// Patching an already-done item must not push the schedule out again.
	again, _ := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done})
	if again.DueAt == nil || !again.DueAt.Equal(*first.DueAt) {
		t.Errorf("re-completing should leave the schedule alone: %v -> %v", first.DueAt, again.DueAt)
	}
}

// The reported bug: unchecking and rechecking a daily task used to advance its
// due date another day each time, because the next occurrence was derived from
// the existing due date rather than from when the task was completed.
func TestUpdateTodoItem_TogglingDoesNotDriftTheSchedule(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, _ := CreateTodoItem(listID, "water plants", nil)
	daily := "daily"
	if _, err := UpdateTodoItem(item.ID, TodoItemPatch{Recurrence: &daily}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}

	done, undone := true, false
	first, err := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done})
	if err != nil || first.DueAt == nil {
		t.Fatalf("first completion: %v %+v", err, first)
	}

	for i := 0; i < 5; i++ {
		if _, err := UpdateTodoItem(item.ID, TodoItemPatch{Done: &undone}); err != nil {
			t.Fatalf("uncheck %d: %v", i, err)
		}
		if _, err := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done}); err != nil {
			t.Fatalf("recheck %d: %v", i, err)
		}
	}

	after, err := getTodoItem(item.ID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if after.DueAt == nil || !after.DueAt.Equal(*first.DueAt) {
		t.Errorf("five toggles moved the schedule: %v -> %v", first.DueAt, after.DueAt)
	}
}

// Calendar mode is the default: a daily task comes back at the next midnight,
// whatever time of day it was ticked off.
func TestUpdateTodoItem_CalendarModeResetsAtTheNextBoundary(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, _ := CreateTodoItem(listID, "take medication", nil)
	daily := "daily"
	if _, err := UpdateTodoItem(item.ID, TodoItemPatch{Recurrence: &daily}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}
	if item.ResetMode != ResetModeCalendar {
		t.Errorf("calendar should be the default reset mode, got %q", item.ResetMode)
	}

	done := true
	updated, err := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done})
	if err != nil || updated.DueAt == nil {
		t.Fatalf("complete: %v %+v", err, updated)
	}

	now := time.Now()
	wantMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, 1)
	if !updated.DueAt.Equal(wantMidnight.UTC()) {
		t.Errorf("expected the next local midnight %v, got %v", wantMidnight.UTC(), updated.DueAt)
	}
}

// Interval mode is the opt-in: a full period after completion, so finishing
// early pushes the next one out.
func TestUpdateTodoItem_IntervalModeAddsAWholePeriod(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, _ := CreateTodoItem(listID, "water the office plants", nil)
	daily := "daily"
	interval := ResetModeInterval
	if _, err := UpdateTodoItem(item.ID, TodoItemPatch{Recurrence: &daily, ResetMode: &interval}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}

	done := true
	updated, err := UpdateTodoItem(item.ID, TodoItemPatch{Done: &done})
	if err != nil || updated.DueAt == nil {
		t.Fatalf("complete: %v %+v", err, updated)
	}
	if updated.ResetMode != ResetModeInterval {
		t.Errorf("reset mode should have persisted, got %q", updated.ResetMode)
	}
	want := updated.CompletedAt.AddDate(0, 0, 1)
	if diff := updated.DueAt.Sub(want); diff > time.Second || diff < -time.Second {
		t.Errorf("expected completion + 24h (%v), got %v", want, updated.DueAt)
	}
}

func TestUpdateTodoItem_UnknownResetModeFallsBackToCalendar(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, _ := CreateTodoItem(listID, "nonsense mode", nil)
	daily := "daily"
	bogus := "whenever"
	updated, err := UpdateTodoItem(item.ID, TodoItemPatch{Recurrence: &daily, ResetMode: &bogus})
	if err != nil {
		t.Fatalf("set recurrence: %v", err)
	}
	if updated.ResetMode != ResetModeCalendar {
		t.Errorf("an unrecognised mode should normalise to calendar, got %q", updated.ResetMode)
	}
}

func TestUpdateTodoItem_SubtaskDoesNotRecur(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	parent, _ := CreateTodoItem(listID, "parent", nil)
	sub, _ := CreateTodoItem(listID, "child", &parent.ID)
	weekly := "weekly"
	if _, err := UpdateTodoItem(sub.ID, TodoItemPatch{Recurrence: &weekly}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}

	done := true
	updated, _ := UpdateTodoItem(sub.ID, TodoItemPatch{Done: &done})
	if updated.DueAt != nil {
		t.Errorf("a subtask should not schedule its own recurrence, got %v", updated.DueAt)
	}
}

// The other half of the cycle: the task unchecks itself once the interval is up.
func TestSweep_UnchecksWhenTheOccurrenceArrives(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, _ := CreateTodoItem(listID, "take the bins out", nil)
	daily := "daily"
	if _, err := UpdateTodoItem(item.ID, TodoItemPatch{Recurrence: &daily}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}
	complete(t, item.ID)

	// Wind the scheduled occurrence back three days, as if time had passed.
	past := time.Now().UTC().AddDate(0, 0, -3)
	if _, err := UpdateTodoItem(item.ID, TodoItemPatch{DueAt: &past}); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	list, err := GetTodoList(listID)
	if err != nil {
		t.Fatalf("read list: %v", err)
	}
	got := list.Items[0]
	if got.Done {
		t.Fatal("a recurring item should uncheck itself once its occurrence has passed")
	}
	if got.CompletedAt != nil {
		t.Errorf("the completion stamp should be cleared, got %v", got.CompletedAt)
	}
	if got.ID != item.ID || len(list.Items) != 1 {
		t.Errorf("expected the same single item back, got %d items", len(list.Items))
	}
	// Caught up to the current day rather than left three days overdue.
	now := time.Now().UTC()
	if got.DueAt == nil || got.DueAt.After(now) || got.DueAt.Before(now.AddDate(0, 0, -1)) {
		t.Errorf("due date should have rolled forward to the current occurrence, got %v", got.DueAt)
	}
}

func TestSweep_LeavesAPendingOccurrenceAlone(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	item, _ := CreateTodoItem(listID, "weekly review", nil)
	weekly := "weekly"
	if _, err := UpdateTodoItem(item.ID, TodoItemPatch{Recurrence: &weekly}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}
	complete(t, item.ID)

	list, _ := GetTodoList(listID)
	if !list.Items[0].Done {
		t.Error("an item completed inside its own period should stay checked")
	}
}

func TestSweep_UnchecksSubtasksWithTheirParent(t *testing.T) {
	setupDB(t)
	listID := newGeneralList(t)
	parent, _ := CreateTodoItem(listID, "morning routine", nil)
	sub, _ := CreateTodoItem(listID, "make the bed", &parent.ID)
	daily := "daily"
	if _, err := UpdateTodoItem(parent.ID, TodoItemPatch{Recurrence: &daily}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}
	complete(t, sub.ID)
	complete(t, parent.ID)

	past := time.Now().UTC().AddDate(0, 0, -1)
	if _, err := UpdateTodoItem(parent.ID, TodoItemPatch{DueAt: &past}); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	list, _ := GetTodoList(listID)
	for _, it := range list.Items {
		if it.Done {
			t.Errorf("%q should have been unchecked with its parent", it.Text)
		}
	}
}

// A daily list's Reset-day button clears out completed items. A recurring item
// is a standing habit, not a one-off, so it has to survive that.
func TestResetDailyList_KeepsRecurringItems(t *testing.T) {
	setupDB(t)
	list, err := CreateTodoList("daily", "Rituals", nil)
	if err != nil {
		t.Fatalf("create list: %v", err)
	}
	habit, _ := CreateTodoItem(list.ID, "stretch", nil)
	step, _ := CreateTodoItem(list.ID, "touch toes", &habit.ID)
	oneOff, _ := CreateTodoItem(list.ID, "call the dentist", nil)
	unfinished, _ := CreateTodoItem(list.ID, "read a chapter", nil)

	daily := "daily"
	if _, err := UpdateTodoItem(habit.ID, TodoItemPatch{Recurrence: &daily}); err != nil {
		t.Fatalf("set recurrence: %v", err)
	}
	complete(t, habit.ID)
	complete(t, step.ID)
	complete(t, oneOff.ID)

	reset, err := ResetDailyList(list.ID)
	if err != nil {
		t.Fatalf("reset: %v", err)
	}

	byID := map[string]bool{}
	rolled := map[string]bool{}
	for _, it := range reset.Items {
		byID[it.ID] = it.Done
		rolled[it.ID] = it.RolledOver
	}
	if _, ok := byID[oneOff.ID]; ok {
		t.Error("a completed one-off should be cleared by the daily reset")
	}
	for _, id := range []string{habit.ID, step.ID} {
		done, ok := byID[id]
		if !ok {
			t.Fatalf("recurring item %s was deleted by the daily reset", id)
		}
		if done {
			t.Errorf("recurring item %s should come back unchecked", id)
		}
		if rolled[id] {
			t.Errorf("recurring item %s was completed, so it is not unfinished business", id)
		}
	}
	if !rolled[unfinished.ID] {
		t.Error("an item left unchecked should be flagged as rolled over")
	}
}

package domain

import "testing"

func TestArchiveCRUD(t *testing.T) {
	setupDB(t)

	a, err := CreateArchive("Journal")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if a.ID == "" || a.Name != "Journal" {
		t.Fatalf("unexpected archive %+v", a)
	}

	got, err := GetArchive(a.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got == nil || got.Name != "Journal" {
		t.Fatalf("get returned %+v", got)
	}

	updated, err := UpdateArchive(a.ID, "Diary")
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Name != "Diary" {
		t.Errorf("name = %q, want Diary", updated.Name)
	}

	// A second archive is needed so deleting the first does not trip the
	// no-delete-last guard (a library must always keep >= 1 archive).
	if _, err := CreateArchive("Keeper"); err != nil {
		t.Fatalf("create second archive: %v", err)
	}

	if err := DeleteArchive(a.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, _ = GetArchive(a.ID)
	if got != nil {
		t.Error("archive should be gone after delete")
	}
}

func TestCreateArchive_DuplicateNameConflicts(t *testing.T) {
	setupDB(t)
	if _, err := CreateArchive("Journal"); err != nil {
		t.Fatalf("create: %v", err)
	}
	// Case-insensitive uniqueness: "journal" collides with "Journal".
	if _, err := CreateArchive("journal"); err != ErrArchiveNameTaken {
		t.Fatalf("expected ErrArchiveNameTaken, got %v", err)
	}
}

func TestDeleteArchive_RefusesLast(t *testing.T) {
	setupDB(t)
	a, err := CreateArchive("Only")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := DeleteArchive(a.ID); err != ErrLastArchive {
		t.Fatalf("expected ErrLastArchive, got %v", err)
	}
}

func TestEnsureDefaultArchive_SeedsWhenEmpty(t *testing.T) {
	setupDB(t)
	list, err := ListArchives()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0].Name != DefaultArchiveName {
		t.Fatalf("expected a single %q archive, got %+v", DefaultArchiveName, list)
	}
}

func TestGetArchive_NotFound(t *testing.T) {
	setupDB(t)
	got, err := GetArchive("missing")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Error("expected nil for missing archive")
	}
}

func TestListArchives_OrderedByName(t *testing.T) {
	setupDB(t)
	CreateArchive("Zeta")
	CreateArchive("Alpha")
	CreateArchive("Mu")

	list, err := ListArchives()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3, got %d", len(list))
	}
	if list[0].Name != "Alpha" || list[1].Name != "Mu" || list[2].Name != "Zeta" {
		t.Errorf("not ordered by name: %v", []string{list[0].Name, list[1].Name, list[2].Name})
	}
}

func TestDeleteArchive_CascadesMoments(t *testing.T) {
	setupDB(t)
	a, _ := CreateArchive("Journal")
	m, _ := CreateMoment(a.ID, "", "title", "body", nil)
	// Second archive keeps the library non-empty so the delete is permitted.
	if _, err := CreateArchive("Keeper"); err != nil {
		t.Fatalf("create second archive: %v", err)
	}

	if err := DeleteArchive(a.ID); err != nil {
		t.Fatalf("delete archive: %v", err)
	}
	got, _ := GetMoment(m.ID)
	if got != nil {
		t.Error("moment should cascade-delete with its archive")
	}
}

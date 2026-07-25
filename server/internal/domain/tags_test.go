package domain

import "testing"

func TestTagCRUD(t *testing.T) {
	setupDB(t)

	tag, err := CreateTag("work", "#ff0000")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if tag.Name != "work" || tag.Color != "#ff0000" {
		t.Fatalf("unexpected tag %+v", tag)
	}

	got, err := GetTag(tag.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got == nil || got.Name != "work" {
		t.Fatalf("get returned %+v", got)
	}

	if err := DeleteTag(tag.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, _ = GetTag(tag.ID)
	if got != nil {
		t.Error("tag should be gone after delete")
	}
}

func TestUpdateTag_PartialUpdate(t *testing.T) {
	setupDB(t)
	tag, _ := CreateTag("work", "#ff0000")

	// Update only the color.
	newColor := "#00ff00"
	updated, err := UpdateTag(tag.ID, nil, &newColor)
	if err != nil {
		t.Fatalf("update color: %v", err)
	}
	if updated.Color != "#00ff00" {
		t.Errorf("color = %q, want #00ff00", updated.Color)
	}
	if updated.Name != "work" {
		t.Errorf("name should be unchanged, got %q", updated.Name)
	}

	// Update only the name.
	newName := "personal"
	updated, err = UpdateTag(tag.ID, &newName, nil)
	if err != nil {
		t.Fatalf("update name: %v", err)
	}
	if updated.Name != "personal" || updated.Color != "#00ff00" {
		t.Errorf("unexpected after name update: %+v", updated)
	}
}

func TestUpdateTag_NoFields(t *testing.T) {
	setupDB(t)
	tag, _ := CreateTag("work", "#ff0000")

	got, err := UpdateTag(tag.ID, nil, nil)
	if err != nil {
		t.Fatalf("update no fields: %v", err)
	}
	if got == nil || got.Name != "work" {
		t.Error("no-field update should return the unchanged tag")
	}
}

func TestListTags_OrderedByName(t *testing.T) {
	setupDB(t)
	CreateTag("zebra", "#111")
	CreateTag("apple", "#222")

	list, err := ListTags()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 || list[0].Name != "apple" || list[1].Name != "zebra" {
		t.Errorf("tags not ordered by name: %+v", list)
	}
}

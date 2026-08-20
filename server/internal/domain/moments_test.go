package domain

import (
	"testing"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
)

func TestCreateAndGetMoment_WithTags(t *testing.T) {
	setupDB(t)
	a, _ := CreateArchive("Journal")
	t1, _ := CreateTag("work", "#111")
	t2, _ := CreateTag("idea", "#222")

	m, err := CreateMoment(a.ID, "", "Title", "# Body", []string{t1.ID, t2.ID})
	if err != nil {
		t.Fatalf("create moment: %v", err)
	}
	if m.AuthorID != nil {
		t.Error("empty authorID should store as nil (legacy)")
	}

	got, err := GetMoment(m.ID)
	if err != nil {
		t.Fatalf("get moment: %v", err)
	}
	if got == nil {
		t.Fatal("moment not found")
	}
	if got.Title != "Title" || got.Content != "# Body" {
		t.Errorf("unexpected content: %+v", got)
	}
	if len(got.TagIDs) != 2 {
		t.Errorf("expected 2 tags, got %v", got.TagIDs)
	}
}

func TestGetMoment_NotFound(t *testing.T) {
	setupDB(t)
	got, err := GetMoment("missing")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Error("expected nil for missing moment")
	}
}

func TestListMoments_ArchiveFilterAndPagination(t *testing.T) {
	setupDB(t)
	a1, _ := CreateArchive("One")
	a2, _ := CreateArchive("Two")

	// Three moments in a1, one in a2.
	for i := 0; i < 3; i++ {
		CreateMoment(a1.ID, "", "a1-"+time.Now().String(), "body", nil)
	}
	CreateMoment(a2.ID, "", "a2", "body", nil)

	// Filter by archive.
	only1, err := ListMoments(&a1.ID, nil, 50, nil)
	if err != nil {
		t.Fatalf("list a1: %v", err)
	}
	if len(only1) != 3 {
		t.Errorf("expected 3 moments in a1, got %d", len(only1))
	}

	// Across all archives.
	all, _ := ListMoments(nil, nil, 50, nil)
	if len(all) != 4 {
		t.Errorf("expected 4 moments total, got %d", len(all))
	}

	// Pagination: first page of 2, then the rest.
	page1, _ := ListMoments(&a1.ID, nil, 2, nil)
	if len(page1) != 2 {
		t.Fatalf("expected page size 2, got %d", len(page1))
	}
	last := page1[len(page1)-1]
	cursor := &MomentCursor{Timestamp: last.Timestamp, ID: last.ID}
	page2, _ := ListMoments(&a1.ID, cursor, 2, nil)
	if len(page2) != 1 {
		t.Errorf("expected 1 moment on page 2, got %d", len(page2))
	}
	// No overlap between pages.
	for _, m := range page2 {
		if m.ID == last.ID {
			t.Error("cursor pagination returned an overlapping moment")
		}
	}
}

func TestUpdateMoment_ReplacesTagsAndBumpsUpdatedAt(t *testing.T) {
	setupDB(t)
	a, _ := CreateArchive("Journal")
	t1, _ := CreateTag("a", "#111")
	t2, _ := CreateTag("b", "#222")
	m, _ := CreateMoment(a.ID, "", "Title", "Body", []string{t1.ID})

	time.Sleep(2 * time.Millisecond) // ensure updated_at advances
	updated, err := UpdateMoment(m.ID, "New Title", "New Body", []string{t2.ID})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated == nil {
		t.Fatal("update returned nil for existing moment")
	}
	if updated.Title != "New Title" || updated.Content != "New Body" {
		t.Errorf("content not updated: %+v", updated)
	}
	if len(updated.TagIDs) != 1 || updated.TagIDs[0] != t2.ID {
		t.Errorf("tags not replaced: %v", updated.TagIDs)
	}
	if !updated.UpdatedAt.After(m.UpdatedAt) {
		t.Error("updated_at should advance on update")
	}
}

func TestUpdateMoment_Missing(t *testing.T) {
	setupDB(t)
	got, err := UpdateMoment("missing", "t", "c", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Error("updating a missing moment should return nil")
	}
}

func TestDeleteRestoreMoment_SoftDelete(t *testing.T) {
	setupDB(t)
	a, _ := CreateArchive("Journal")
	m, _ := CreateMoment(a.ID, "", "Title", "Body", nil)

	if err := DeleteMoment(m.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	// Soft-deleted moments are excluded from listings...
	list, _ := ListMoments(&a.ID, nil, 50, nil)
	if len(list) != 0 {
		t.Errorf("soft-deleted moment should not appear in listings, got %d", len(list))
	}
	// ...but the row still exists and carries deleted_at.
	got, _ := GetMoment(m.ID)
	if got == nil || got.DeletedAt == nil {
		t.Fatal("soft-deleted moment should still be fetchable with deleted_at set")
	}

	// Restore brings it back.
	if err := RestoreMoment(m.ID); err != nil {
		t.Fatalf("restore: %v", err)
	}
	list, _ = ListMoments(&a.ID, nil, 50, nil)
	if len(list) != 1 {
		t.Errorf("restored moment should reappear, got %d", len(list))
	}
}

func TestSearchMoments_FTS(t *testing.T) {
	setupDB(t)
	a, _ := CreateArchive("Journal")
	CreateMoment(a.ID, "", "Grocery list", "milk and eggs", nil)
	CreateMoment(a.ID, "", "Trip notes", "flight to Tokyo", nil)

	hits, err := SearchMoments("Tokyo", nil, nil, 50, nil)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 1 || hits[0].Title != "Trip notes" {
		t.Errorf("expected one Tokyo hit, got %+v", hits)
	}

	// Title matches too.
	hits, _ = SearchMoments("Grocery", nil, nil, 50, nil)
	if len(hits) != 1 || hits[0].Title != "Grocery list" {
		t.Errorf("expected Grocery hit, got %+v", hits)
	}
}

// The composer's picker (ADR-0019) searches while the word is still being
// typed, so a partial word has to find the moment.
func TestSearchMoments_PrefixAndPunctuation(t *testing.T) {
	setupDB(t)
	a, _ := CreateArchive("Journal")
	CreateMoment(a.ID, "", "Grocery list", "milk and eggs", nil)
	CreateMoment(a.ID, "", "Trip notes", "don't forget the flight", nil)

	hits, err := SearchMoments("groc", nil, nil, 50, nil)
	if err != nil {
		t.Fatalf("prefix search: %v", err)
	}
	if len(hits) != 1 || hits[0].Title != "Grocery list" {
		t.Errorf("expected the prefix to find Grocery list, got %+v", hits)
	}

	// An apostrophe is FTS5 syntax, so raw input here used to fail the query.
	hits, err = SearchMoments("don't", nil, nil, 50, nil)
	if err != nil {
		t.Fatalf("punctuated search: %v", err)
	}
	if len(hits) != 1 || hits[0].Title != "Trip notes" {
		t.Errorf("expected the apostrophe to be searched, not parsed, got %+v", hits)
	}

	// Nothing searchable in the input is not an error, and must not reach MATCH.
	hits, err = SearchMoments("***", nil, nil, 50, nil)
	if err != nil {
		t.Fatalf("empty search: %v", err)
	}
	if len(hits) != 0 {
		t.Errorf("a query with no terms should match nothing, got %d", len(hits))
	}
}

func TestFTSQuery(t *testing.T) {
	cases := map[string]string{
		"Tokyo":        `"Tokyo"*`,
		"milk eggs":    `"milk"* "eggs"*`,
		"don't":        `"don"* "t"*`,
		`say "hi" (x)`: `"say"* "hi"* "x"*`,
		"  ":           "",
		"()":           "",
	}
	for raw, want := range cases {
		if got := FTSQuery(raw); got != want {
			t.Errorf("FTSQuery(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestSearchMoments_ExcludesDeleted(t *testing.T) {
	setupDB(t)
	a, _ := CreateArchive("Journal")
	m, _ := CreateMoment(a.ID, "", "Secret plan", "hidden content", nil)
	DeleteMoment(m.ID)

	hits, _ := SearchMoments("Secret", nil, nil, 50, nil)
	if len(hits) != 0 {
		t.Errorf("soft-deleted moments should not appear in search, got %d", len(hits))
	}
}

func TestListMoments_Filters(t *testing.T) {
	setupDB(t)
	a, _ := CreateArchive("Journal")

	// Media heuristic: content referencing an asset URL path.
	withMedia, _ := CreateMoment(a.ID, "", "Photo day", "look ![](/api/v1/assets/pic.png)", nil)
	// Link heuristic: content with an external http(s) URL.
	withLink, _ := CreateMoment(a.ID, "", "Read later", "see https://example.com", nil)
	// Neither.
	plain, _ := CreateMoment(a.ID, "", "Plain thought", "no attachments here", nil)

	hasMedia, err := ListMoments(&a.ID, nil, 50, &MomentFilter{HasMedia: true})
	if err != nil {
		t.Fatalf("filter media: %v", err)
	}
	if len(hasMedia) != 1 || hasMedia[0].ID != withMedia.ID {
		t.Errorf("expected only the media moment, got %+v", hasMedia)
	}

	hasLink, _ := ListMoments(&a.ID, nil, 50, &MomentFilter{HasLink: true})
	if len(hasLink) != 1 || hasLink[0].ID != withLink.ID {
		t.Errorf("expected only the link moment, got %+v", hasLink)
	}

	// Date range: bracket only the middle-created moment. Timestamps are set
	// to now on create, so bound around `plain`'s timestamp.
	from := plain.Timestamp.Add(-time.Millisecond)
	to := plain.Timestamp.Add(time.Millisecond)
	inRange, _ := ListMoments(&a.ID, nil, 50, &MomentFilter{From: &from, To: &to})
	for _, m := range inRange {
		if m.Timestamp.Before(from) || m.Timestamp.After(to) {
			t.Errorf("moment %s outside requested range", m.ID)
		}
	}

	// A nil filter returns everything (unfiltered path unchanged).
	all, _ := ListMoments(&a.ID, nil, 50, nil)
	if len(all) != 3 {
		t.Errorf("expected 3 unfiltered moments, got %d", len(all))
	}
}

func TestPruneDeletedMoments(t *testing.T) {
	setupDB(t)
	a, _ := CreateArchive("Journal")
	keep, _ := CreateMoment(a.ID, "", "keep", "body", nil)
	old, _ := CreateMoment(a.ID, "", "old", "body", nil)

	// Soft-delete both, but backdate one well beyond the prune window.
	DeleteMoment(keep.ID)
	DeleteMoment(old.ID)
	weekAgo := time.Now().UTC().Add(-8 * 24 * time.Hour)
	if _, err := db.DB.Exec(`UPDATE moments SET deleted_at = ? WHERE id = ?`, weekAgo, old.ID); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	n, err := PruneDeletedMoments(7)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if n != 1 {
		t.Errorf("expected 1 pruned moment, got %d", n)
	}
	// The old one is hard-deleted; the recently-deleted one survives.
	if got, _ := GetMoment(old.ID); got != nil {
		t.Error("old moment should be hard-deleted")
	}
	if got, _ := GetMoment(keep.ID); got == nil {
		t.Error("recently-deleted moment should survive the prune window")
	}
}

package domain

import (
	"testing"
	"time"
)

// The point of facets is that tag filtering is AND, so these tests are all
// about which tags still lead somewhere once a selection is applied.

// facetFixture builds a small library:
//
//	Journal: g1,g2  tagged games+roblox      g3 tagged games+dev
//	Ideas:   c1..c3 tagged cooking
//
// so cooking is the most-used tag overall but shares no moment with games.
type facetIDs struct {
	journal, ideas              string
	games, roblox, dev, cooking string
	unused                      string
}

func facetFixture(t *testing.T) facetIDs {
	t.Helper()
	journal, _ := CreateArchive("Journal")
	ideas, _ := CreateArchive("Ideas")
	games, _ := CreateTag("games", "#111111")
	roblox, _ := CreateTag("roblox", "#222222")
	dev, _ := CreateTag("dev", "#333333")
	cooking, _ := CreateTag("cooking", "#444444")
	unused, _ := CreateTag("unused", "#555555")

	if _, err := CreateMoment(journal.ID, "", "g1", "body", []string{games.ID, roblox.ID}); err != nil {
		t.Fatalf("seed g1: %v", err)
	}
	if _, err := CreateMoment(journal.ID, "", "g2", "body", []string{games.ID, roblox.ID}); err != nil {
		t.Fatalf("seed g2: %v", err)
	}
	if _, err := CreateMoment(journal.ID, "", "g3", "body", []string{games.ID, dev.ID}); err != nil {
		t.Fatalf("seed g3: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, err := CreateMoment(ideas.ID, "", "c", "body", []string{cooking.ID}); err != nil {
			t.Fatalf("seed cooking: %v", err)
		}
	}
	return facetIDs{journal.ID, ideas.ID, games.ID, roblox.ID, dev.ID, cooking.ID, unused.ID}
}

func keys(m map[string]int) map[string]bool {
	out := map[string]bool{}
	for k := range m {
		out[k] = true
	}
	return out
}

func TestTagFacets_UnusedTagIsNeverOffered(t *testing.T) {
	setupDB(t)
	ids := facetFixture(t)

	counts, err := TagFacets(nil, "", nil, nil)
	if err != nil {
		t.Fatalf("facets: %v", err)
	}
	if _, ok := counts[ids.unused]; ok {
		t.Error("a tag on no moments can only ever produce an empty feed; it should not be offered")
	}
	if counts[ids.games] != 3 {
		t.Errorf("games count = %d, want 3", counts[ids.games])
	}
	if counts[ids.cooking] != 3 {
		t.Errorf("cooking count = %d, want 3", counts[ids.cooking])
	}
}

func TestTagFacets_SelectionNarrowsToCoOccurringTags(t *testing.T) {
	setupDB(t)
	ids := facetFixture(t)

	counts, err := TagFacets(nil, "", []string{ids.games}, nil)
	if err != nil {
		t.Fatalf("facets: %v", err)
	}
	got := keys(counts)

	// cooking is the most-used tag in the library, but no moment carries both
	// it and games, so offering it would strand the reader on an empty feed.
	if got[ids.cooking] {
		t.Error("cooking shares no moment with games; selecting it would empty the feed")
	}
	for _, want := range []struct {
		id, name string
		n        int
	}{
		{ids.roblox, "roblox", 2},
		{ids.dev, "dev", 1},
		{ids.games, "games", 3},
	} {
		if counts[want.id] != want.n {
			t.Errorf("%s count = %d, want %d", want.name, counts[want.id], want.n)
		}
	}
}

// The selected tags have to come back, or the caller has no way to render them
// as selected and no way to offer un-selecting them.
func TestTagFacets_SelectedTagsAreReturned(t *testing.T) {
	setupDB(t)
	ids := facetFixture(t)

	counts, err := TagFacets(nil, "", []string{ids.games, ids.roblox}, nil)
	if err != nil {
		t.Fatalf("facets: %v", err)
	}
	if counts[ids.games] != 2 || counts[ids.roblox] != 2 {
		t.Errorf("selected tags missing or miscounted: games=%d roblox=%d", counts[ids.games], counts[ids.roblox])
	}
	// dev is on g3, which does not carry roblox, so the pair rules it out.
	if _, ok := counts[ids.dev]; ok {
		t.Error("dev does not co-occur with games+roblox and should not be offered")
	}
}

func TestTagFacets_RespectsArchive(t *testing.T) {
	setupDB(t)
	ids := facetFixture(t)

	counts, err := TagFacets(&ids.ideas, "", nil, nil)
	if err != nil {
		t.Fatalf("facets: %v", err)
	}
	if _, ok := counts[ids.games]; ok {
		t.Error("games has no moment in Ideas and should not be offered while it is the active archive")
	}
	if counts[ids.cooking] != 3 {
		t.Errorf("cooking count in Ideas = %d, want 3", counts[ids.cooking])
	}
}

func TestTagFacets_RespectsDateFilter(t *testing.T) {
	setupDB(t)
	ids := facetFixture(t)

	// Everything above was created now, so a window that closes before now
	// must leave nothing to offer.
	past := time.Now().UTC().Add(-24 * time.Hour)
	counts, err := TagFacets(nil, "", nil, &MomentFilter{To: &past})
	if err != nil {
		t.Fatalf("facets: %v", err)
	}
	if len(counts) != 0 {
		t.Errorf("a window with no moments in it should offer no tags, got %d", len(counts))
	}

	// ...and a window that contains them offers them again.
	counts, err = TagFacets(nil, "", nil, &MomentFilter{From: &past})
	if err != nil {
		t.Fatalf("facets: %v", err)
	}
	if counts[ids.games] != 3 {
		t.Errorf("games count = %d, want 3", counts[ids.games])
	}
}

func TestTagFacets_SoftDeletedMomentsDoNotCount(t *testing.T) {
	setupDB(t)
	ids := facetFixture(t)

	only, err := CreateMoment(ids.journal, "", "doomed", "body", []string{ids.unused})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	counts, _ := TagFacets(nil, "", nil, nil)
	if counts[ids.unused] != 1 {
		t.Fatalf("precondition: unused should be offered while its only moment lives")
	}

	if err := DeleteMoment(only.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	counts, _ = TagFacets(nil, "", nil, nil)
	if _, ok := counts[ids.unused]; ok {
		t.Error("the tag's only moment is in the bin, so filtering by it would show nothing")
	}
}

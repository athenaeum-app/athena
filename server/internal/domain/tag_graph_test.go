package domain

import "testing"

// These reuse facetFixture, whose shape happens to be exactly what a pairing
// test needs: games+roblox twice, games+dev once, and cooking used the same
// number of times as games while sharing a moment with nothing.

func TestTagCoOccurrence_CountsPairsBothWaysRound(t *testing.T) {
	setupDB(t)
	ids := facetFixture(t)

	graph, err := TagCoOccurrence()
	if err != nil {
		t.Fatalf("tag graph: %v", err)
	}

	if got := graph.Pairs[ids.games][ids.roblox]; got != 2 {
		t.Errorf("games/roblox = %d, want 2", got)
	}
	// Read from the other side: the composer looks up partners by the tag the
	// author already picked, which can be either half of the pair.
	if got := graph.Pairs[ids.roblox][ids.games]; got != 2 {
		t.Errorf("roblox/games = %d, want 2", got)
	}
	if got := graph.Pairs[ids.games][ids.dev]; got != 1 {
		t.Errorf("games/dev = %d, want 1", got)
	}
	if _, ok := graph.Pairs[ids.roblox][ids.dev]; ok {
		t.Error("roblox and dev never share a moment; the pair should be absent, not zero")
	}
}

func TestTagCoOccurrence_PairCountOutranksPopularity(t *testing.T) {
	setupDB(t)
	ids := facetFixture(t)

	graph, err := TagCoOccurrence()
	if err != nil {
		t.Fatalf("tag graph: %v", err)
	}

	// The whole point of the endpoint. cooking is used as often as games, so
	// totals alone cannot tell the composer that roblox is the better
	// suggestion once games is picked.
	if graph.Totals[ids.cooking] != graph.Totals[ids.games] {
		t.Fatalf("fixture drifted: cooking %d, games %d, want equal",
			graph.Totals[ids.cooking], graph.Totals[ids.games])
	}
	if graph.Pairs[ids.games][ids.roblox] <= graph.Pairs[ids.games][ids.cooking] {
		t.Error("roblox shares two moments with games and cooking shares none")
	}
}

// The fixture splits cleanly for this: every games/roblox/dev moment is in
// Journal and every cooking moment is in Ideas, so each archive's slice has to
// exclude the other's vocabulary entirely.
func TestTagCoOccurrence_CountsTotalsPerArchive(t *testing.T) {
	setupDB(t)
	ids := facetFixture(t)

	graph, err := TagCoOccurrence()
	if err != nil {
		t.Fatalf("tag graph: %v", err)
	}

	if got := graph.ArchiveTotals[ids.journal][ids.games]; got != 3 {
		t.Errorf("games in Journal = %d, want 3", got)
	}
	if got := graph.ArchiveTotals[ids.journal][ids.roblox]; got != 2 {
		t.Errorf("roblox in Journal = %d, want 2", got)
	}
	if got := graph.ArchiveTotals[ids.ideas][ids.cooking]; got != 3 {
		t.Errorf("cooking in Ideas = %d, want 3", got)
	}

	// The signal the composer ranks on. cooking is the most-used tag in the
	// library, so if it were present in Journal's slice it would lead the
	// suggestions for a moment being filed there.
	if _, ok := graph.ArchiveTotals[ids.journal][ids.cooking]; ok {
		t.Error("cooking is never filed in Journal; it should be absent from that slice, not zero")
	}
	if _, ok := graph.ArchiveTotals[ids.ideas][ids.games]; ok {
		t.Error("games is never filed in Ideas; it should be absent from that slice, not zero")
	}
	if _, ok := graph.ArchiveTotals[ids.journal][ids.unused]; ok {
		t.Error("a tag on no moment should not appear in any archive slice")
	}
}

func TestTagCoOccurrence_ArchiveTotalsDropDeletedMoments(t *testing.T) {
	setupDB(t)
	ids := facetFixture(t)

	moments, err := ListMoments(nil, nil, 100, nil)
	if err != nil {
		t.Fatalf("list moments: %v", err)
	}
	var target string
	for _, moment := range moments {
		if moment.Title == "g3" {
			target = moment.ID
		}
	}
	if target == "" {
		t.Fatal("fixture drifted: no g3 moment to delete")
	}
	if err := DeleteMoment(target); err != nil {
		t.Fatalf("delete g3: %v", err)
	}

	graph, err := TagCoOccurrence()
	if err != nil {
		t.Fatalf("tag graph: %v", err)
	}
	if got := graph.ArchiveTotals[ids.journal][ids.games]; got != 2 {
		t.Errorf("games in Journal = %d after deleting one of its three moments, want 2", got)
	}
	// g3 was dev's only moment anywhere, so the archive slice has to let it go
	// rather than keep offering it for moments filed in Journal.
	if _, ok := graph.ArchiveTotals[ids.journal][ids.dev]; ok {
		t.Error("g3 was the only dev moment; deleting it should drop dev from Journal's slice")
	}
}

func TestTagCoOccurrence_SkipsUnusedAndDeleted(t *testing.T) {
	setupDB(t)
	ids := facetFixture(t)

	graph, err := TagCoOccurrence()
	if err != nil {
		t.Fatalf("tag graph: %v", err)
	}
	if _, ok := graph.Totals[ids.unused]; ok {
		t.Error("a tag on no moment should not appear in totals")
	}

	// Soft-deleting a moment has to retract its pairing, or the composer keeps
	// suggesting a partnership the library no longer contains.
	moments, err := ListMoments(nil, nil, 100, nil)
	if err != nil {
		t.Fatalf("list moments: %v", err)
	}
	var target string
	for _, moment := range moments {
		if moment.Title == "g3" {
			target = moment.ID
		}
	}
	if target == "" {
		t.Fatal("fixture drifted: no g3 moment to delete")
	}
	if err := DeleteMoment(target); err != nil {
		t.Fatalf("delete g3: %v", err)
	}

	after, err := TagCoOccurrence()
	if err != nil {
		t.Fatalf("tag graph after delete: %v", err)
	}
	if _, ok := after.Pairs[ids.games][ids.dev]; ok {
		t.Error("g3 was the only games/dev moment; deleting it should drop the pair")
	}
	if after.Totals[ids.games] != 2 {
		t.Errorf("games total = %d after deleting one of its three moments, want 2", after.Totals[ids.games])
	}
}

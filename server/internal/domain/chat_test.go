package domain

import "testing"

// Authorless messages keep these tests to the one table under test: author_id
// is a foreign key, so naming an author would mean standing up a user row for
// a query that never looks at one.
var writer = "Someone"

func TestSearchChatMessages(t *testing.T) {
	setupDB(t)
	if _, err := CreateChatMessage(nil, &writer, "Deploying the new build tonight"); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := CreateChatMessage(nil, &writer, "unrelated chatter"); err != nil {
		t.Fatalf("create: %v", err)
	}

	hits, err := SearchChatMessages("deploying", nil, 50)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 1 || hits[0].Content != "Deploying the new build tonight" {
		t.Errorf("expected the one case-insensitive hit, got %+v", hits)
	}

	// Chat is searched for fragments, not whole words: half an identifier or
	// the tail of a URL has to match where it sits.
	hits, err = SearchChatMessages("ploying", nil, 50)
	if err != nil {
		t.Fatalf("mid-word search: %v", err)
	}
	if len(hits) != 1 {
		t.Errorf("expected a mid-word match, got %d", len(hits))
	}
}

func TestSearchChatMessages_WildcardsAreLiteral(t *testing.T) {
	setupDB(t)
	CreateChatMessage(nil, &writer, "coverage is at 100% now")
	CreateChatMessage(nil, &writer, "nothing to do with numbers")

	// Unescaped, "%" is "match everything" and this would return both rows.
	hits, err := SearchChatMessages("100%", nil, 50)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 1 {
		t.Errorf("expected the wildcard to be searched, not parsed, got %d hits", len(hits))
	}

	// Same for the single-character wildcard.
	hits, err = SearchChatMessages("_", nil, 50)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 0 {
		t.Errorf("expected no literal underscore anywhere, got %d hits", len(hits))
	}
}

func TestSearchChatMessages_SkipsDeletedAndBlankQueries(t *testing.T) {
	setupDB(t)
	msg, err := CreateChatMessage(nil, &writer, "a message about kettles")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := DeleteChatMessage(msg.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	hits, err := SearchChatMessages("kettles", nil, 50)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 0 {
		t.Errorf("soft-deleted messages should not appear in search, got %d", len(hits))
	}

	// Nothing searchable is not an error, and must not fall through to a bare
	// "%%" that matches the whole table.
	hits, err = SearchChatMessages("   ", nil, 50)
	if err != nil {
		t.Fatalf("blank search: %v", err)
	}
	if len(hits) != 0 {
		t.Errorf("expected no hits for a blank query, got %d", len(hits))
	}
}

package domain

import (
	"testing"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
)

// Authorless messages keep these tests to the one table under test: author_id
// is a foreign key, so naming an author would mean standing up a user row for
// a query that never looks at one.
var writer = "Someone"

func TestSearchChatMessages(t *testing.T) {
	setupDB(t)
	if _, err := CreateChatMessage(nil, &writer, "Deploying the new build tonight", nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := CreateChatMessage(nil, &writer, "unrelated chatter", nil); err != nil {
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
	CreateChatMessage(nil, &writer, "coverage is at 100% now", nil)
	CreateChatMessage(nil, &writer, "nothing to do with numbers", nil)

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
	msg, err := CreateChatMessage(nil, &writer, "a message about kettles", nil)
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

// A reply used to be a blockquote pasted into the answer, so nothing tied the
// two rows together and the copy went stale when the original was edited. The
// link is a column now, and the page carries a preview of what each reply
// answers so a reply to a message older than the page still draws its line.
func TestChatRepliesCarryAPreviewOfWhatTheyAnswer(t *testing.T) {
	setupDB(t)
	original, err := CreateChatMessage(nil, &writer, "the kettle needs descaling", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := CreateChatMessage(nil, &writer, "on it", &original.ID); err != nil {
		t.Fatalf("create reply: %v", err)
	}

	page, err := ListChatMessages(nil, 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if err := AttachChatReplies(page); err != nil {
		t.Fatalf("attach: %v", err)
	}

	reply := findChat(t, page, "on it")
	if reply.ReplyToID == nil || *reply.ReplyToID != original.ID {
		t.Fatalf("expected the reply to point at the original, got %v", reply.ReplyToID)
	}
	if reply.ReplyTo == nil {
		t.Fatal("expected a preview of the answered message")
	}
	if reply.ReplyTo.Content != "the kettle needs descaling" || reply.ReplyTo.Deleted {
		t.Errorf("expected the original's text, got %+v", reply.ReplyTo)
	}
	// The other way round: an ordinary message is not dressed up as a reply.
	if original := findChat(t, page, "the kettle needs descaling"); original.ReplyToID != nil || original.ReplyTo != nil {
		t.Errorf("expected a plain message to carry no reply, got %+v", original)
	}
}

// Editing the original is the case a quote could not survive: the copy said the
// old thing forever. A reply holds an id, so it reads the message as it stands.
func TestAChatReplyFollowsAnEditOfWhatItAnswers(t *testing.T) {
	setupDB(t)
	original, err := CreateChatMessage(nil, &writer, "thursday, I think", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := CreateChatMessage(nil, &writer, "see you then", &original.ID); err != nil {
		t.Fatalf("create reply: %v", err)
	}
	if _, err := UpdateChatMessage(original.ID, "friday, sorry"); err != nil {
		t.Fatalf("edit: %v", err)
	}

	page, err := ListChatMessages(nil, 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if err := AttachChatReplies(page); err != nil {
		t.Fatalf("attach: %v", err)
	}
	reply := findChat(t, page, "see you then")
	if reply.ReplyTo == nil || reply.ReplyTo.Content != "friday, sorry" {
		t.Errorf("expected the preview to say what the message says now, got %+v", reply.ReplyTo)
	}
}

// Soft-deleted is a tombstone, not a hole: the reply still says it is one, and
// the text deleted for everyone does not travel on inside it.
func TestAChatReplyToADeletedMessageKeepsOnlyTheTombstone(t *testing.T) {
	setupDB(t)
	original, err := CreateChatMessage(nil, &writer, "something regrettable", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := CreateChatMessage(nil, &writer, "quite", &original.ID); err != nil {
		t.Fatalf("create reply: %v", err)
	}
	if err := DeleteChatMessage(original.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	page, err := ListChatMessages(nil, 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if err := AttachChatReplies(page); err != nil {
		t.Fatalf("attach: %v", err)
	}
	reply := findChat(t, page, "quite")
	if reply.ReplyTo == nil || !reply.ReplyTo.Deleted {
		t.Fatalf("expected the preview to say the original is gone, got %+v", reply.ReplyTo)
	}
	if reply.ReplyTo.Content != "" {
		t.Errorf("a deleted message should not travel on in a reply, got %q", reply.ReplyTo.Content)
	}
}

// The prune worker hard-deletes what was soft-deleted long enough ago. The
// foreign key clears the link rather than taking the reply with it: the reply
// is a message in its own right, and afterwards it reads as an ordinary one.
func TestPruningWhatAReplyAnsweredLeavesTheReply(t *testing.T) {
	setupDB(t)
	original, err := CreateChatMessage(nil, &writer, "the message that goes", nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	reply, err := CreateChatMessage(nil, &writer, "the reply that stays", &original.ID)
	if err != nil {
		t.Fatalf("create reply: %v", err)
	}
	if err := DeleteChatMessage(original.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	// Backdate the tombstone past the prune window, which counts in days.
	if _, err := db.DB.Exec(
		`UPDATE chat_messages SET deleted_at = ? WHERE id = ?`,
		time.Now().UTC().Add(-72*time.Hour), original.ID,
	); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	if _, err := PruneDeletedChatMessages(1); err != nil {
		t.Fatalf("prune: %v", err)
	}

	kept, err := GetChatMessage(reply.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if kept == nil {
		t.Fatal("the reply was taken with the message it answered")
	}
	if kept.ReplyToID != nil {
		t.Errorf("expected the link to be cleared with the row, got %v", *kept.ReplyToID)
	}
}

func findChat(t *testing.T, page []models.ChatMessage, content string) models.ChatMessage {
	t.Helper()
	for _, message := range page {
		if message.Content == content {
			return message
		}
	}
	t.Fatalf("no message saying %q in the page", content)
	return models.ChatMessage{}
}

package api_test

import (
	"net/http"
	"testing"
)

// A reply used to be a blockquote in the composer, so the API never knew one
// message answered another. It carries the link now, and hands back a compact
// preview of the answered message with it.

func send(t *testing.T, e *testEnv, content, replyToID string) map[string]any {
	t.Helper()
	status, body := e.do(t, "POST", "/api/v1/chat", map[string]any{
		"content":     content,
		"reply_to_id": replyToID,
	})
	if status != http.StatusCreated {
		t.Fatalf("send %q: %d %v, want 201", content, status, body)
	}
	return body
}

func TestAReplyComesBackWithWhatItAnswers(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	original := send(t, env, "the kettle needs descaling", "")
	reply := send(t, env, "on it", original["id"].(string))

	if reply["reply_to_id"] != original["id"] {
		t.Errorf("reply_to_id %v, want %v", reply["reply_to_id"], original["id"])
	}
	preview, ok := reply["reply_to"].(map[string]any)
	if !ok {
		t.Fatalf("expected a preview of the answered message, got %v", reply["reply_to"])
	}
	if preview["content"] != "the kettle needs descaling" || preview["deleted"] != false {
		t.Errorf("preview %v, want the original's text", preview)
	}

	// And on the way back out, which is the path that matters: the panel draws
	// the line from the page, not from the response to its own send.
	status, page := env.doList(t, "GET", "/api/v1/chat")
	if status != http.StatusOK {
		t.Fatalf("list: %d", status)
	}
	var found bool
	for _, message := range page {
		if message["id"] != reply["id"] {
			continue
		}
		found = true
		if preview, ok := message["reply_to"].(map[string]any); !ok || preview["content"] != "the kettle needs descaling" {
			t.Errorf("listed reply %v, want the preview with it", message)
		}
	}
	if !found {
		t.Error("the reply is missing from the page it was sent to")
	}
}

// The preview is one level deep. A reply to a reply says what it answers and
// stops there, rather than handing the client a chain to walk.
func TestAReplyToAReplyIsStillOneLevel(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	first := send(t, env, "thursday, I think", "")
	second := send(t, env, "works for me", first["id"].(string))
	third := send(t, env, "same", second["id"].(string))

	preview, ok := third["reply_to"].(map[string]any)
	if !ok {
		t.Fatalf("expected a preview, got %v", third["reply_to"])
	}
	if preview["content"] != "works for me" {
		t.Errorf("preview %v, want the message directly answered", preview)
	}
	if _, nested := preview["reply_to"]; nested {
		t.Error("the preview carries a preview of its own, which is a chain the client would have to walk")
	}
}

// Someone deleting the message between the click and the send is a race, not a
// bad request: the reply posts, and reads as a reply to something gone.
func TestReplyingToAMessageDeletedInTheMeantimePosts(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	original := send(t, env, "something regrettable", "")
	if status, body := env.do(t, "DELETE", "/api/v1/chat/"+original["id"].(string), nil); status != http.StatusOK {
		t.Fatalf("delete: %d %v", status, body)
	}

	reply := send(t, env, "quite", original["id"].(string))
	preview, ok := reply["reply_to"].(map[string]any)
	if !ok {
		t.Fatalf("expected a tombstone preview, got %v", reply["reply_to"])
	}
	if preview["deleted"] != true {
		t.Errorf("preview %v, want it marked deleted", preview)
	}
	if preview["content"] != "" {
		t.Errorf("a message deleted for everyone should not travel on in a reply, got %q", preview["content"])
	}
}

// An id that was never here is a client bug, and writing the message down with
// a dangling link would hide it.
func TestReplyingToAMessageThatDoesNotExistIsRefused(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	status, _ := env.do(t, "POST", "/api/v1/chat", map[string]any{
		"content":     "answering the void",
		"reply_to_id": "11111111-2222-3333-4444-555555555555",
	})
	if status != http.StatusBadRequest {
		t.Errorf("replying to a message that does not exist: %d, want 400", status)
	}
}

// Editing a reply must not lose what it answers: the panel swaps its copy for
// the one that comes back, and a response without the line would erase it.
func TestEditingAReplyKeepsWhatItAnswers(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	original := send(t, env, "thursday, I think", "")
	reply := send(t, env, "see you then", original["id"].(string))

	status, edited := env.do(t, "PATCH", "/api/v1/chat/"+reply["id"].(string), map[string]any{
		"content": "see you then, with the kettle",
	})
	if status != http.StatusOK {
		t.Fatalf("edit: %d %v", status, edited)
	}
	if edited["reply_to_id"] != original["id"] {
		t.Errorf("reply_to_id %v, want %v", edited["reply_to_id"], original["id"])
	}
	if preview, ok := edited["reply_to"].(map[string]any); !ok || preview["content"] != "thursday, I think" {
		t.Errorf("edited reply %v, want the preview back with it", edited)
	}
}

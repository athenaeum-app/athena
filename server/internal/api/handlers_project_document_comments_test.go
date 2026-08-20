package api_test

import (
	"net/http"
	"testing"
)

// Comments on a project document ride the module's gates: reading is behind
// RequireAuth so anyone in the library can follow a discussion, writing is
// behind MANAGE_PROJECTS like every other write in the module. An invited
// member holds neither the project permissions nor anything else the library
// grants by default, which makes them the right probe for both halves.
func TestProjectDocumentCommentsFollowTheModuleGates(t *testing.T) {
	env := newTestEnv(t)
	env.registerOwner(t)

	_, project := env.do(t, "POST", "/api/v1/projects", map[string]any{"title": "Netcode"})
	projectID, _ := project["id"].(string)
	if projectID == "" {
		t.Fatalf("no project id in response: %v", project)
	}
	status, document := env.do(t, "POST", "/api/v1/projects/"+projectID+"/documents", map[string]any{
		"kind":  "document",
		"title": "The storage call",
		"body":  "# Why SQLite\n\nOne binary, one file.",
	})
	if status != http.StatusCreated {
		t.Fatalf("create document: %d %v", status, document)
	}
	documentID, _ := document["id"].(string)

	status, comment := env.do(t, "POST", "/api/v1/project-documents/"+documentID+"/comments", map[string]any{
		"body":         "Does this survive a multi-writer setup?",
		"anchor_index": 1,
		"anchor_text":  "one binary, one file.",
	})
	if status != http.StatusCreated {
		t.Fatalf("create comment: %d %v", status, comment)
	}
	commentID, _ := comment["id"].(string)
	if comment["anchor_index"] != float64(1) || comment["anchor_text"] != "one binary, one file." {
		t.Errorf("anchor came back as %v/%v, want the pair that was sent", comment["anchor_index"], comment["anchor_text"])
	}
	if comment["resolved"] != false {
		t.Errorf("a new comment arrived resolved: %v", comment)
	}

	member := env.invite(t, "bob")

	if status, list := member.doList(t, "GET", "/api/v1/project-documents/"+documentID+"/comments"); status != http.StatusOK || len(list) != 1 {
		t.Errorf("member reading comments: %d (%d rows), want 200 and 1 row", status, len(list))
	}
	for _, tc := range []struct {
		what   string
		method string
		path   string
		body   map[string]any
	}{
		{"adding a comment", "POST", "/api/v1/project-documents/" + documentID + "/comments", map[string]any{"body": "mine"}},
		{"resolving a thread", "PATCH", "/api/v1/project-document-comments/" + commentID, map[string]any{"resolved": true}},
		{"deleting a comment", "DELETE", "/api/v1/project-document-comments/" + commentID, nil},
	} {
		if status, body := member.do(t, tc.method, tc.path, tc.body); status != http.StatusForbidden {
			t.Errorf("member %s: %d %v, want 403", tc.what, status, body)
		}
	}

	// The owner resolves it, and the document's open-thread count follows, since
	// that count is what badges the tile in the grid.
	if status, body := env.do(t, "PATCH", "/api/v1/project-document-comments/"+commentID, map[string]any{"resolved": true}); status != http.StatusOK {
		t.Fatalf("resolve: %d %v", status, body)
	}
	status, reread := env.do(t, "GET", "/api/v1/projects/"+projectID, nil)
	if status != http.StatusOK {
		t.Fatalf("reread project: %d", status)
	}
	documents, _ := reread["documents"].([]any)
	if len(documents) != 1 {
		t.Fatalf("project payload carried %d documents, want 1", len(documents))
	}
	if got := documents[0].(map[string]any)["open_comments"]; got != float64(0) {
		t.Errorf("open_comments is %v after resolving the only thread, want 0", got)
	}

	if status, body := env.do(t, "DELETE", "/api/v1/project-document-comments/"+commentID, nil); status != http.StatusOK {
		t.Errorf("delete comment: %d %v", status, body)
	}
	if status, list := env.doList(t, "GET", "/api/v1/project-documents/"+documentID+"/comments"); status != http.StatusOK || len(list) != 0 {
		t.Errorf("comments after the delete: %d (%d rows), want 200 and none", status, len(list))
	}
}

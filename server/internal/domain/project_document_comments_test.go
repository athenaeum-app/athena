package domain

import (
	"errors"
	"testing"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
)

func newComment(t *testing.T, documentID string, parentID *string, index int, anchor, body string) *models.ProjectDocumentComment {
	t.Helper()
	c, err := CreateProjectDocumentComment(documentID, parentID, index, anchor, body, nil)
	if err != nil {
		t.Fatalf("create comment %q: %v", body, err)
	}
	if c == nil {
		t.Fatalf("create comment %q: document not found", body)
	}
	return c
}

// The anchor is stored, never interpreted: the server hands back exactly the
// pair the reader pointed with, because resolving it needs the same block split
// the renderer uses.
func TestCreateProjectDocumentComment_KeepsTheAnchorAsSent(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	doc, err := CreateProjectDocument(p.ID, models.ProjectDocumentKindDocument, "Netcode", "# Why\n\nRollback.", nil, nil, nil)
	if err != nil {
		t.Fatalf("create document: %v", err)
	}

	c := newComment(t, doc.ID, nil, 1, "rollback.", "Does this hold for 8 players?")
	if c.AnchorIndex != 1 || c.AnchorText != "rollback." {
		t.Errorf("anchor came back as %d/%q, want 1/%q", c.AnchorIndex, c.AnchorText, "rollback.")
	}
	if c.Resolved {
		t.Error("a new comment arrived resolved")
	}
	if c.ParentID != nil {
		t.Error("a new comment arrived as a reply")
	}
}

func TestCreateProjectDocumentComment_RejectsEmptyBodyAndFolders(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	doc := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Netcode", nil)
	folder := newDocument(t, p.ID, models.ProjectDocumentKindFolder, "Design", nil)

	if _, err := CreateProjectDocumentComment(doc.ID, nil, 0, "why", "   ", nil); !errors.Is(err, ErrProjectDocumentCommentBody) {
		t.Errorf("empty body gave %v, want ErrProjectDocumentCommentBody", err)
	}
	// A folder has no blocks, so there is nothing to anchor to.
	c, err := CreateProjectDocumentComment(folder.ID, nil, 0, "", "on a folder?", nil)
	if err != nil {
		t.Fatalf("comment on a folder: %v", err)
	}
	if c != nil {
		t.Error("a folder took a comment")
	}
}

// Threads stay one level deep, the cap todo subtasks keep. A reply to a reply
// joins the same thread rather than being refused, and every reply carries its
// thread's anchor so the two can never drift apart.
func TestCreateProjectDocumentComment_FlattensRepliesIntoOneThread(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	doc := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Netcode", nil)

	root := newComment(t, doc.ID, nil, 2, "rollback.", "Does this hold for 8 players?")
	reply := newComment(t, doc.ID, &root.ID, 0, "somewhere else entirely", "Tested at 6.")
	if reply.ParentID == nil || *reply.ParentID != root.ID {
		t.Fatalf("reply hangs off %v, want the root", reply.ParentID)
	}
	if reply.AnchorIndex != root.AnchorIndex || reply.AnchorText != root.AnchorText {
		t.Errorf("reply anchored to %d/%q, want the thread's %d/%q", reply.AnchorIndex, reply.AnchorText, root.AnchorIndex, root.AnchorText)
	}

	deep := newComment(t, doc.ID, &reply.ID, 0, "", "And at 8.")
	if deep.ParentID == nil || *deep.ParentID != root.ID {
		t.Errorf("a reply to a reply hangs off %v, want the thread root", deep.ParentID)
	}

	other := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Physics", nil)
	if _, err := CreateProjectDocumentComment(other.ID, &root.ID, 0, "", "wrong document", nil); !errors.Is(err, ErrProjectDocumentCommentParent) {
		t.Errorf("replying across documents gave %v, want ErrProjectDocumentCommentParent", err)
	}
}

func TestUpdateProjectDocumentComment_ResolvesAndReopensTheThread(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	doc := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Netcode", nil)
	root := newComment(t, doc.ID, nil, 0, "rollback.", "Does this hold for 8 players?")
	reply := newComment(t, doc.ID, &root.ID, 0, "", "Tested at 6.")

	resolved := true
	got, err := UpdateProjectDocumentComment(root.ID, ProjectDocumentCommentPatch{Resolved: &resolved})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !got.Resolved {
		t.Error("thread did not resolve")
	}

	reopen := false
	got, err = UpdateProjectDocumentComment(root.ID, ProjectDocumentCommentPatch{Resolved: &reopen})
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got.Resolved {
		t.Error("thread did not reopen")
	}

	// Resolving is a property of the thread, so a reply cannot carry it.
	if _, err := UpdateProjectDocumentComment(reply.ID, ProjectDocumentCommentPatch{Resolved: &resolved}); !errors.Is(err, ErrProjectDocumentCommentThread) {
		t.Errorf("resolving a reply gave %v, want ErrProjectDocumentCommentThread", err)
	}

	body := "Does this hold for 8?"
	edited, err := UpdateProjectDocumentComment(reply.ID, ProjectDocumentCommentPatch{Body: &body})
	if err != nil {
		t.Fatalf("edit a reply: %v", err)
	}
	if edited.Body != body {
		t.Errorf("edited reply reads %q, want %q", edited.Body, body)
	}
	blank := "  "
	if _, err := UpdateProjectDocumentComment(reply.ID, ProjectDocumentCommentPatch{Body: &blank}); !errors.Is(err, ErrProjectDocumentCommentBody) {
		t.Errorf("blanking a comment gave %v, want ErrProjectDocumentCommentBody", err)
	}
}

func TestDeleteProjectDocumentComment_TakesTheThreadWithIt(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	doc := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Netcode", nil)
	root := newComment(t, doc.ID, nil, 0, "rollback.", "Does this hold for 8 players?")
	newComment(t, doc.ID, &root.ID, 0, "", "Tested at 6.")
	survivor := newComment(t, doc.ID, nil, 1, "lockstep.", "Say why not lockstep.")

	removed, err := DeleteProjectDocumentComment(root.ID)
	if err != nil {
		t.Fatalf("delete thread: %v", err)
	}
	if len(removed) != 2 {
		t.Fatalf("delete returned %d rows, want the root and its reply", len(removed))
	}
	if removed[0].ID != root.ID {
		t.Error("the removed rows do not start with the thread root")
	}
	left, err := ListProjectDocumentComments(doc.ID)
	if err != nil {
		t.Fatalf("list comments: %v", err)
	}
	if len(left) != 1 || left[0].ID != survivor.ID {
		t.Errorf("%d comments left, want only the other thread", len(left))
	}
	if _, err := DeleteProjectDocumentComment(root.ID); err != nil {
		t.Errorf("second delete of a gone comment: %v", err)
	}
}

// A comment has no life of its own: it is a remark about a block of one
// document, so it goes when the document does, including down a folder cascade.
func TestDeleteProjectDocument_CascadesToComments(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	folder := newDocument(t, p.ID, models.ProjectDocumentKindFolder, "Design", nil)
	doc := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Netcode", &folder.ID)
	root := newComment(t, doc.ID, nil, 0, "rollback.", "Does this hold for 8 players?")
	newComment(t, doc.ID, &root.ID, 0, "", "Tested at 6.")

	if _, err := DeleteProjectDocument(folder.ID); err != nil {
		t.Fatalf("delete folder: %v", err)
	}
	var left int
	if err := db.DB.QueryRow(`SELECT COUNT(*) FROM project_document_comments`).Scan(&left); err != nil {
		t.Fatalf("count comments: %v", err)
	}
	if left != 0 {
		t.Errorf("%d comments outlived their document", left)
	}
}

// The tile badge is a count in the project payload, not a request of its own,
// so it has to be right on every read: threads only, unresolved only.
func TestProjectDocument_CountsOpenThreads(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	doc := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Netcode", nil)
	first := newComment(t, doc.ID, nil, 0, "rollback.", "Does this hold for 8 players?")
	newComment(t, doc.ID, &first.ID, 0, "", "Tested at 6.")
	newComment(t, doc.ID, nil, 1, "lockstep.", "Say why not lockstep.")

	openThreads := func(what string) int {
		t.Helper()
		got, err := GetProject(p.ID)
		if err != nil {
			t.Fatalf("get project after %s: %v", what, err)
		}
		if len(got.Documents) != 1 {
			t.Fatalf("project payload carried %d documents after %s, want 1", len(got.Documents), what)
		}
		return got.Documents[0].OpenComments
	}
	if got := openThreads("two threads and a reply"); got != 2 {
		t.Errorf("open comments is %d, want 2: replies are part of the thread that already counts", got)
	}

	resolved := true
	if _, err := UpdateProjectDocumentComment(first.ID, ProjectDocumentCommentPatch{Resolved: &resolved}); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got := openThreads("resolving one"); got != 1 {
		t.Errorf("open comments is %d after resolving one thread, want 1", got)
	}

	// The count is derived, so a PATCH response carries it too and cannot blank
	// the badge the reader is looking at.
	title := "Netcode (revised)"
	updated, err := UpdateProjectDocument(doc.ID, ProjectDocumentPatch{Title: &title})
	if err != nil {
		t.Fatalf("retitle: %v", err)
	}
	if updated.OpenComments != 1 {
		t.Errorf("a patch response carried %d open comments, want 1", updated.OpenComments)
	}
}

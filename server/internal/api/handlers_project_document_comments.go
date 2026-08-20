package api

import (
	"errors"
	"net/http"

	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/domain"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/athenaeum-app/athena/server/internal/sync"
)

// Comments on a project document. Route-level gating matches the rest of the
// module: reading behind RequireAuth, writing behind permissions.ManageProjects
// (see server.go). A locked document still takes comments: locking freezes the
// text, and the remark that a decision needs revisiting is the one thing a
// frozen decision most needs to carry.

func writeProjectDocumentCommentError(w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, domain.ErrProjectDocumentCommentBody),
		errors.Is(err, domain.ErrProjectDocumentCommentParent),
		errors.Is(err, domain.ErrProjectDocumentCommentThread):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, fallback)
	}
}

func (s *Server) handleListProjectDocumentComments(w http.ResponseWriter, r *http.Request) {
	comments, err := domain.ListProjectDocumentComments(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list comments")
		return
	}
	if comments == nil {
		writeError(w, http.StatusNotFound, "document not found")
		return
	}
	writeJSON(w, http.StatusOK, comments)
}

type createProjectDocumentCommentRequest struct {
	// Plain text.
	Body string `json:"body"`
	// Omitted or "" starts a thread; a comment id makes it a reply.
	ParentID *string `json:"parent_id,omitempty"`
	// The block this is about, and enough of its text to find it again after
	// the document has moved around it. Ignored for a reply, which takes its
	// thread's anchor.
	AnchorIndex int    `json:"anchor_index"`
	AnchorText  string `json:"anchor_text"`
}

func (s *Server) handleCreateProjectDocumentComment(w http.ResponseWriter, r *http.Request) {
	documentID := r.PathValue("id")
	var req createProjectDocumentCommentRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	parentID := req.ParentID
	if parentID != nil && *parentID == "" {
		parentID = nil
	}
	user := auth.UserFromContext(r.Context())
	comment, err := domain.CreateProjectDocumentComment(documentID, parentID, req.AnchorIndex, req.AnchorText, req.Body, &user.ID)
	if err != nil {
		writeProjectDocumentCommentError(w, err, "failed to add the comment")
		return
	}
	if comment == nil {
		writeError(w, http.StatusNotFound, "document not found")
		return
	}
	sync.RecordEvent("PROJECT_DOCUMENT_COMMENT_CREATED", "PROJECT_DOCUMENT_COMMENT", comment.ID, &user.ID, comment)
	writeJSON(w, http.StatusCreated, comment)
}

type updateProjectDocumentCommentRequest struct {
	Body *string `json:"body,omitempty"`
	// Thread-level, so it is refused on a reply.
	Resolved *bool `json:"resolved,omitempty"`
}

func (s *Server) handleUpdateProjectDocumentComment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateProjectDocumentCommentRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := auth.UserFromContext(r.Context())
	comment, err := domain.UpdateProjectDocumentComment(id, domain.ProjectDocumentCommentPatch{Body: req.Body, Resolved: req.Resolved})
	if err != nil {
		writeProjectDocumentCommentError(w, err, "failed to update the comment")
		return
	}
	if comment == nil {
		writeError(w, http.StatusNotFound, "comment not found")
		return
	}
	sync.RecordEvent("PROJECT_DOCUMENT_COMMENT_UPDATED", "PROJECT_DOCUMENT_COMMENT", id, &user.ID, comment)
	writeJSON(w, http.StatusOK, comment)
}

// deleteProjectDocumentCommentResponse hands back every row the delete took: a
// thread root goes with its replies, and the client drops them all rather than
// refetching to find out which ones went.
type deleteProjectDocumentCommentResponse struct {
	Comments []models.ProjectDocumentComment `json:"comments"`
}

func (s *Server) handleDeleteProjectDocumentComment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	removed, err := domain.DeleteProjectDocumentComment(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete the comment")
		return
	}
	if removed == nil {
		writeError(w, http.StatusNotFound, "comment not found")
		return
	}
	sync.RecordEvent("PROJECT_DOCUMENT_COMMENT_DELETED", "PROJECT_DOCUMENT_COMMENT", id, &user.ID, nil)
	// Hard delete + audit (ADR-0010): retain what was said before it went.
	sync.RecordAudit(user.ID, "project_document_comment.delete", "PROJECT_DOCUMENT_COMMENT", id, removed)
	writeJSON(w, http.StatusOK, deleteProjectDocumentCommentResponse{Comments: removed})
}

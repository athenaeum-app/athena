package api

import (
	"errors"
	"net/http"

	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/domain"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/athenaeum-app/athena/server/internal/sync"
)

// The Documents tab of the projects module. Route-level gating matches the
// rest of the module: reads behind RequireAuth, writes behind
// permissions.ManageProjects (see server.go).

// writeProjectDocumentError maps the domain's validation errors onto status
// codes. Locked and id-taken are conflicts with the stored state rather than
// malformed requests, so they answer 409.
func writeProjectDocumentError(w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, domain.ErrProjectDocumentLocked), errors.Is(err, domain.ErrProjectDocumentIDTaken):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, domain.ErrProjectDocumentKind),
		errors.Is(err, domain.ErrProjectDocumentStatus),
		errors.Is(err, domain.ErrProjectDocumentParent),
		errors.Is(err, domain.ErrProjectDocumentCycle),
		errors.Is(err, domain.ErrProjectDocumentFolderBody),
		errors.Is(err, domain.ErrProjectDocumentProject):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, fallback)
	}
}

type createProjectDocumentRequest struct {
	// "folder" or "document".
	Kind  string `json:"kind"`
	Title string `json:"title"`
	// Markdown, optional. Ignored for a folder.
	Body string `json:"body,omitempty"`
	// Omitted or "" puts the row at the tab root.
	ParentID *string `json:"parent_id,omitempty"`
	// Omitted appends to the sibling group.
	Position *float64 `json:"position,omitempty"`
}

func (s *Server) handleCreateProjectDocument(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("id")
	var req createProjectDocumentRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	parentID := req.ParentID
	if parentID != nil && *parentID == "" {
		parentID = nil
	}
	user := auth.UserFromContext(r.Context())
	doc, err := domain.CreateProjectDocument(projectID, req.Kind, req.Title, req.Body, parentID, req.Position, &user.ID)
	if err != nil {
		writeProjectDocumentError(w, err, "failed to create document")
		return
	}
	if doc == nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	sync.RecordEvent("PROJECT_DOCUMENT_CREATED", "PROJECT_DOCUMENT", doc.ID, &user.ID, doc)
	writeJSON(w, http.StatusCreated, doc)
}

type updateProjectDocumentRequest struct {
	Title *string `json:"title,omitempty"`
	Body  *string `json:"body,omitempty"`
	// "draft", "final" or "locked".
	Status *string `json:"status,omitempty"`
	// ParentID: folder id to move into, "" for the tab root, omitted to leave
	// where it is.
	ParentID *string  `json:"parent_id,omitempty"`
	Position *float64 `json:"position,omitempty"`
}

func (s *Server) handleUpdateProjectDocument(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateProjectDocumentRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := auth.UserFromContext(r.Context())
	patch := domain.ProjectDocumentPatch{
		Title:    req.Title,
		Body:     req.Body,
		Status:   req.Status,
		Position: req.Position,
		ActorID:  &user.ID,
	}
	if req.ParentID != nil {
		if *req.ParentID == "" {
			patch.ClearParentID = true
		} else {
			patch.ParentID = req.ParentID
		}
	}
	doc, err := domain.UpdateProjectDocument(id, patch)
	if err != nil {
		writeProjectDocumentError(w, err, "failed to update document")
		return
	}
	if doc == nil {
		writeError(w, http.StatusNotFound, "document not found")
		return
	}
	sync.RecordEvent("PROJECT_DOCUMENT_UPDATED", "PROJECT_DOCUMENT", id, &user.ID, doc)
	writeJSON(w, http.StatusOK, doc)
}

// deleteProjectDocumentResponse hands back every row the delete took, folders
// and documents alike, parents first. The client keeps it for its undo stack
// and posts it to the restore endpoint unchanged (ADR-0020).
type deleteProjectDocumentResponse struct {
	Documents []models.ProjectDocument `json:"documents"`
}

func (s *Server) handleDeleteProjectDocument(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	removed, err := domain.DeleteProjectDocument(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete document")
		return
	}
	if removed == nil {
		writeError(w, http.StatusNotFound, "document not found")
		return
	}
	sync.RecordEvent("PROJECT_DOCUMENT_DELETED", "PROJECT_DOCUMENT", id, &user.ID, nil)
	// Hard delete + audit (ADR-0010): retain the pre-delete state.
	sync.RecordAudit(user.ID, "project_document.delete", "PROJECT_DOCUMENT", id, removed)
	writeJSON(w, http.StatusOK, deleteProjectDocumentResponse{Documents: removed})
}

type restoreProjectDocumentsRequest struct {
	// The subtree exactly as the delete response returned it.
	Documents []models.ProjectDocument `json:"documents"`
}

func (s *Server) handleRestoreProjectDocuments(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("id")
	var req restoreProjectDocumentsRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Documents) == 0 {
		writeError(w, http.StatusBadRequest, "documents is required")
		return
	}
	user := auth.UserFromContext(r.Context())
	restored, err := domain.RestoreProjectDocuments(projectID, req.Documents)
	if err != nil {
		writeProjectDocumentError(w, err, "failed to restore documents")
		return
	}
	if restored == nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	for i := range restored {
		sync.RecordEvent("PROJECT_DOCUMENT_CREATED", "PROJECT_DOCUMENT", restored[i].ID, &user.ID, restored[i])
	}
	writeJSON(w, http.StatusCreated, deleteProjectDocumentResponse{Documents: restored})
}

func (s *Server) handleCreateProjectDocumentVersion(w http.ResponseWriter, r *http.Request) {
	documentID := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	v, err := domain.CreateProjectDocumentVersion(documentID, &user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save version")
		return
	}
	if v == nil {
		writeError(w, http.StatusNotFound, "document not found")
		return
	}
	sync.RecordEvent("PROJECT_DOCUMENT_VERSION_CREATED", "PROJECT_DOCUMENT", documentID, &user.ID, v)
	writeJSON(w, http.StatusCreated, v)
}

func (s *Server) handleListProjectDocumentVersions(w http.ResponseWriter, r *http.Request) {
	versions, err := domain.ListProjectDocumentVersions(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list versions")
		return
	}
	if versions == nil {
		writeError(w, http.StatusNotFound, "document not found")
		return
	}
	writeJSON(w, http.StatusOK, versions)
}

func (s *Server) handleGetProjectDocumentVersion(w http.ResponseWriter, r *http.Request) {
	v, err := domain.GetProjectDocumentVersion(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get version")
		return
	}
	if v == nil {
		writeError(w, http.StatusNotFound, "version not found")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleRestoreProjectDocumentVersion(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	doc, err := domain.RestoreProjectDocumentVersion(id, &user.ID)
	if err != nil {
		writeProjectDocumentError(w, err, "failed to restore version")
		return
	}
	if doc == nil {
		writeError(w, http.StatusNotFound, "version not found")
		return
	}
	sync.RecordEvent("PROJECT_DOCUMENT_UPDATED", "PROJECT_DOCUMENT", doc.ID, &user.ID, doc)
	writeJSON(w, http.StatusOK, doc)
}

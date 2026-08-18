package api

import (
	"net/http"
	"time"

	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/domain"
	"github.com/athenaeum-app/athena/server/internal/sync"
)

// Projects module endpoints. Route-level gating: reads behind RequireAuth,
// writes behind permissions.ManageProjects (see server.go), matching todos.

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := domain.ListProjects()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list projects")
		return
	}
	writeJSON(w, http.StatusOK, projects)
}

func (s *Server) handleGetProject(w http.ResponseWriter, r *http.Request) {
	p, err := domain.GetProject(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get project")
		return
	}
	if p == nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

type createProjectRequest struct {
	Title string `json:"title"`
}

func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	var req createProjectRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := auth.UserFromContext(r.Context())
	p, err := domain.CreateProject(req.Title, &user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create project")
		return
	}
	sync.RecordEvent("PROJECT_CREATED", "PROJECT", p.ID, &user.ID, p)
	sync.RecordAudit(user.ID, "project.create", "PROJECT", p.ID, req)
	writeJSON(w, http.StatusCreated, p)
}

type updateProjectRequest struct {
	Title    *string `json:"title,omitempty"`
	Overview *string `json:"overview,omitempty"`
	Accent   *string `json:"accent,omitempty"`
	Icon     *string `json:"icon,omitempty"`
	Position *int    `json:"position,omitempty"`
	Archived *bool   `json:"archived,omitempty"`
}

func (s *Server) handleUpdateProject(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateProjectRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := auth.UserFromContext(r.Context())
	p, err := domain.UpdateProject(id, req.Title, req.Overview, req.Accent, req.Icon, req.Position, req.Archived)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update project")
		return
	}
	if p == nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	sync.RecordEvent("PROJECT_UPDATED", "PROJECT", id, &user.ID, p)
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	// Hard delete + audit (ADR-0010): retain the pre-delete state.
	pre, err := domain.GetProject(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete project")
		return
	}
	if pre == nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	if err := domain.DeleteProject(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete project")
		return
	}
	sync.RecordEvent("PROJECT_DELETED", "PROJECT", id, &user.ID, nil)
	sync.RecordAudit(user.ID, "project.delete", "PROJECT", id, pre)
	writeJSON(w, http.StatusOK, map[string]string{"status": "project deleted"})
}

type createProjectMilestoneRequest struct {
	Title string `json:"title"`
	// RFC3339, optional.
	DueAt *string `json:"due_at,omitempty"`
}

func (s *Server) handleCreateProjectMilestone(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("id")
	var req createProjectMilestoneRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var dueAt *time.Time
	if req.DueAt != nil && *req.DueAt != "" {
		t, perr := time.Parse(time.RFC3339, *req.DueAt)
		if perr != nil {
			writeError(w, http.StatusBadRequest, "invalid due_at (want RFC3339)")
			return
		}
		dueAt = &t
	}
	user := auth.UserFromContext(r.Context())
	m, err := domain.CreateProjectMilestone(projectID, req.Title, dueAt)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create milestone")
		return
	}
	if m == nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	sync.RecordEvent("PROJECT_MILESTONE_CREATED", "PROJECT_MILESTONE", m.ID, &user.ID, m)
	writeJSON(w, http.StatusCreated, m)
}

type updateProjectMilestoneRequest struct {
	Title    *string  `json:"title,omitempty"`
	Track    *int     `json:"track,omitempty"`
	Position *float64 `json:"position,omitempty"`
	// RFC3339 to set, "" to clear, omitted to leave unchanged.
	DueAt *string `json:"due_at,omitempty"`
}

func (s *Server) handleUpdateProjectMilestone(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateProjectMilestoneRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var dueAt *time.Time
	clearDue := false
	if req.DueAt != nil {
		if *req.DueAt == "" {
			clearDue = true
		} else {
			t, perr := time.Parse(time.RFC3339, *req.DueAt)
			if perr != nil {
				writeError(w, http.StatusBadRequest, "invalid due_at (want RFC3339 or empty string)")
				return
			}
			dueAt = &t
		}
	}
	user := auth.UserFromContext(r.Context())
	m, err := domain.UpdateProjectMilestone(id, req.Title, req.Track, req.Position, dueAt, clearDue)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update milestone")
		return
	}
	if m == nil {
		writeError(w, http.StatusNotFound, "milestone not found")
		return
	}
	sync.RecordEvent("PROJECT_MILESTONE_UPDATED", "PROJECT_MILESTONE", id, &user.ID, m)
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) handleDeleteProjectMilestone(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	if err := domain.DeleteProjectMilestone(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete milestone")
		return
	}
	sync.RecordEvent("PROJECT_MILESTONE_DELETED", "PROJECT_MILESTONE", id, &user.ID, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "milestone deleted"})
}

type createProjectCardsRequest struct {
	MilestoneID string `json:"milestone_id"`
	// One card per title, so a pasted list lands in a single request.
	Titles []string `json:"titles"`
}

func (s *Server) handleCreateProjectCards(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("id")
	var req createProjectCardsRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.MilestoneID == "" {
		writeError(w, http.StatusBadRequest, "milestone_id is required")
		return
	}
	user := auth.UserFromContext(r.Context())
	cards, err := domain.CreateProjectCards(projectID, req.MilestoneID, req.Titles, &user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create cards")
		return
	}
	if cards == nil {
		writeError(w, http.StatusNotFound, "project or milestone not found")
		return
	}
	for i := range cards {
		sync.RecordEvent("PROJECT_CARD_CREATED", "PROJECT_CARD", cards[i].ID, &user.ID, cards[i])
	}
	writeJSON(w, http.StatusCreated, cards)
}

type updateProjectCardRequest struct {
	Title       *string  `json:"title,omitempty"`
	Body        *string  `json:"body,omitempty"`
	Labels      *string  `json:"labels,omitempty"`
	Priority    *int     `json:"priority,omitempty"`
	MilestoneID *string  `json:"milestone_id,omitempty"`
	Position    *float64 `json:"position,omitempty"`
	Done        *bool    `json:"done,omitempty"`
	Dismissed   *bool    `json:"dismissed,omitempty"`
	// DueAt: RFC3339 to set, "" to clear, omitted to leave unchanged.
	DueAt *string `json:"due_at,omitempty"`
	// AssigneeID: id to assign, "" to unassign, omitted to leave unchanged.
	AssigneeID *string `json:"assignee_id,omitempty"`
}

func (s *Server) handleUpdateProjectCard(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateProjectCardRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	patch := domain.ProjectCardPatch{
		Title:       req.Title,
		Body:        req.Body,
		Labels:      req.Labels,
		Priority:    req.Priority,
		MilestoneID: req.MilestoneID,
		Position:    req.Position,
		Done:        req.Done,
		Dismissed:   req.Dismissed,
	}
	if req.DueAt != nil {
		if *req.DueAt == "" {
			patch.ClearDueAt = true
		} else {
			t, perr := time.Parse(time.RFC3339, *req.DueAt)
			if perr != nil {
				writeError(w, http.StatusBadRequest, "invalid due_at (want RFC3339 or empty string)")
				return
			}
			patch.DueAt = &t
		}
	}
	if req.AssigneeID != nil {
		if *req.AssigneeID == "" {
			patch.ClearAssigneeID = true
		} else {
			patch.AssigneeID = req.AssigneeID
		}
	}

	user := auth.UserFromContext(r.Context())
	card, err := domain.UpdateProjectCard(id, patch)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update card")
		return
	}
	if card == nil {
		writeError(w, http.StatusNotFound, "card not found")
		return
	}
	sync.RecordEvent("PROJECT_CARD_UPDATED", "PROJECT_CARD", id, &user.ID, card)
	writeJSON(w, http.StatusOK, card)
}

func (s *Server) handleDeleteProjectCard(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	if err := domain.DeleteProjectCard(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete card")
		return
	}
	sync.RecordEvent("PROJECT_CARD_DELETED", "PROJECT_CARD", id, &user.ID, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "card deleted"})
}

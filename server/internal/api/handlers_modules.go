package api

import (
	"net/http"
	"time"

	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/config"
	"github.com/athenaeum-app/athena/server/internal/domain"
	"github.com/athenaeum-app/athena/server/internal/sync"
)

// This file implements the v2.1 module endpoints: moment pins, tag bulk
// recolor, todos, canvas, server stats and backups. Permission gating happens
// at the route level (see server.go); ownership-style checks are noted inline.

// --- Moment pin ---

type pinMomentRequest struct {
	Pinned bool `json:"pinned"`
}

func (s *Server) handlePinMoment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req pinMomentRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	user := auth.UserFromContext(r.Context())
	moment, err := domain.SetMomentPinned(id, req.Pinned)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update pin")
		return
	}
	if moment == nil {
		writeError(w, http.StatusNotFound, "moment not found")
		return
	}

	sync.RecordEvent("MOMENT_PINNED", "MOMENT", id, &user.ID, moment)
	action := "moment.pin"
	if !req.Pinned {
		action = "moment.unpin"
	}
	sync.RecordAudit(user.ID, action, "MOMENT", id, nil)
	writeJSON(w, http.StatusOK, moment)
}

func (s *Server) handleListPinnedMoments(w http.ResponseWriter, r *http.Request) {
	moments, err := domain.ListPinnedMoments()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list pinned moments")
		return
	}
	writeJSON(w, http.StatusOK, moments)
}

// --- Tag bulk recolor ---

type recolorTagsRequest struct {
	Colors map[string]string `json:"colors"`
}

func (s *Server) handleRecolorTags(w http.ResponseWriter, r *http.Request) {
	var req recolorTagsRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	user := auth.UserFromContext(r.Context())
	tags, err := domain.RecolorTags(req.Colors)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to recolor tags")
		return
	}

	// Emit a TAG_UPDATED event per changed tag so every client re-syncs.
	for i := range tags {
		if _, ok := req.Colors[tags[i].ID]; ok {
			sync.RecordEvent("TAG_UPDATED", "TAG", tags[i].ID, &user.ID, tags[i])
		}
	}
	sync.RecordAudit(user.ID, "tags.recolor", "TAG", "", map[string]int{"count": len(req.Colors)})
	writeJSON(w, http.StatusOK, tags)
}

// --- Todos ---

func (s *Server) handleListTodos(w http.ResponseWriter, r *http.Request) {
	lists, err := domain.ListTodoLists()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list todos")
		return
	}
	writeJSON(w, http.StatusOK, lists)
}

type createTodoListRequest struct {
	Kind  string `json:"kind"`
	Title string `json:"title"`
}

func (s *Server) handleCreateTodoList(w http.ResponseWriter, r *http.Request) {
	var req createTodoListRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := auth.UserFromContext(r.Context())
	list, err := domain.CreateTodoList(req.Kind, req.Title, &user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create todo list")
		return
	}
	sync.RecordEvent("TODO_LIST_CREATED", "TODO_LIST", list.ID, &user.ID, list)
	sync.RecordAudit(user.ID, "todo.list.create", "TODO_LIST", list.ID, req)
	writeJSON(w, http.StatusCreated, list)
}

type updateTodoListRequest struct {
	Title    *string `json:"title,omitempty"`
	Notes    *string `json:"notes,omitempty"`
	Position *int    `json:"position,omitempty"`
	// ResetMode: when a daily list's ticks clear, "calendar" or "interval".
	// Anything else normalises to calendar in the domain layer.
	ResetMode *string `json:"reset_mode,omitempty"`
}

func (s *Server) handleUpdateTodoList(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateTodoListRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := auth.UserFromContext(r.Context())
	list, err := domain.UpdateTodoList(id, req.Title, req.Notes, req.Position, req.ResetMode)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update todo list")
		return
	}
	if list == nil {
		writeError(w, http.StatusNotFound, "todo list not found")
		return
	}
	sync.RecordEvent("TODO_LIST_UPDATED", "TODO_LIST", id, &user.ID, list)
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleDeleteTodoList(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	if err := domain.DeleteTodoList(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete todo list")
		return
	}
	sync.RecordEvent("TODO_LIST_DELETED", "TODO_LIST", id, &user.ID, nil)
	sync.RecordAudit(user.ID, "todo.list.delete", "TODO_LIST", id, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "todo list deleted"})
}

func (s *Server) handleResetTodoList(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	list, err := domain.ResetDailyList(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reset todo list")
		return
	}
	if list == nil {
		writeError(w, http.StatusNotFound, "todo list not found")
		return
	}
	sync.RecordEvent("TODO_LIST_UPDATED", "TODO_LIST", id, &user.ID, list)
	sync.RecordAudit(user.ID, "todo.list.reset", "TODO_LIST", id, nil)
	writeJSON(w, http.StatusOK, list)
}

// Deletes the ticked-off items of a list. Separate from the reset above, which
// only unchecks: this is the destructive one, and the client confirms first.
func (s *Server) handleCleanupTodoList(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	list, err := domain.ClearCompletedItems(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to clear completed items")
		return
	}
	if list == nil {
		writeError(w, http.StatusNotFound, "todo list not found")
		return
	}
	sync.RecordEvent("TODO_LIST_UPDATED", "TODO_LIST", id, &user.ID, list)
	sync.RecordAudit(user.ID, "todo.list.cleanup", "TODO_LIST", id, nil)
	writeJSON(w, http.StatusOK, list)
}

type createTodoItemRequest struct {
	Text string `json:"text"`
	// ParentID nests the new item as a subtask.
	ParentID *string `json:"parent_id,omitempty"`
}

func (s *Server) handleCreateTodoItem(w http.ResponseWriter, r *http.Request) {
	listID := r.PathValue("id")
	var req createTodoItemRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := auth.UserFromContext(r.Context())
	item, err := domain.CreateTodoItem(listID, req.Text, req.ParentID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create todo item")
		return
	}
	if item == nil {
		writeError(w, http.StatusNotFound, "todo list not found")
		return
	}
	sync.RecordEvent("TODO_ITEM_CREATED", "TODO_ITEM", item.ID, &user.ID, item)
	writeJSON(w, http.StatusCreated, item)
}

type updateTodoItemRequest struct {
	Text       *string `json:"text,omitempty"`
	Done       *bool   `json:"done,omitempty"`
	Position   *int    `json:"position,omitempty"`
	RolledOver *bool   `json:"rolled_over,omitempty"`
	Priority   *int    `json:"priority,omitempty"`
	Recurrence *string `json:"recurrence,omitempty"`
	// ResetMode: "calendar" or "interval"; anything else normalises to
	// calendar in the domain layer.
	ResetMode *string `json:"reset_mode,omitempty"`
	// DueAt: RFC3339 string to set, "" to clear, omitted to leave unchanged.
	DueAt *string `json:"due_at,omitempty"`
	// MomentID: id to link, "" to unlink, omitted to leave unchanged.
	MomentID *string `json:"moment_id,omitempty"`
}

func (s *Server) handleUpdateTodoItem(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateTodoItemRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	patch := domain.TodoItemPatch{
		Text:       req.Text,
		Done:       req.Done,
		Position:   req.Position,
		RolledOver: req.RolledOver,
		Priority:   req.Priority,
		Recurrence: req.Recurrence,
		ResetMode:  req.ResetMode,
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
	if req.MomentID != nil {
		if *req.MomentID == "" {
			patch.ClearMomentID = true
		} else {
			patch.MomentID = req.MomentID
		}
	}

	user := auth.UserFromContext(r.Context())
	item, err := domain.UpdateTodoItem(id, patch)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update todo item")
		return
	}
	if item == nil {
		writeError(w, http.StatusNotFound, "todo item not found")
		return
	}
	// Completing a recurring item moves its due date to the next occurrence
	// rather than creating anything, so the one updated item is the whole story.
	sync.RecordEvent("TODO_ITEM_UPDATED", "TODO_ITEM", id, &user.ID, item)
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) handleDeleteTodoItem(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	if err := domain.DeleteTodoItem(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete todo item")
		return
	}
	sync.RecordEvent("TODO_ITEM_DELETED", "TODO_ITEM", id, &user.ID, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "todo item deleted"})
}

// --- Canvas ---

func (s *Server) handleListCanvases(w http.ResponseWriter, r *http.Request) {
	canvases, err := domain.ListCanvases()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list canvases")
		return
	}
	writeJSON(w, http.StatusOK, canvases)
}

func (s *Server) handleGetCanvas(w http.ResponseWriter, r *http.Request) {
	c, err := domain.GetCanvas(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get canvas")
		return
	}
	if c == nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return
	}
	writeJSON(w, http.StatusOK, c)
}

type createCanvasRequest struct {
	Title string `json:"title"`
}

func (s *Server) handleCreateCanvas(w http.ResponseWriter, r *http.Request) {
	var req createCanvasRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := auth.UserFromContext(r.Context())
	c, err := domain.CreateCanvas(req.Title, &user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create canvas")
		return
	}
	sync.RecordEvent("CANVAS_CREATED", "CANVAS", c.ID, &user.ID, c)
	sync.RecordAudit(user.ID, "canvas.create", "CANVAS", c.ID, req)
	writeJSON(w, http.StatusCreated, c)
}

type updateCanvasRequest struct {
	Title *string `json:"title,omitempty"`
}

func (s *Server) handleUpdateCanvas(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateCanvasRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := auth.UserFromContext(r.Context())
	c, err := domain.UpdateCanvas(id, req.Title)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update canvas")
		return
	}
	if c == nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return
	}
	sync.RecordEvent("CANVAS_UPDATED", "CANVAS", id, &user.ID, c)
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleDeleteCanvas(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	// Hard delete + audit (ADR-0010): retain the pre-delete state.
	pre, err := domain.DeleteCanvas(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete canvas")
		return
	}
	if pre == nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return
	}
	sync.RecordEvent("CANVAS_DELETED", "CANVAS", id, &user.ID, nil)
	sync.RecordAudit(user.ID, "canvas.delete", "CANVAS", id, pre)
	writeJSON(w, http.StatusOK, map[string]string{"status": "canvas deleted"})
}

type createCanvasNodeRequest struct {
	Kind    string  `json:"kind"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	W       float64 `json:"w"`
	H       float64 `json:"h"`
	Content string  `json:"content"`
	Style   *string `json:"style,omitempty"`
}

func (s *Server) handleCreateCanvasNode(w http.ResponseWriter, r *http.Request) {
	canvasID := r.PathValue("id")
	var req createCanvasNodeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.W == 0 {
		req.W = 200
	}
	if req.H == 0 {
		req.H = 120
	}
	user := auth.UserFromContext(r.Context())
	node, err := domain.CreateCanvasNode(canvasID, req.Kind, req.X, req.Y, req.W, req.H, req.Content, req.Style)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create node")
		return
	}
	if node == nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return
	}
	sync.RecordEvent("CANVAS_NODE_CREATED", "CANVAS_NODE", node.ID, &user.ID, node)
	writeJSON(w, http.StatusCreated, node)
}

type updateCanvasNodeRequest struct {
	X       *float64 `json:"x,omitempty"`
	Y       *float64 `json:"y,omitempty"`
	W       *float64 `json:"w,omitempty"`
	H       *float64 `json:"h,omitempty"`
	ZOrder  *int     `json:"z_order,omitempty"`
	Content *string  `json:"content,omitempty"`
	Style   *string  `json:"style,omitempty"`
}

func (s *Server) handleUpdateCanvasNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateCanvasNodeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := auth.UserFromContext(r.Context())
	node, err := domain.UpdateCanvasNode(id, req.X, req.Y, req.W, req.H, req.ZOrder, req.Content, req.Style)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update node")
		return
	}
	if node == nil {
		writeError(w, http.StatusNotFound, "node not found")
		return
	}
	sync.RecordEvent("CANVAS_NODE_UPDATED", "CANVAS_NODE", id, &user.ID, node)
	writeJSON(w, http.StatusOK, node)
}

func (s *Server) handleDeleteCanvasNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	if err := domain.DeleteCanvasNode(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete node")
		return
	}
	sync.RecordEvent("CANVAS_NODE_DELETED", "CANVAS_NODE", id, &user.ID, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "node deleted"})
}

type createCanvasEdgeRequest struct {
	FromNode string `json:"from_node"`
	ToNode   string `json:"to_node"`
}

func (s *Server) handleCreateCanvasEdge(w http.ResponseWriter, r *http.Request) {
	canvasID := r.PathValue("id")
	var req createCanvasEdgeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user := auth.UserFromContext(r.Context())
	edge, err := domain.CreateCanvasEdge(canvasID, req.FromNode, req.ToNode)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create edge")
		return
	}
	if edge == nil {
		writeError(w, http.StatusBadRequest, "invalid edge endpoints")
		return
	}
	sync.RecordEvent("CANVAS_EDGE_CREATED", "CANVAS_EDGE", edge.ID, &user.ID, edge)
	writeJSON(w, http.StatusCreated, edge)
}

func (s *Server) handleDeleteCanvasEdge(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())
	if err := domain.DeleteCanvasEdge(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete edge")
		return
	}
	sync.RecordEvent("CANVAS_EDGE_DELETED", "CANVAS_EDGE", id, &user.ID, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "edge deleted"})
}

// --- Server stats ---

func (s *Server) handleGetStats(w http.ResponseWriter, r *http.Request) {
	stats, err := domain.GatherStats()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to gather stats")
		return
	}
	version, _ := sync.GetCurrentVersion()

	var lastBackup *sync.BackupInfo
	if backups, err := sync.ListBackups(s.cfg.DBPath); err == nil && len(backups) > 0 {
		lastBackup = &backups[0]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"stats":           stats,
		"library_version": version,
		"uptime_seconds":  int64(time.Since(s.startedAt).Seconds()),
		"backup_count":    backupCount(s.cfg.DBPath),
		"last_backup":     lastBackup,
		"max_upload_mb":   s.cfg.UploadLimitMB(),
	})
}

// handleGetLegacyStats serves the athena-server v1 GET /api/stats response
// shape, unauthenticated like the original endpoint, for external tools
// (e.g. a homeserver dashboard) already integrated against it.
func (s *Server) handleGetLegacyStats(w http.ResponseWriter, r *http.Request) {
	stats, err := domain.GatherLegacyStats()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to gather stats")
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

func backupCount(dbPath string) int {
	b, err := sync.ListBackups(dbPath)
	if err != nil {
		return 0
	}
	return len(b)
}

// --- Backups GUI ---

func (s *Server) handleListBackups(w http.ResponseWriter, r *http.Request) {
	backups, err := sync.ListBackups(s.cfg.DBPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list backups")
		return
	}
	writeJSON(w, http.StatusOK, backups)
}

func (s *Server) handleCreateBackup(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	info, err := sync.CreateBackupNow(s.cfg.DBPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create backup")
		return
	}
	sync.RecordAudit(user.ID, "backup.create", "BACKUP", info.Name, nil)
	writeJSON(w, http.StatusCreated, info)
}

func (s *Server) handleDownloadBackup(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	path, err := sync.BackupFilePath(s.cfg.DBPath, name)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid backup name")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
	http.ServeFile(w, r, path)
}

func (s *Server) handleRestoreBackup(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	user := auth.UserFromContext(r.Context())
	if err := sync.RequestRestore(s.cfg.DBPath, name); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sync.RecordAudit(user.ID, "backup.restore", "BACKUP", name, nil)
	writeJSON(w, http.StatusAccepted, map[string]string{
		"status": "restore staged; restart the server to apply",
	})
}

// --- Backup settings (writable config) ---

type backupSettingsResponse struct {
	Enabled       bool `json:"enabled"`
	IntervalHours int  `json:"interval_hours"`
	Retention     int  `json:"retention"`
}

func (s *Server) currentBackupSettings() backupSettingsResponse {
	return backupSettingsResponse{
		Enabled:       s.cfg.BackupEnabled,
		IntervalHours: s.cfg.BackupIntervalHrs,
		Retention:     s.cfg.BackupRetention,
	}
}

func (s *Server) handleGetBackupSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.currentBackupSettings())
}

func (s *Server) handleUpdateBackupSettings(w http.ResponseWriter, r *http.Request) {
	var req backupSettingsResponse
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.IntervalHours < 1 {
		writeError(w, http.StatusBadRequest, "interval_hours must be >= 1")
		return
	}
	if req.Retention < 1 {
		writeError(w, http.StatusBadRequest, "retention must be >= 1")
		return
	}

	// Persist to the JSON config file.
	if err := config.SaveFileConfig(s.cfg.ConfigPath, &config.FileConfig{
		Backup: config.BackupSettings{
			Enabled:       req.Enabled,
			IntervalHours: req.IntervalHours,
			Retention:     req.Retention,
		},
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save backup settings")
		return
	}

	// Apply live: update the effective config and restart the worker.
	interval := time.Duration(0)
	if req.Enabled {
		interval = time.Duration(req.IntervalHours) * time.Hour
	}
	s.cfg.BackupEnabled = req.Enabled
	s.cfg.BackupInterval = interval
	s.cfg.BackupIntervalHrs = req.IntervalHours
	s.cfg.BackupRetention = req.Retention
	sync.StartBackupWorker(interval, req.Retention, s.cfg.DBPath)

	user := auth.UserFromContext(r.Context())
	sync.RecordAudit(user.ID, "backup.settings.update", "BACKUP", "", req)
	writeJSON(w, http.StatusOK, s.currentBackupSettings())
}

package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/domain"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/athenaeum-app/athena/server/internal/permissions"
	"github.com/athenaeum-app/athena/server/internal/sync"
	"github.com/google/uuid"
)

// --- Invites ---

type createInviteRequest struct {
	Uses      int        `json:"uses"`
	ExpiresAt *time.Time `json:"expires_at"`
}

func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())

	var req createInviteRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Uses <= 0 {
		req.Uses = 1
	}

	invite, err := auth.CreateInvite(user.ID, req.Uses, req.ExpiresAt)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create invite")
		return
	}

	sync.RecordAudit(user.ID, "invite.create", "INVITE", invite.ID, nil)
	writeJSON(w, http.StatusCreated, invite)
}

func (s *Server) handleListInvites(w http.ResponseWriter, r *http.Request) {
	invites, err := auth.ListInvites()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list invites")
		return
	}
	writeJSON(w, http.StatusOK, invites)
}

func (s *Server) handleRevokeInvite(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())

	if err := auth.RevokeInvite(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	sync.RecordAudit(user.ID, "invite.revoke", "INVITE", id, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "invite revoked"})
}

// --- Roles ---

func (s *Server) handleListRoles(w http.ResponseWriter, r *http.Request) {
	roles, err := auth.ListRoles()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list roles")
		return
	}
	writeJSON(w, http.StatusOK, roles)
}

type createRoleRequest struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	Position    int    `json:"position"`
	Permissions uint32 `json:"permissions"`
}

func (s *Server) handleCreateRole(w http.ResponseWriter, r *http.Request) {
	var req createRoleRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	user := auth.UserFromContext(r.Context())
	role, err := auth.CreateRole(req.Name, req.Color, req.Position, permissions.Flag(req.Permissions))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	sync.RecordAudit(user.ID, "role.create", "ROLE", role.ID, req)
	sync.RecordEvent("ROLE_CREATED", "ROLE", role.ID, &user.ID, nil)
	writeJSON(w, http.StatusCreated, role)
}

type updateRoleRequest struct {
	Name        *string `json:"name,omitempty"`
	Color       *string `json:"color,omitempty"`
	Position    *int    `json:"position,omitempty"`
	Permissions *uint32 `json:"permissions,omitempty"`
}

func (s *Server) handleUpdateRole(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateRoleRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var perms *permissions.Flag
	if req.Permissions != nil {
		flag := permissions.Flag(*req.Permissions)
		perms = &flag
	}

	user := auth.UserFromContext(r.Context())
	if err := auth.UpdateRole(id, req.Name, req.Color, req.Position, perms); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	sync.RecordAudit(user.ID, "role.update", "ROLE", id, req)
	sync.RecordEvent("ROLE_UPDATED", "ROLE", id, &user.ID, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "role updated"})
}

func (s *Server) handleDeleteRole(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())

	if err := auth.DeleteRole(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	sync.RecordAudit(user.ID, "role.delete", "ROLE", id, nil)
	sync.RecordEvent("ROLE_DELETED", "ROLE", id, &user.ID, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "role deleted"})
}

// --- Archives ---

func (s *Server) handleListArchives(w http.ResponseWriter, r *http.Request) {
	archives, err := domain.ListArchives()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list archives")
		return
	}
	writeJSON(w, http.StatusOK, archives)
}

type createArchiveRequest struct {
	Name string `json:"name"`
}

func (s *Server) handleCreateArchive(w http.ResponseWriter, r *http.Request) {
	var req createArchiveRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	user := auth.UserFromContext(r.Context())
	archive, err := domain.CreateArchive(req.Name)
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrArchiveNameEmpty):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, domain.ErrArchiveNameTaken):
			writeError(w, http.StatusConflict, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "failed to create archive")
		}
		return
	}

	sync.RecordEvent("ARCHIVE_CREATED", "ARCHIVE", archive.ID, &user.ID, archive)
	sync.RecordAudit(user.ID, "archive.create", "ARCHIVE", archive.ID, req)
	writeJSON(w, http.StatusCreated, archive)
}

func (s *Server) handleUpdateArchive(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req createArchiveRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	user := auth.UserFromContext(r.Context())
	archive, err := domain.UpdateArchive(id, req.Name)
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrArchiveNameEmpty):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, domain.ErrArchiveNameTaken):
			writeError(w, http.StatusConflict, err.Error())
		case errors.Is(err, domain.ErrArchiveNotFound):
			writeError(w, http.StatusNotFound, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "failed to update archive")
		}
		return
	}

	sync.RecordEvent("ARCHIVE_UPDATED", "ARCHIVE", archive.ID, &user.ID, archive)
	sync.RecordAudit(user.ID, "archive.update", "ARCHIVE", archive.ID, req)
	writeJSON(w, http.StatusOK, archive)
}

func (s *Server) handleDeleteArchive(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())

	if err := domain.DeleteArchive(id); err != nil {
		switch {
		case errors.Is(err, domain.ErrLastArchive):
			writeError(w, http.StatusConflict, err.Error())
		case errors.Is(err, domain.ErrArchiveNotFound):
			writeError(w, http.StatusNotFound, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "failed to delete archive")
		}
		return
	}

	sync.RecordEvent("ARCHIVE_DELETED", "ARCHIVE", id, &user.ID, nil)
	sync.RecordAudit(user.ID, "archive.delete", "ARCHIVE", id, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "archive deleted"})
}

// --- Moments ---

func (s *Server) handleListMoments(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 50)
	archiveID := r.URL.Query().Get("archive")
	search := r.URL.Query().Get("q")

	var archiveIDPtr *string
	if archiveID != "" {
		archiveIDPtr = &archiveID
	}

	cursor := parseMomentCursor(r)
	filter := parseMomentFilter(r)

	var moments []models.Moment
	var err error
	if search != "" {
		moments, err = domain.SearchMoments(search, archiveIDPtr, cursor, limit, filter)
	} else {
		moments, err = domain.ListMoments(archiveIDPtr, cursor, limit, filter)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list moments")
		return
	}

	writeJSON(w, http.StatusOK, moments)
}

type createMomentRequest struct {
	ArchiveID string   `json:"archive_id"`
	Title     string   `json:"title"`
	Content   string   `json:"content"`
	TagIDs    []string `json:"tag_ids"`
}

func (s *Server) handleCreateMoment(w http.ResponseWriter, r *http.Request) {
	var req createMomentRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ArchiveID == "" {
		writeError(w, http.StatusBadRequest, "archive_id is required")
		return
	}

	user := auth.UserFromContext(r.Context())
	moment, err := domain.CreateMoment(req.ArchiveID, user.ID, req.Title, req.Content, req.TagIDs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create moment")
		return
	}

	sync.RecordEvent("MOMENT_CREATED", "MOMENT", moment.ID, &user.ID, moment)
	sync.RecordAudit(user.ID, "moment.create", "MOMENT", moment.ID, req)
	writeJSON(w, http.StatusCreated, moment)
}

func (s *Server) handleGetMoment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	moment, err := domain.GetMoment(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "moment not found")
		return
	}
	writeJSON(w, http.StatusOK, moment)
}

type updateMomentRequest struct {
	Title   *string  `json:"title,omitempty"`
	Content *string  `json:"content,omitempty"`
	TagIDs  []string `json:"tag_ids,omitempty"`
}

func (s *Server) handleUpdateMoment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	// Check ownership / permission
	moment, err := domain.GetMoment(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "moment not found")
		return
	}

	perms := auth.PermissionsFromContext(r.Context())
	user := auth.UserFromContext(r.Context())

	canEditAny := permissions.Has(perms, permissions.EditAnyMoment)
	canEditOwn := permissions.Has(perms, permissions.EditOwnMoment) && moment.AuthorID != nil && *moment.AuthorID == user.ID
	if !canEditAny && !canEditOwn {
		writeError(w, http.StatusForbidden, "not allowed to edit this moment")
		return
	}

	// If-Match conflict detection
	if match := r.Header.Get("If-Match"); match != "" {
		if moment.UpdatedAt.Format(time.RFC3339Nano) != match {
			writeError(w, http.StatusConflict, "moment was modified by another user")
			return
		}
	}

	var req updateMomentRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	title := moment.Title
	if req.Title != nil {
		title = *req.Title
	}
	content := moment.Content
	if req.Content != nil {
		content = *req.Content
	}
	tagIDs := moment.TagIDs
	if req.TagIDs != nil {
		tagIDs = req.TagIDs
	}

	updated, err := domain.UpdateMoment(id, title, content, tagIDs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update moment")
		return
	}

	sync.RecordEvent("MOMENT_UPDATED", "MOMENT", id, &user.ID, updated)
	sync.RecordAudit(user.ID, "moment.update", "MOMENT", id, req)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleDeleteMoment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	moment, err := domain.GetMoment(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "moment not found")
		return
	}

	perms := auth.PermissionsFromContext(r.Context())
	user := auth.UserFromContext(r.Context())

	canDeleteAny := permissions.Has(perms, permissions.DeleteAnyMoment)
	canDeleteOwn := permissions.Has(perms, permissions.DeleteOwnMoment) && moment.AuthorID != nil && *moment.AuthorID == user.ID
	if !canDeleteAny && !canDeleteOwn {
		writeError(w, http.StatusForbidden, "not allowed to delete this moment")
		return
	}

	if err := domain.DeleteMoment(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete moment")
		return
	}

	sync.RecordEvent("MOMENT_DELETED", "MOMENT", id, &user.ID, nil)
	sync.RecordAudit(user.ID, "moment.delete", "MOMENT", id, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "moment deleted"})
}

// --- Tags ---

func (s *Server) handleListTags(w http.ResponseWriter, r *http.Request) {
	tags, err := domain.ListTags()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list tags")
		return
	}
	writeJSON(w, http.StatusOK, tags)
}

// handleTagFacets answers "which tags can still be added to this filter
// without emptying the feed". Takes the same archive/search/date/media
// parameters as GET /api/v1/moments, plus `tags` (comma-separated) for the
// selection already applied, so the answer matches the feed the caller is
// looking at.
func (s *Server) handleTagFacets(w http.ResponseWriter, r *http.Request) {
	archiveID := r.URL.Query().Get("archive")
	var archiveIDPtr *string
	if archiveID != "" {
		archiveIDPtr = &archiveID
	}

	var selected []string
	if raw := r.URL.Query().Get("tags"); raw != "" {
		for _, id := range strings.Split(raw, ",") {
			if id = strings.TrimSpace(id); id != "" {
				selected = append(selected, id)
			}
		}
	}

	counts, err := domain.TagFacets(archiveIDPtr, r.URL.Query().Get("q"), selected, parseMomentFilter(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to compute tag facets")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"counts": counts})
}

// handleTagGraph answers "which tags go together", over the whole library. It
// takes no filter parameters on purpose: the composer ranks its suggestions
// from this, and that ranking must not shift with whatever the reader happens
// to be looking at.
func (s *Server) handleTagGraph(w http.ResponseWriter, r *http.Request) {
	graph, err := domain.TagCoOccurrence()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to compute tag graph")
		return
	}
	writeJSON(w, http.StatusOK, graph)
}

type createTagRequest struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (s *Server) handleCreateTag(w http.ResponseWriter, r *http.Request) {
	var req createTagRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.Color == "" {
		req.Color = "#cccccc"
	}

	user := auth.UserFromContext(r.Context())
	tag, err := domain.CreateTag(req.Name, req.Color)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create tag")
		return
	}

	sync.RecordEvent("TAG_CREATED", "TAG", tag.ID, &user.ID, tag)
	sync.RecordAudit(user.ID, "tag.create", "TAG", tag.ID, req)
	writeJSON(w, http.StatusCreated, tag)
}

type updateTagRequest struct {
	Name  *string `json:"name,omitempty"`
	Color *string `json:"color,omitempty"`
}

func (s *Server) handleUpdateTag(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req updateTagRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	user := auth.UserFromContext(r.Context())
	tag, err := domain.UpdateTag(id, req.Name, req.Color)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	sync.RecordEvent("TAG_UPDATED", "TAG", id, &user.ID, tag)
	sync.RecordAudit(user.ID, "tag.update", "TAG", id, req)
	writeJSON(w, http.StatusOK, tag)
}

func (s *Server) handleDeleteTag(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())

	if err := domain.DeleteTag(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	sync.RecordEvent("TAG_DELETED", "TAG", id, &user.ID, nil)
	sync.RecordAudit(user.ID, "tag.delete", "TAG", id, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "tag deleted"})
}

// --- Chat ---

func (s *Server) handleListChat(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 50)
	cursor := parseChatCursor(r)

	// `q` turns the same endpoint into a search over the whole history: the
	// chat panel only holds the pages it has scrolled through, so filtering
	// client-side would only ever find what is already on screen.
	var messages []models.ChatMessage
	var err error
	if query := r.URL.Query().Get("q"); strings.TrimSpace(query) != "" {
		messages, err = domain.SearchChatMessages(query, cursor, limit)
	} else {
		messages, err = domain.ListChatMessages(cursor, limit)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list chat messages")
		return
	}

	writeJSON(w, http.StatusOK, messages)
}

type createChatMessageRequest struct {
	Content string `json:"content"`
}

func (s *Server) handleCreateChatMessage(w http.ResponseWriter, r *http.Request) {
	var req createChatMessageRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}

	user := auth.UserFromContext(r.Context())
	msg, err := domain.CreateChatMessage(&user.ID, nil, req.Content)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create chat message")
		return
	}

	sync.RecordEvent("CHAT_CREATED", "CHAT_MESSAGE", msg.ID, &user.ID, msg)
	sync.RecordAudit(user.ID, "chat.create", "CHAT_MESSAGE", msg.ID, req)
	writeJSON(w, http.StatusCreated, msg)
}

type updateChatMessageRequest struct {
	Content string `json:"content"`
}

func (s *Server) handleUpdateChatMessage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	msg, err := domain.GetChatMessage(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "chat message not found")
		return
	}

	perms := auth.PermissionsFromContext(r.Context())
	user := auth.UserFromContext(r.Context())

	canEditAny := permissions.Has(perms, permissions.DeleteAnyChatMessage)
	canEditOwn := permissions.Has(perms, permissions.EditOwnChatMessage) && msg.AuthorID != nil && *msg.AuthorID == user.ID
	if !canEditAny && !canEditOwn {
		writeError(w, http.StatusForbidden, "not allowed to edit this message")
		return
	}

	var req updateChatMessageRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	updated, err := domain.UpdateChatMessage(id, req.Content)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update chat message")
		return
	}

	sync.RecordEvent("CHAT_UPDATED", "CHAT_MESSAGE", id, &user.ID, updated)
	sync.RecordAudit(user.ID, "chat.update", "CHAT_MESSAGE", id, req)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleDeleteChatMessage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	msg, err := domain.GetChatMessage(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "chat message not found")
		return
	}

	perms := auth.PermissionsFromContext(r.Context())
	user := auth.UserFromContext(r.Context())

	canDeleteAny := permissions.Has(perms, permissions.DeleteAnyChatMessage)
	canDeleteOwn := permissions.Has(perms, permissions.DeleteOwnChatMessage) && msg.AuthorID != nil && *msg.AuthorID == user.ID
	if !canDeleteAny && !canDeleteOwn {
		writeError(w, http.StatusForbidden, "not allowed to delete this message")
		return
	}

	if err := domain.DeleteChatMessage(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete chat message")
		return
	}

	sync.RecordEvent("CHAT_DELETED", "CHAT_MESSAGE", id, &user.ID, nil)
	sync.RecordAudit(user.ID, "chat.delete", "CHAT_MESSAGE", id, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "message deleted"})
}

// --- Helpers ---

func parseLimit(r *http.Request, defaultLimit int) int {
	limitParam := r.URL.Query().Get("limit")
	if limitParam == "" {
		return defaultLimit
	}
	n, err := strconv.Atoi(limitParam)
	if err != nil || n <= 0 || n > 500 {
		return defaultLimit
	}
	return n
}

func parseMomentCursor(r *http.Request) *domain.MomentCursor {
	cursorTimestamp := r.URL.Query().Get("cursor_ts")
	id := r.URL.Query().Get("cursor_id")
	if cursorTimestamp == "" || id == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, cursorTimestamp)
	if err != nil {
		return nil
	}
	return &domain.MomentCursor{Timestamp: t, ID: id}
}

// parseMomentFilter reads the v2.2 feed filters (date range + media/source)
// from the query string. Returns nil when no filter param is present, so the
// unfiltered path stays identical. `from`/`to` are RFC3339; `media` and `link`
// are truthy when "1" or "true". Malformed dates are ignored rather than
// erroring, matching how parseMomentCursor tolerates bad cursors.
func parseMomentFilter(r *http.Request) *domain.MomentFilter {
	queryParams := r.URL.Query()
	filter := &domain.MomentFilter{}
	used := false
	if s := queryParams.Get("from"); s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			filter.From = &t
			used = true
		}
	}
	if s := queryParams.Get("to"); s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			filter.To = &t
			used = true
		}
	}
	if v := queryParams.Get("media"); v == "1" || v == "true" {
		filter.HasMedia = true
		used = true
	}
	if v := queryParams.Get("link"); v == "1" || v == "true" {
		filter.HasLink = true
		used = true
	}
	if !used {
		return nil
	}
	return filter
}

func parseChatCursor(r *http.Request) *domain.ChatCursor {
	cursorTimestamp := r.URL.Query().Get("cursor_ts")
	id := r.URL.Query().Get("cursor_id")
	if cursorTimestamp == "" || id == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, cursorTimestamp)
	if err != nil {
		return nil
	}
	return &domain.ChatCursor{CreatedAt: t, ID: id}
}

// Ensure uuid is used (for future asset ID generation)
var _ = uuid.New

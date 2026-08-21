package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/domain"
	"github.com/athenaeum-app/athena/server/internal/permissions"
	"github.com/athenaeum-app/athena/server/internal/previews"
	"github.com/athenaeum-app/athena/server/internal/sync"
)

// --- Assets ---

func (s *Server) handleUploadAsset(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes)

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "file too large")
		return
	}

	file, handler, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "error retrieving file")
		return
	}
	defer file.Close()

	user := auth.UserFromContext(r.Context())

	saved, err := s.storage.Save(file, handler, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save file")
		return
	}

	asset, err := domain.CreateAsset(user.ID, saved.FileName, saved.MimeType, saved.SizeBytes, saved.StoragePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record asset")
		return
	}

	sync.RecordAudit(user.ID, "asset.upload", "ASSET", asset.ID, nil)
	writeJSON(w, http.StatusCreated, asset)
}

func (s *Server) handleGetAsset(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	asset, err := domain.GetAsset(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "asset not found")
		return
	}

	w.Header().Set("Content-Type", asset.MimeType)
	// ?download=1 forces a download with the original filename. Without it an
	// asset is served inline only if its type is one the client renders in
	// place; anything else is handed over as a file rather than as a document
	// on this origin (issue #89).
	if r.URL.Query().Get("download") == "1" || !inlineSafe(asset.MimeType) {
		w.Header().Set("Content-Disposition", "attachment; filename=\""+sanitizeFilename(asset.FileName)+"\"")
	}
	http.ServeFile(w, r, s.storage.FullPath(asset.StoragePath))
}

// inlineSafe reports whether a stored type may be rendered in place.
//
// The list is what the client actually renders: an image, a player, or the PDF
// preview. Everything else downloads, which costs nothing, because a type the
// client cannot draw was never being rendered in place anyway.
//
// SVG is excluded despite being an image. An SVG is a document: it can carry
// script, and a browser navigating to one runs that script on this origin,
// with the API and the reader's session in reach. It still renders in an <img>
// tag, where a browser ignores the disposition on a subresource and where
// script in an SVG is inert; what it stops is opening the asset URL itself.
//
// PDF stays inline deliberately. Its script runs in the viewer's own sandbox
// rather than on this origin, and taking it out would break the iframe preview
// the client draws for it.
func inlineSafe(mimeType string) bool {
	if mimeType == "image/svg+xml" {
		return false
	}
	if mimeType == "application/pdf" {
		return true
	}
	return strings.HasPrefix(mimeType, "image/") ||
		strings.HasPrefix(mimeType, "audio/") ||
		strings.HasPrefix(mimeType, "video/")
}

// sanitizeFilename strips characters that would break the Content-Disposition
// header (quotes, control chars, path separators), keeping a safe basename.
func sanitizeFilename(name string) string {
	out := make([]rune, 0, len(name))
	for _, r := range name {
		if r < 0x20 || r == '"' || r == '\\' || r == '/' {
			out = append(out, '_')
			continue
		}
		out = append(out, r)
	}
	cleaned := string(out)
	if cleaned == "" {
		return "download"
	}
	return cleaned
}

// handleGetAssetMeta returns an asset's metadata as JSON so the client
// can render a file chip (name, type, size) without downloading the bytes.
func (s *Server) handleGetAssetMeta(w http.ResponseWriter, r *http.Request) {
	asset, err := domain.GetAsset(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "asset not found")
		return
	}
	writeJSON(w, http.StatusOK, asset)
}

func (s *Server) handleDeleteAsset(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user := auth.UserFromContext(r.Context())

	asset, err := domain.GetAsset(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "asset not found")
		return
	}

	perms := auth.PermissionsFromContext(r.Context())
	if !permissions.Has(perms, permissions.DeleteAsset) && asset.UploaderID != user.ID {
		writeError(w, http.StatusForbidden, "not allowed to delete this asset")
		return
	}

	if err := s.storage.Delete(asset.StoragePath); err != nil {
		// Log but don't fail: the DB row is the source of truth
	}

	if err := domain.DeleteAsset(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete asset")
		return
	}

	sync.RecordAudit(user.ID, "asset.delete", "ASSET", id, nil)
	writeJSON(w, http.StatusOK, map[string]string{"status": "asset deleted"})
}

// --- Link Previews ---

func (s *Server) handleGetPreview(w http.ResponseWriter, r *http.Request) {
	url := r.URL.Query().Get("url")
	if url == "" {
		writeError(w, http.StatusBadRequest, "url parameter is required")
		return
	}

	preview, err := domain.GetLinkPreview(url)
	if err == nil && preview != nil {
		writeJSON(w, http.StatusOK, preview)
		return
	}

	// Scrape fresh
	scraped, err := previews.Scrape(url)
	if err != nil {
		writeError(w, http.StatusBadGateway, "failed to fetch preview")
		return
	}

	_ = domain.SaveLinkPreview(scraped)
	writeJSON(w, http.StatusOK, scraped)
}

// --- Sync (Events) ---

func (s *Server) handleGetEvents(w http.ResponseWriter, r *http.Request) {
	sinceStr := r.URL.Query().Get("since")
	if sinceStr == "" {
		writeError(w, http.StatusBadRequest, "since parameter is required")
		return
	}

	since, err := strconv.ParseInt(sinceStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid since parameter")
		return
	}

	limit := parseLimit(r, 100)
	events, err := sync.GetEventsSince(since, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch events")
		return
	}

	currentVersion, _ := sync.GetCurrentVersion()

	writeJSON(w, http.StatusOK, map[string]any{
		"events":          events,
		"current_version": currentVersion,
	})
}

// --- Audit Log ---

func (s *Server) handleGetAuditLog(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 100)

	var cursor *sync.AuditCursor
	idStr := r.URL.Query().Get("cursor_id")
	if idStr != "" {
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err == nil {
			cursor = &sync.AuditCursor{ID: id}
		}
	}

	entries, err := sync.GetAuditLog(cursor, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch audit log")
		return
	}

	writeJSON(w, http.StatusOK, entries)
}

// --- Settings ---

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := domain.GetAllSettings()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch settings")
		return
	}

	// Convert to map for convenience
	settingsByKey := make(map[string]string, len(settings))
	for _, s := range settings {
		settingsByKey[s.Key] = s.Value
	}

	writeJSON(w, http.StatusOK, settingsByKey)
}

type updateSettingsRequest struct {
	Settings map[string]string `json:"settings"`
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var req updateSettingsRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	user := auth.UserFromContext(r.Context())
	for key, value := range req.Settings {
		if err := domain.SetSetting(key, value); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update setting")
			return
		}
	}

	sync.RecordAudit(user.ID, "settings.update", "SETTINGS", "", req)
	writeJSON(w, http.StatusOK, map[string]string{"status": "settings updated"})
}

// sessionExpiryTime is used by the auth handler helpers.
var _ = time.Now

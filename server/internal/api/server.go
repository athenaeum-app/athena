// Package api wires together the HTTP router, handlers, and middleware.
// It serves the REST API at /api/v1/ and the embedded PWA client at /.
package api

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"path"
	"runtime"
	"strings"
	"time"

	web "github.com/athenaeum-app/athena/server/client"
	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/config"
	"github.com/athenaeum-app/athena/server/internal/permissions"
	"github.com/athenaeum-app/athena/server/internal/ratelimit"
	"github.com/athenaeum-app/athena/server/internal/storage"
	"github.com/athenaeum-app/athena/server/internal/sync"
	"github.com/athenaeum-app/athena/server/internal/version"
)

type Server struct {
	cfg       *config.Config
	mux       *http.ServeMux
	storage   *storage.LocalStorage
	startedAt time.Time // for uptime in the stats endpoint

	// Guards for the two endpoints that hash a password before they have any
	// reason to trust the caller. Held per Server rather than in a package
	// variable so a test gets a fresh count with its own server.
	loginByUser *ratelimit.Limiter
	loginByAddr *ratelimit.Limiter
}

const (
	// Guessing at one account. Tight, because the only caller who needs more
	// than this in a quarter of an hour is not a caller who knows the
	// password. Cleared the moment one attempt succeeds.
	loginUserLimit  = 10
	loginUserWindow = 15 * time.Minute

	// Guessing from one address. Deliberately loose: self-hosted Athena
	// usually sits behind a reverse proxy, where RemoteAddr is the proxy and
	// every user of the library shares this bucket. It is a ceiling on how
	// much bcrypt an unauthenticated flood can spend, not the thing that
	// stops a targeted guess.
	loginAddrLimit  = 60
	loginAddrWindow = 5 * time.Minute
)

func NewServer(cfg *config.Config) *Server {
	s := &Server{
		cfg:         cfg,
		mux:         http.NewServeMux(),
		storage:     storage.New(cfg.UploadsPath),
		startedAt:   time.Now(),
		loginByUser: ratelimit.New(loginUserLimit, loginUserWindow),
		loginByAddr: ratelimit.New(loginAddrLimit, loginAddrWindow),
	}
	s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Set before the handler runs so every response carries them, including
	// the ones that write an error and return early.
	//
	// nosniff is the one that matters: it stops a browser from deciding for
	// itself that a file is HTML when we said it was not, which is the other
	// half of the uploaded-document problem (issue #89).
	//
	// SAMEORIGIN rather than DENY, because the client previews a PDF in an
	// iframe pointed at this same server (AttachmentList.tsx) and DENY blocks
	// that too. Framing from anywhere else stays refused.
	//
	// No Content-Security-Policy here on purpose: it needs testing per surface
	// (the Google Fonts stylesheet, blob: thumbnails, data: URIs, inline
	// styles) and a CSP that breaks the app is worse than no CSP.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Referrer-Policy", "no-referrer")

	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	// Health check (no auth)
	s.mux.HandleFunc("GET /api/v1/health", s.handleHealth)

	// Server build identity, for Settings → About. Behind auth rather than on
	// /health: which build a server runs is useful to a member diagnosing a
	// stale client, and not something to volunteer to the open internet.
	s.mux.Handle("GET /api/v1/version", auth.RequireAuth(http.HandlerFunc(s.handleVersion)))

	// Setup status (no auth): tells the client whether the server has any
	// users yet. A server with zero users is in "first setup" mode: the
	// first registration becomes the owner with no invite required.
	s.mux.HandleFunc("GET /api/v1/setup", s.handleSetup)

	// Auth
	s.mux.HandleFunc("POST /api/v1/auth/register", s.handleRegister)
	s.mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	s.mux.Handle("POST /api/v1/auth/logout", auth.RequireAuth(http.HandlerFunc(s.handleLogout)))

	// Invites
	s.mux.Handle("POST /api/v1/invites", auth.RequirePermission(permissions.ManageUsers)(http.HandlerFunc(s.handleCreateInvite)))
	s.mux.Handle("GET /api/v1/invites", auth.RequirePermission(permissions.ManageUsers)(http.HandlerFunc(s.handleListInvites)))
	s.mux.Handle("DELETE /api/v1/invites/{id}", auth.RequirePermission(permissions.ManageUsers)(http.HandlerFunc(s.handleRevokeInvite)))

	// Roles
	s.mux.Handle("GET /api/v1/roles", auth.RequireAuth(http.HandlerFunc(s.handleListRoles)))
	s.mux.Handle("POST /api/v1/roles", auth.RequirePermission(permissions.ManageRoles)(http.HandlerFunc(s.handleCreateRole)))
	s.mux.Handle("PATCH /api/v1/roles/{id}", auth.RequirePermission(permissions.ManageRoles)(http.HandlerFunc(s.handleUpdateRole)))
	s.mux.Handle("DELETE /api/v1/roles/{id}", auth.RequirePermission(permissions.ManageRoles)(http.HandlerFunc(s.handleDeleteRole)))

	// Users
	s.mux.Handle("GET /api/v1/users/me", auth.RequireAuth(http.HandlerFunc(s.handleGetMe)))
	// Self-service account changes (username/password). Any signed-in user may
	// edit their own account; the handler re-checks their current password.
	s.mux.Handle("PATCH /api/v1/users/me", auth.RequireAuth(http.HandlerFunc(s.handleUpdateMe)))
	// Member-visible directory: any authenticated member may resolve author
	// IDs to usernames (lightweight id + username only).
	s.mux.Handle("GET /api/v1/users", auth.RequireAuth(http.HandlerFunc(s.handleUserDirectory)))
	// Admin user-management list (full records), gated by ManageUsers.
	s.mux.Handle("GET /api/v1/users/all", auth.RequirePermission(permissions.ManageUsers)(http.HandlerFunc(s.handleListUsers)))
	s.mux.Handle("PATCH /api/v1/users/{id}/roles", auth.RequirePermission(permissions.ManageUsers)(http.HandlerFunc(s.handleAssignUserRoles)))

	// Archives
	s.mux.Handle("GET /api/v1/archives", auth.RequirePermission(permissions.ViewMoments)(http.HandlerFunc(s.handleListArchives)))
	s.mux.Handle("POST /api/v1/archives", auth.RequirePermission(permissions.ManageArchives)(http.HandlerFunc(s.handleCreateArchive)))
	s.mux.Handle("PATCH /api/v1/archives/{id}", auth.RequirePermission(permissions.ManageArchives)(http.HandlerFunc(s.handleUpdateArchive)))
	s.mux.Handle("DELETE /api/v1/archives/{id}", auth.RequirePermission(permissions.ManageArchives)(http.HandlerFunc(s.handleDeleteArchive)))

	// Moments
	s.mux.Handle("GET /api/v1/moments", auth.RequirePermission(permissions.ViewMoments)(http.HandlerFunc(s.handleListMoments)))
	s.mux.Handle("POST /api/v1/moments", auth.RequirePermission(permissions.CreateMoment)(http.HandlerFunc(s.handleCreateMoment)))
	s.mux.Handle("GET /api/v1/moments/{id}", auth.RequirePermission(permissions.ViewMoments)(http.HandlerFunc(s.handleGetMoment)))
	s.mux.Handle("PATCH /api/v1/moments/{id}", auth.RequireAuth(http.HandlerFunc(s.handleUpdateMoment)))
	s.mux.Handle("DELETE /api/v1/moments/{id}", auth.RequireAuth(http.HandlerFunc(s.handleDeleteMoment)))

	// Moment pins
	s.mux.Handle("GET /api/v1/moments/pinned", auth.RequirePermission(permissions.ViewMoments)(http.HandlerFunc(s.handleListPinnedMoments)))
	s.mux.Handle("PATCH /api/v1/moments/{id}/pin", auth.RequirePermission(permissions.PinMoment)(http.HandlerFunc(s.handlePinMoment)))

	// Tags
	s.mux.Handle("GET /api/v1/tags", auth.RequirePermission(permissions.ViewMoments)(http.HandlerFunc(s.handleListTags)))
	s.mux.Handle("GET /api/v1/tags/facets", auth.RequirePermission(permissions.ViewMoments)(http.HandlerFunc(s.handleTagFacets)))
	s.mux.Handle("GET /api/v1/tags/graph", auth.RequirePermission(permissions.ViewMoments)(http.HandlerFunc(s.handleTagGraph)))
	s.mux.Handle("POST /api/v1/tags", auth.RequirePermission(permissions.ManageTags)(http.HandlerFunc(s.handleCreateTag)))
	s.mux.Handle("POST /api/v1/tags/recolor", auth.RequirePermission(permissions.ManageTags)(http.HandlerFunc(s.handleRecolorTags)))
	s.mux.Handle("PATCH /api/v1/tags/{id}", auth.RequirePermission(permissions.ManageTags)(http.HandlerFunc(s.handleUpdateTag)))
	s.mux.Handle("DELETE /api/v1/tags/{id}", auth.RequirePermission(permissions.ManageTags)(http.HandlerFunc(s.handleDeleteTag)))

	// Todos
	s.mux.Handle("GET /api/v1/todos", auth.RequireAuth(http.HandlerFunc(s.handleListTodos)))
	s.mux.Handle("POST /api/v1/todos", auth.RequirePermission(permissions.ManageTodos)(http.HandlerFunc(s.handleCreateTodoList)))
	s.mux.Handle("PATCH /api/v1/todos/{id}", auth.RequirePermission(permissions.ManageTodos)(http.HandlerFunc(s.handleUpdateTodoList)))
	s.mux.Handle("DELETE /api/v1/todos/{id}", auth.RequirePermission(permissions.ManageTodos)(http.HandlerFunc(s.handleDeleteTodoList)))
	s.mux.Handle("POST /api/v1/todos/{id}/reset", auth.RequirePermission(permissions.ManageTodos)(http.HandlerFunc(s.handleResetTodoList)))
	s.mux.Handle("POST /api/v1/todos/{id}/cleanup", auth.RequirePermission(permissions.ManageTodos)(http.HandlerFunc(s.handleCleanupTodoList)))
	s.mux.Handle("POST /api/v1/todos/{id}/items", auth.RequirePermission(permissions.ManageTodos)(http.HandlerFunc(s.handleCreateTodoItem)))
	s.mux.Handle("PATCH /api/v1/todo-items/{id}", auth.RequirePermission(permissions.ManageTodos)(http.HandlerFunc(s.handleUpdateTodoItem)))
	s.mux.Handle("DELETE /api/v1/todo-items/{id}", auth.RequirePermission(permissions.ManageTodos)(http.HandlerFunc(s.handleDeleteTodoItem)))

	// Projects
	s.mux.Handle("GET /api/v1/projects", auth.RequireAuth(http.HandlerFunc(s.handleListProjects)))
	s.mux.Handle("GET /api/v1/projects/{id}", auth.RequireAuth(http.HandlerFunc(s.handleGetProject)))
	s.mux.Handle("POST /api/v1/projects", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleCreateProject)))
	s.mux.Handle("PATCH /api/v1/projects/{id}", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleUpdateProject)))
	s.mux.Handle("DELETE /api/v1/projects/{id}", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleDeleteProject)))
	s.mux.Handle("POST /api/v1/projects/{id}/milestones", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleCreateProjectMilestone)))
	s.mux.Handle("PATCH /api/v1/project-milestones/{id}", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleUpdateProjectMilestone)))
	s.mux.Handle("DELETE /api/v1/project-milestones/{id}", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleDeleteProjectMilestone)))
	s.mux.Handle("POST /api/v1/projects/{id}/cards", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleCreateProjectCards)))
	s.mux.Handle("PATCH /api/v1/project-cards/{id}", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleUpdateProjectCard)))
	s.mux.Handle("DELETE /api/v1/project-cards/{id}", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleDeleteProjectCard)))

	// Project documents. Documents ride along in the project payload, so there
	// is no list endpoint; versions carry bodies and have their own.
	s.mux.Handle("POST /api/v1/projects/{id}/documents", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleCreateProjectDocument)))
	s.mux.Handle("POST /api/v1/projects/{id}/documents/restore", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleRestoreProjectDocuments)))
	s.mux.Handle("PATCH /api/v1/project-documents/{id}", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleUpdateProjectDocument)))
	s.mux.Handle("DELETE /api/v1/project-documents/{id}", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleDeleteProjectDocument)))
	s.mux.Handle("GET /api/v1/project-documents/{id}/versions", auth.RequireAuth(http.HandlerFunc(s.handleListProjectDocumentVersions)))
	s.mux.Handle("POST /api/v1/project-documents/{id}/versions", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleCreateProjectDocumentVersion)))
	s.mux.Handle("GET /api/v1/project-document-versions/{id}", auth.RequireAuth(http.HandlerFunc(s.handleGetProjectDocumentVersion)))
	s.mux.Handle("POST /api/v1/project-document-versions/{id}/restore", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleRestoreProjectDocumentVersion)))

	// Comments on a document. They are fetched with the open document rather
	// than with the project, so a tab full of tiles pays for the counts only.
	s.mux.Handle("GET /api/v1/project-documents/{id}/comments", auth.RequireAuth(http.HandlerFunc(s.handleListProjectDocumentComments)))
	s.mux.Handle("POST /api/v1/project-documents/{id}/comments", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleCreateProjectDocumentComment)))
	s.mux.Handle("PATCH /api/v1/project-document-comments/{id}", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleUpdateProjectDocumentComment)))
	s.mux.Handle("DELETE /api/v1/project-document-comments/{id}", auth.RequirePermission(permissions.ManageProjects)(http.HandlerFunc(s.handleDeleteProjectDocumentComment)))

	// Canvas
	s.mux.Handle("GET /api/v1/canvases", auth.RequireAuth(http.HandlerFunc(s.handleListCanvases)))
	s.mux.Handle("GET /api/v1/canvases/{id}", auth.RequireAuth(http.HandlerFunc(s.handleGetCanvas)))
	s.mux.Handle("POST /api/v1/canvases", auth.RequirePermission(permissions.ManageCanvas)(http.HandlerFunc(s.handleCreateCanvas)))
	s.mux.Handle("PATCH /api/v1/canvases/{id}", auth.RequirePermission(permissions.ManageCanvas)(http.HandlerFunc(s.handleUpdateCanvas)))
	s.mux.Handle("DELETE /api/v1/canvases/{id}", auth.RequirePermission(permissions.ManageCanvas)(http.HandlerFunc(s.handleDeleteCanvas)))
	s.mux.Handle("POST /api/v1/canvases/{id}/nodes", auth.RequirePermission(permissions.ManageCanvas)(http.HandlerFunc(s.handleCreateCanvasNode)))
	s.mux.Handle("PATCH /api/v1/canvas-nodes/{id}", auth.RequirePermission(permissions.ManageCanvas)(http.HandlerFunc(s.handleUpdateCanvasNode)))
	s.mux.Handle("DELETE /api/v1/canvas-nodes/{id}", auth.RequirePermission(permissions.ManageCanvas)(http.HandlerFunc(s.handleDeleteCanvasNode)))
	s.mux.Handle("POST /api/v1/canvases/{id}/edges", auth.RequirePermission(permissions.ManageCanvas)(http.HandlerFunc(s.handleCreateCanvasEdge)))
	s.mux.Handle("DELETE /api/v1/canvas-edges/{id}", auth.RequirePermission(permissions.ManageCanvas)(http.HandlerFunc(s.handleDeleteCanvasEdge)))

	// Chat
	s.mux.Handle("GET /api/v1/chat", auth.RequirePermission(permissions.ViewChat)(http.HandlerFunc(s.handleListChat)))
	s.mux.Handle("POST /api/v1/chat", auth.RequirePermission(permissions.SendChatMessage)(http.HandlerFunc(s.handleCreateChatMessage)))
	s.mux.Handle("PATCH /api/v1/chat/{id}", auth.RequireAuth(http.HandlerFunc(s.handleUpdateChatMessage)))
	s.mux.Handle("DELETE /api/v1/chat/{id}", auth.RequireAuth(http.HandlerFunc(s.handleDeleteChatMessage)))

	// Assets
	s.mux.Handle("POST /api/v1/assets", auth.RequirePermission(permissions.UploadAsset)(http.HandlerFunc(s.handleUploadAsset)))
	s.mux.Handle("GET /api/v1/assets/{id}/meta", auth.RequirePermission(permissions.ViewMoments)(http.HandlerFunc(s.handleGetAssetMeta)))
	s.mux.Handle("GET /api/v1/assets/{id}", auth.RequirePermission(permissions.ViewMoments)(http.HandlerFunc(s.handleGetAsset)))
	s.mux.Handle("DELETE /api/v1/assets/{id}", auth.RequirePermission(permissions.DeleteAsset)(http.HandlerFunc(s.handleDeleteAsset)))

	// Link previews
	s.mux.Handle("GET /api/v1/previews", auth.RequirePermission(permissions.ViewMoments)(http.HandlerFunc(s.handleGetPreview)))

	// Sync (events)
	s.mux.Handle("GET /api/v1/events", auth.RequireAuth(http.HandlerFunc(s.handleGetEvents)))

	// Audit log
	s.mux.Handle("GET /api/v1/audit-log", auth.RequirePermission(permissions.ViewAuditLog)(http.HandlerFunc(s.handleGetAuditLog)))

	// Settings
	s.mux.Handle("GET /api/v1/settings", auth.RequireAuth(http.HandlerFunc(s.handleGetSettings)))
	s.mux.Handle("PATCH /api/v1/settings", auth.RequirePermission(permissions.ManageServer)(http.HandlerFunc(s.handleUpdateSettings)))

	// Server stats. Any member of the library can read these: they are counts
	// of content everyone with VIEW_MOMENTS can already see, plus database and
	// upload sizes. Nothing here describes the host. It was gated on
	// ManageServer, which meant the Menu's stats widget only ever loaded for
	// the owner and silently failed for everyone they shared the library with.
	s.mux.Handle("GET /api/v1/stats", auth.RequireAuth(http.HandlerFunc(s.handleGetStats)))

	// Legacy stats (no auth, matches athena-server v1 behavior): kept for
	// external tools such as a homeserver dashboard already polling the old
	// /api/stats response shape.
	s.mux.HandleFunc("GET /api/stats", s.handleGetLegacyStats)

	// Backups GUI
	s.mux.Handle("GET /api/v1/backups", auth.RequirePermission(permissions.ManageBackups)(http.HandlerFunc(s.handleListBackups)))
	s.mux.Handle("POST /api/v1/backups", auth.RequirePermission(permissions.ManageBackups)(http.HandlerFunc(s.handleCreateBackup)))
	s.mux.Handle("GET /api/v1/backups/settings", auth.RequirePermission(permissions.ManageBackups)(http.HandlerFunc(s.handleGetBackupSettings)))
	s.mux.Handle("PUT /api/v1/backups/settings", auth.RequirePermission(permissions.ManageBackups)(http.HandlerFunc(s.handleUpdateBackupSettings)))
	s.mux.Handle("GET /api/v1/backups/{name}/download", auth.RequirePermission(permissions.ManageBackups)(http.HandlerFunc(s.handleDownloadBackup)))
	s.mux.Handle("POST /api/v1/backups/{name}/restore", auth.RequirePermission(permissions.ManageBackups)(http.HandlerFunc(s.handleRestoreBackup)))

	// Static PWA client (catch-all, must be last)
	s.mux.Handle("GET /", http.HandlerFunc(s.handleStatic))
}

// handleStatic serves the embedded PWA bundle. For SPA routing, unknown
// paths fall back to index.html.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}

	dist := web.FS()

	cleanPath := path.Clean(r.URL.Path)
	if cleanPath == "/" {
		cleanPath = "/index.html"
	}

	if _, err := fs.Stat(dist, strings.TrimPrefix(cleanPath, "/")); err == nil {
		setCacheHeaders(w, cleanPath)
		http.FileServerFS(dist).ServeHTTP(w, r)
		return
	}

	r.URL.Path = "/"
	setCacheHeaders(w, "/index.html")
	http.FileServerFS(dist).ServeHTTP(w, r)
}

// setCacheHeaders governs how aggressively a client caches the PWA bundle.
// Vite content-hashes everything under /assets/, so a changed file always
// gets a new URL, safe to cache forever. index.html and the service
// worker's own files (sw.js, registerSW.js, manifest.webmanifest, ...) are
// NOT hashed and must always be revalidated, or a client that already has
// them cached (a browser tab, or the desktop shell's long-lived per-server
// session partition) can keep serving a stale build indefinitely. With no
// Cache-Control at all, that was exactly what let the Electron client show
// an outdated PWA until its session partition was thrown away by deleting
// and re-adding the server.
func setCacheHeaders(w http.ResponseWriter, cleanPath string) {
	if strings.HasPrefix(cleanPath, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	libraryVersion, _ := sync.GetCurrentVersion()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":          "ok",
		"library_version": libraryVersion,
	})
}

// handleVersion reports which build of the server is running. The client and
// the server ship as one artifact but do not have to be running as one. The
// desktop shell caches the PWA, so a client can outlive the server build it
// came from. Showing both in About is what makes that visible.
func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version":    version.Version,
		"go_version": runtime.Version(),
		"os":         runtime.GOOS,
		"arch":       runtime.GOARCH,
		"started_at": s.startedAt.UTC(),
	})
}

// handleSetup reports whether the server has any registered users. When
// needs_setup is true, the client should route to a first-setup flow that
// creates the owner account (no invite required). After the first user is
// registered, needs_setup becomes false for the life of the server.
func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	count, err := auth.UserCount()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check setup status")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"needs_setup": count == 0,
		"user_count":  count,
	})
}

// --- JSON helpers ---

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("api: writeJSON error: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

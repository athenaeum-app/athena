// Package models defines the entity types used across the server.
// These are pure data structs: no logic, no DB concerns.
package models

import "time"

// User is a person with an account on this server.
type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"` // never serialized
	Email        *string   `json:"email,omitempty"`
	IsOwner      bool      `json:"is_owner"`
	CreatedAt    time.Time `json:"created_at"`
}

// AdminUser is a User together with the roles assigned to them. The admin
// panel needs both in one place: to show who holds what without a request per
// row, and to open the role editor on the assignment that is actually stored
// rather than on an empty one.
type AdminUser struct {
	User
	Roles []Role `json:"roles"`
}

// PublicUser is the minimal, non-sensitive projection of a User used by the
// member-visible directory (GET /api/v1/users). It resolves author IDs to
// usernames for chat, the audit log, and canvases without ever exposing
// password hashes, emails, or session data. The users table has no
// display_name column, so only id and username are surfaced.
type PublicUser struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Online   bool   `json:"online"`
}

// Role is a named bundle of permission flags.
type Role struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Color       string    `json:"color"`
	Position    int       `json:"position"`
	IsPreset    bool      `json:"is_preset"`
	IsDefault   bool      `json:"is_default"`  // the "Member" role
	Permissions uint32    `json:"permissions"` // bitmask of permissions.Flag
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// Invite is a token that allows new users to register.
type Invite struct {
	ID            string     `json:"id"`
	CreatedBy     string     `json:"created_by"`
	UsesRemaining int        `json:"uses_remaining"`
	ExpiresAt     *time.Time `json:"expires_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
}

// Session is a server-side record of an authenticated user's login.
type Session struct {
	ID        string     `json:"-"`
	UserID    string     `json:"user_id"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"` // nil = no expiry
	IP        string     `json:"ip"`
	UserAgent string     `json:"user_agent"`
	CreatedAt time.Time  `json:"created_at"`
}

// Archive is a named container for moments.
type Archive struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Moment is a single journal entry.
type Moment struct {
	ID        string     `json:"id"`
	ArchiveID string     `json:"archive_id"`
	AuthorID  *string    `json:"author_id,omitempty"` // nil = legacy/migrated
	Title     string     `json:"title"`
	Content   string     `json:"content"`
	Timestamp time.Time  `json:"timestamp"`
	IsLegacy  bool       `json:"is_legacy"`
	Pinned    bool       `json:"pinned"`               // library-shared pin
	DeletedAt *time.Time `json:"deleted_at,omitempty"` // non-nil = soft-deleted
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	TagIDs    []string   `json:"tag_ids,omitempty"`
}

// Tag is a user-created label applicable to any moment.
type Tag struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Color     string    `json:"color"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ChatMessage is a message in the library-wide chat.
type ChatMessage struct {
	ID          string     `json:"id"`
	AuthorID    *string    `json:"author_id,omitempty"`    // nil = legacy
	DisplayName *string    `json:"display_name,omitempty"` // used when AuthorID is nil
	Content     string     `json:"content"`
	IsLegacy    bool       `json:"is_legacy"`
	DeletedAt   *time.Time `json:"deleted_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// Asset is a file uploaded to the server and referenced in moment content.
type Asset struct {
	ID          string    `json:"id"`
	UploaderID  string    `json:"uploader_id"`
	FileName    string    `json:"file_name"`
	MimeType    string    `json:"mime_type"`
	SizeBytes   int64     `json:"size_bytes"`
	StoragePath string    `json:"-"` // internal path, not exposed
	CreatedAt   time.Time `json:"created_at"`
}

// LinkPreview is cached metadata for a URL referenced in moment content.
type LinkPreview struct {
	URL         string    `json:"url"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	ImageURL    string    `json:"image_url"`
	ScrapedAt   time.Time `json:"scraped_at"`
}

// Event records a single mutation for delta sync. Clients consume events
// to stay current without re-fetching the full library.
type Event struct {
	ID             int64     `json:"id"`
	LibraryVersion int64     `json:"library_version"`
	Type           string    `json:"type"` // MOMENT_CREATED, MOMENT_UPDATED, etc.
	TargetType     string    `json:"target_type"`
	TargetID       string    `json:"target_id"`
	AuthorID       *string   `json:"author_id,omitempty"`
	Payload        string    `json:"payload,omitempty"` // JSON
	CreatedAt      time.Time `json:"created_at"`
}

// AuditEntry is a durable record of who did what, for accountability.
type AuditEntry struct {
	ID         int64     `json:"id"`
	ActorID    string    `json:"actor_id"`
	Action     string    `json:"action"` // moment.create, user.invite, etc.
	TargetType string    `json:"target_type,omitempty"`
	TargetID   string    `json:"target_id,omitempty"`
	Details    string    `json:"details,omitempty"` // JSON
	CreatedAt  time.Time `json:"created_at"`
}

// Setting is a key-value pair for server-managed configuration.
type Setting struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// --- v2.1 embeddable modules (ADR-0013): server-synced, library-shared,
// last-write-wins. Todos and canvases render inline when embedded in shared
// moments, so they must live server-side rather than in client-local storage.

// TodoKind distinguishes the two flavours of todo list.
const (
	// TodoKindDaily is a list whose ticks clear on their own each cycle.
	TodoKindDaily = "daily"
	// TodoKindGeneral is a Trello-like named task list with a progress bar.
	TodoKindGeneral = "general"
)

// TodoList is a named collection of TodoItems. Kind is "daily" or "general".
type TodoList struct {
	ID          string     `json:"id"`
	Kind        string     `json:"kind"`
	Title       string     `json:"title"`
	Notes       string     `json:"notes"` // freeform text area (general lists)
	AuthorID    *string    `json:"author_id,omitempty"`
	Position    int        `json:"position"`
	LastResetAt *time.Time `json:"last_reset_at,omitempty"` // daily lists
	// When a daily list's ticks clear: 'calendar' at the start of each local
	// day, 'interval' 24 hours after each item was ticked. Ignored on general
	// lists, which never clear themselves.
	ResetMode string     `json:"reset_mode"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	Items     []TodoItem `json:"items"`
}

// TodoItem is a single checkable entry within a TodoList.
type TodoItem struct {
	ID          string     `json:"id"`
	ListID      string     `json:"list_id"`
	Text        string     `json:"text"`
	Done        bool       `json:"done"`
	Position    int        `json:"position"`
	RolledOver  bool       `json:"rolled_over"` // carried from a previous day
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	// Task fields.
	DueAt      *time.Time `json:"due_at,omitempty"`    // optional deadline
	Priority   int        `json:"priority"`            // 0 none, 1 low, 2 med, 3 high
	MomentID   *string    `json:"moment_id,omitempty"` // optional linked moment
	Recurrence string     `json:"recurrence"`          // '' | daily | weekly | monthly
	// When a repeating task comes back: 'calendar' at the start of the next
	// period, 'interval' one whole period after it was completed. Ignored
	// when Recurrence is empty.
	ResetMode string    `json:"reset_mode"`
	ParentID  *string   `json:"parent_id,omitempty"` // subtask parent, one level
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Canvas is an infinite pan/zoom surface holding positioned nodes.
type Canvas struct {
	ID        string       `json:"id"`
	Title     string       `json:"title"`
	AuthorID  *string      `json:"author_id,omitempty"`
	CreatedAt time.Time    `json:"created_at"`
	UpdatedAt time.Time    `json:"updated_at"`
	Nodes     []CanvasNode `json:"nodes"`
	Edges     []CanvasEdge `json:"edges"`
}

// CanvasNode kinds. Content semantics vary by kind (see CanvasNode.Content).
// Unknown kinds are tolerated by the domain layer and treated as text.
const (
	CanvasNodeMomentRef  = "moment-ref"  // references a moment by UUID (stays in sync)
	CanvasNodeText       = "text"        // raw text content
	CanvasNodeImage      = "image"       // image asset URL in content
	CanvasNodeSticky     = "sticky"      // colored text card
	CanvasNodeShape      = "shape"       // plain box / shape
	CanvasNodeLink       = "link"        // a URL in content, rendered as a chip
	CanvasNodeTodoRef    = "todo-ref"    // references a todo list by id (live summary)
	CanvasNodeProjectRef = "project-ref" // references a project by id (live summary)
	CanvasNodeCanvasRef  = "canvas-ref"  // references another canvas by id
)

// CanvasNode is a single positioned element on a Canvas.
type CanvasNode struct {
	ID       string  `json:"id"`
	CanvasID string  `json:"canvas_id"`
	Kind     string  `json:"kind"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	W        float64 `json:"w"`
	H        float64 `json:"h"`
	ZOrder   int     `json:"z_order"`
	// Content holds raw text (text/sticky nodes), the asset URL (image nodes),
	// a URL (link nodes), or the referenced entity's id (the *-ref nodes). Text
	// node content runs through the moment pipeline, so it can carry embed
	// tokens of its own.
	Content string `json:"content"`
	// Style is an optional JSON blob for presentation only, e.g.
	// {"color":"#8899aa","fontSize":14}. nil when the node has no styling.
	Style     *string   `json:"style,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// CanvasEdge is a directed connector between two nodes on a Canvas. Edges
// cascade-delete with their canvas and with either endpoint node.
type CanvasEdge struct {
	ID        string    `json:"id"`
	CanvasID  string    `json:"canvas_id"`
	FromNode  string    `json:"from_node"`
	ToNode    string    `json:"to_node"`
	CreatedAt time.Time `json:"created_at"`
}

// Project is a long-horizon roadmap of milestones holding cards.
// Library-shared, last-write-wins, like the todo and canvas modules. The
// description is markdown rendered with the moment pipeline, so it can embed
// todo lists, canvases and moment references.
type Project struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Overview string `json:"overview"`
	// Per-project identity: a hex color and a material symbol name.
	Accent     string             `json:"accent"`
	Icon       string             `json:"icon"`
	AuthorID   *string            `json:"author_id,omitempty"`
	Position   int                `json:"position"`
	Archived   bool               `json:"archived"`
	CreatedAt  time.Time          `json:"created_at"`
	UpdatedAt  time.Time          `json:"updated_at"`
	Milestones []ProjectMilestone `json:"milestones"`
	Cards      []ProjectCard      `json:"cards"`
	// The whole Documents tree, folders and documents alike, flat. The client
	// assembles the tree from parent_id. Version snapshots are not nested
	// here: bodies add up, and they have their own endpoints.
	Documents []ProjectDocument `json:"documents"`
}

// ProjectMilestone is one board column and one roadmap node, optionally dated.
// Milestones sharing a Track stack vertically and split that column's height;
// Position orders the roadmap globally.
type ProjectMilestone struct {
	ID        string     `json:"id"`
	ProjectID string     `json:"project_id"`
	Title     string     `json:"title"`
	DueAt     *time.Time `json:"due_at,omitempty"`
	Track     int        `json:"track"`
	Position  float64    `json:"position"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// ProjectCard is one unit of work under a milestone, from a one-liner to a
// markdown document. Dismissed cards are the reversible graveyard; hard
// deletion only empties that. CompletedAt is stamped on the done edge, which
// is what per-day momentum is computed from.
type ProjectCard struct {
	ID          string `json:"id"`
	ProjectID   string `json:"project_id"`
	MilestoneID string `json:"milestone_id"`
	Title       string `json:"title"`
	Body        string `json:"body"`
	// Comma-joined free-form label names, colored client-side.
	Labels string `json:"labels"`
	// 0 none · 1 low · 2 med · 3 high, the Tasks module's vocabulary.
	Priority    int        `json:"priority"`
	DueAt       *time.Time `json:"due_at,omitempty"`
	AssigneeID  *string    `json:"assignee_id,omitempty"`
	Done        bool       `json:"done"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	Dismissed   bool       `json:"dismissed"`
	Position    float64    `json:"position"`
	AuthorID    *string    `json:"author_id,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// The two kinds of row in a project's Documents tree: a folder is a container,
// a document is the reference content itself.
const (
	ProjectDocumentKindFolder   = "folder"
	ProjectDocumentKindDocument = "document"
)

// Document statuses. Locked refuses title and body edits until it is unlocked.
const (
	ProjectDocumentStatusDraft  = "draft"
	ProjectDocumentStatusFinal  = "final"
	ProjectDocumentStatusLocked = "locked"
)

// ProjectDocument is one node of a project's Documents tree: durable reference
// content, or a folder holding more of it. Composed and rendered through the
// moment pipeline but owned by the project, not by an archive, so it is never
// done, carries no priority and cannot be dismissed (ADR-0020). It dies only
// by a deliberate delete, which takes everything beneath it.
type ProjectDocument struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	// nil puts the row at the Documents tab's root.
	ParentID *string `json:"parent_id,omitempty"`
	Kind     string  `json:"kind"`
	Title    string  `json:"title"`
	// Markdown with embeds, same pipeline as a card body. Empty for folders.
	Body     string  `json:"body"`
	Status   string  `json:"status"`
	Position float64 `json:"position"`
	// Unresolved threads on this document, counted on every read so a tile can
	// badge it without a request of its own. Derived, never stored: a restore
	// payload carrying a stale number is ignored on the way back in.
	OpenComments int       `json:"open_comments"`
	AuthorID     *string   `json:"author_id,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// ProjectDocumentVersion is a snapshot of a document's title and body, taken
// manually or automatically before a meaningful edit. Restoring one snapshots
// the current state first, so a restore is itself undoable.
//
// Body is omitted when empty because the list endpoint deliberately leaves it
// out: a version list is identity only, and shipping every historical body
// with it would dwarf the document.
type ProjectDocumentVersion struct {
	ID         string    `json:"id"`
	DocumentID string    `json:"document_id"`
	Title      string    `json:"title"`
	Body       string    `json:"body,omitempty"`
	AuthorID   *string   `json:"author_id,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// ProjectDocumentComment is one remark hung off a block of a document, or a
// reply to one. It anchors to a block rather than to a character range: the
// whole body is rewritten on every save, so an offset pair would be stale the
// moment a word was added above it.
//
// AnchorIndex and AnchorText are that anchor. The reader resolves the text
// first and the index second, which is what lets a comment survive edits made
// elsewhere in the document; when neither matches, the comment is shown as
// orphaned rather than being moved onto whatever now sits at that index.
//
// Threads are one level deep. A reply carries a copy of its parent's anchor so
// every row knows its block without a join, and Resolved is a property of the
// thread, held on its first comment.
type ProjectDocumentComment struct {
	ID         string `json:"id"`
	DocumentID string `json:"document_id"`
	// nil starts a thread; set means a reply, always to a thread root.
	ParentID    *string `json:"parent_id,omitempty"`
	AnchorIndex int     `json:"anchor_index"`
	AnchorText  string  `json:"anchor_text"`
	// Plain text. Comments deliberately do not run the embed pipeline: a
	// remark about a document is not another document.
	Body      string    `json:"body"`
	Resolved  bool      `json:"resolved"`
	AuthorID  *string   `json:"author_id,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

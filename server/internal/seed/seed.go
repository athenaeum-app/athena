// Package seed builds a rich, deterministic demo library by driving the real
// domain layer, so every mutation produces authentic sync events and audit
// entries (the same ones the HTTP API would emit). It also generates tiny,
// fully valid media files so the client's every attachment-preview path has a
// real asset to render. Invoked by the `athena-server seed` subcommand and the
// `npm run demo` script.
package seed

import (
	"fmt"
	"image/color"
	"os"
	"path/filepath"
	"time"

	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/config"
	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/domain"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/athenaeum-app/athena/server/internal/permissions"
	"github.com/athenaeum-app/athena/server/internal/sync"
)

// demoMemberPerms is the bundle the retired Member preset used to carry:
// read the library, post moments and chat, edit and delete your own. It lives
// here rather than in the permissions package because it is no longer a
// preset. It is one example of a custom role, which is what the demo uses it
// as (see seedUsersAndRoles).
const demoMemberPerms = permissions.ViewMoments | permissions.ViewChat |
	permissions.SendChatMessage | permissions.CreateMoment |
	permissions.EditOwnMoment | permissions.DeleteOwnMoment |
	permissions.UploadAsset

// seedErr wraps an error thrown from deep within the seeding call tree so the
// top-level Run can recover it and return it as an ordinary error. Seeding is a
// linear, all-or-nothing script; panicking on the first failure keeps the body
// readable without an `if err != nil` after every one of ~150 mutations.
type seedErr struct{ err error }

// must panics with a seedErr when err is non-nil.
func (s *seeder) must(err error) {
	if err != nil {
		panic(seedErr{err})
	}
}

// must1 unwraps a (value, error) pair, panicking on error. Used to keep the
// seeding body linear.
func must1[T any](v T, err error) T {
	if err != nil {
		panic(seedErr{err})
	}
	return v
}

// persona is a demo login whose credentials are printed at the end.
type persona struct {
	user     *models.User
	password string
	email    string
	role     string
}

type seeder struct {
	cfg     *config.Config
	uploads string
	now     time.Time

	personas []persona

	general    *models.Archive
	fieldNotes *models.Archive
	projectLog *models.Archive

	tags map[string]*models.Tag

	assets map[string]*models.Asset

	todoDaily      *models.TodoList
	todoGeneral    *models.TodoList
	todoMomentItem *models.TodoItem

	canvas *models.Canvas

	welcome *models.Moment

	momentCount int
	chatCount   int
}

// Run wipes nothing (the caller handles --reset) and populates the already-open
// database with the full demo dataset. It assumes db.Open has run and
// domain.Config / auth config have been wired by the caller.
func Run(cfg *config.Config) (err error) {
	s := &seeder{
		cfg:     cfg,
		uploads: cfg.UploadsPath,
		now:     time.Now().UTC(),
		tags:    map[string]*models.Tag{},
		assets:  map[string]*models.Asset{},
	}
	defer func() {
		if r := recover(); r != nil {
			if se, ok := r.(seedErr); ok {
				err = se.err
				return
			}
			panic(r)
		}
	}()

	if err := os.MkdirAll(s.uploads, 0o755); err != nil {
		return fmt.Errorf("create uploads dir: %w", err)
	}

	s.seedUsersAndRoles()
	s.seedInvites()
	s.seedArchivesAndTags()
	s.seedAssets()
	s.seedTodos()
	s.seedCanvasShell()
	s.seedMoments()
	s.seedCanvasContent()
	s.linkTodoToMoment()
	s.seedChat()
	s.seedLinkPreviews()
	s.seedSettings()

	s.printSummary()
	return nil
}

// --- helpers -----------------------------------------------------------------

func (s *seeder) exec(q string, args ...any) {
	if _, err := db.DB.Exec(q, args...); err != nil {
		panic(seedErr{fmt.Errorf("exec %q: %w", q, err)})
	}
}

func (s *seeder) daysAgo(n int) time.Time   { return s.now.AddDate(0, 0, -n) }
func (s *seeder) daysAhead(n int) time.Time { return s.now.AddDate(0, 0, n) }

func strptr(v string) *string { return &v }

// --- users & roles -----------------------------------------------------------

func (s *seeder) seedUsersAndRoles() {
	// First registered user becomes the Owner (ADR-0005): no invite needed.
	owner := must1(auth.Register("athena", "demo-owner-2026", nil))
	sync.RecordAudit(owner.ID, "user.register", "USER", owner.ID, nil)

	// The preset roles ship with permission bitmask 0 (migration 0002); apply
	// their documented bundles through the real role API so the demo personas
	// actually behave per their role in the client.
	adminP := permissions.AdminPerms
	editorP := permissions.EditorPerms
	viewerP := permissions.ViewerPerms
	s.must(auth.UpdateRole("role_admin", nil, nil, nil, &adminP))
	s.must(auth.UpdateRole("role_editor", nil, nil, nil, &editorP))
	s.must(auth.UpdateRole("role_viewer", nil, nil, nil, &viewerP))
	sync.RecordAudit(owner.ID, "role.update", "ROLE", "role_admin", map[string]uint32{"permissions": uint32(adminP)})

	// Viewer is the default and grants no writing at all (migration 0008), so
	// "someone who can post but not administer" is now something you build.
	// The demo builds it, which also gives the seeded library a custom role to
	// look at next to the presets.
	memberRole := must1(auth.CreateRole("Member", "#95a5a6", 1, demoMemberPerms))

	// A multi-use, non-expiring invite lets us register the other personas the
	// same way real users would join.
	reg := must1(auth.CreateInvite(owner.ID, 20, nil))

	admin := must1(auth.Register("ada_admin", "demo-admin-2026", &reg.ID))
	editor := must1(auth.Register("eli_editor", "demo-editor-2026", &reg.ID))
	member := must1(auth.Register("mia_member", "demo-member-2026", &reg.ID))
	viewer := must1(auth.Register("vic_viewer", "demo-viewer-2026", &reg.ID))
	for _, u := range []*models.User{admin, editor, member, viewer} {
		sync.RecordAudit(u.ID, "user.register", "USER", u.ID, nil)
	}

	s.assignRole(owner.ID, admin.ID, "role_admin")
	s.assignRole(owner.ID, editor.ID, "role_editor")
	s.assignRole(owner.ID, viewer.ID, "role_viewer")
	s.assignRole(owner.ID, member.ID, memberRole.ID)

	// The users table stores an optional email; Register does not set one, so
	// backfill it directly (no domain setter exists) for a complete profile.
	emails := map[string]string{
		owner.ID:  "owner@demo.athena",
		admin.ID:  "admin@demo.athena",
		editor.ID: "editor@demo.athena",
		member.ID: "member@demo.athena",
		viewer.ID: "viewer@demo.athena",
	}
	for id, e := range emails {
		s.exec(`UPDATE users SET email = ? WHERE id = ?`, e, id)
	}

	s.personas = []persona{
		{owner, "demo-owner-2026", emails[owner.ID], "Owner"},
		{admin, "demo-admin-2026", emails[admin.ID], "Admin"},
		{editor, "demo-editor-2026", emails[editor.ID], "Editor"},
		{member, "demo-member-2026", emails[member.ID], "Member"},
		{viewer, "demo-viewer-2026", emails[viewer.ID], "Viewer"},
	}
}

func (s *seeder) assignRole(actorID, userID, roleID string) {
	s.must(auth.AssignRole(userID, roleID))
	sync.RecordAudit(actorID, "user.roles.assign", "USER", userID, []string{roleID})
}

func (s *seeder) owner() *models.User  { return s.personas[0].user }
func (s *seeder) admin() *models.User  { return s.personas[1].user }
func (s *seeder) editor() *models.User { return s.personas[2].user }
func (s *seeder) member() *models.User { return s.personas[3].user }

// --- invites -----------------------------------------------------------------

func (s *seeder) seedInvites() {
	owner := s.owner().ID

	// Active: several uses left, expires in the future.
	active := must1(auth.CreateInvite(owner, 5, ptrTime(s.daysAhead(14))))
	sync.RecordAudit(owner, "invite.create", "INVITE", active.ID, map[string]any{"uses": 5})

	// Expired: expiry already in the past.
	expired := must1(auth.CreateInvite(owner, 5, ptrTime(s.daysAgo(2))))
	sync.RecordAudit(owner, "invite.create", "INVITE", expired.ID, map[string]any{"uses": 5})

	// Used-up: single use, then consumed so uses_remaining hits 0.
	spent := must1(auth.CreateInvite(owner, 1, nil))
	s.must(auth.ConsumeInvite(spent.ID))
	sync.RecordAudit(owner, "invite.create", "INVITE", spent.ID, map[string]any{"uses": 1})
}

func ptrTime(t time.Time) *time.Time { return &t }

// --- archives & tags ---------------------------------------------------------

func (s *seeder) seedArchivesAndTags() {
	// Guarantee the built-in GENERAL archive exists, then fetch it.
	s.must(domain.EnsureDefaultArchive())
	archives := must1(domain.ListArchives())
	for i := range archives {
		if archives[i].Name == domain.DefaultArchiveName {
			archive := archives[i]
			s.general = &archive
		}
	}

	s.fieldNotes = s.archive("Field Notes")
	s.projectLog = s.archive("Project Log")

	for _, t := range []struct{ name, color string }{
		{"welcome", "#4C8BF5"},
		{"guide", "#2ECC71"},
		{"media", "#F5A623"},
		{"legacy", "#95A5A6"},
		{"pinned", "#E74C3C"},
	} {
		tag := must1(domain.CreateTag(t.name, t.color))
		aid := s.owner().ID
		sync.RecordEvent("TAG_CREATED", "TAG", tag.ID, &aid, tag)
		sync.RecordAudit(aid, "tag.create", "TAG", tag.ID, map[string]string{"name": t.name})
		s.tags[t.name] = tag
	}
}

func (s *seeder) archive(name string) *models.Archive {
	createdArchive := must1(domain.CreateArchive(name))
	aid := s.owner().ID
	sync.RecordEvent("ARCHIVE_CREATED", "ARCHIVE", createdArchive.ID, &aid, createdArchive)
	sync.RecordAudit(aid, "archive.create", "ARCHIVE", createdArchive.ID, map[string]string{"name": name})
	return createdArchive
}

func (s *seeder) tagIDs(names ...string) []string {
	out := make([]string, 0, len(names))
	for _, n := range names {
		out = append(out, s.tags[n].ID)
	}
	return out
}

// --- assets ------------------------------------------------------------------

func (s *seeder) seedAssets() {
	// Gallery images (three distinct swatches).
	s.asset("gallery-1.png", "image/png", s.member().ID,
		must1(makeSolidPNG(240, 160, color.RGBA{0x4C, 0x8B, 0xF5, 0xFF})), 20)
	s.asset("gallery-2.png", "image/png", s.member().ID,
		must1(makeSolidPNG(240, 160, color.RGBA{0x2E, 0xCC, 0x71, 0xFF})), 20)
	s.asset("gallery-3.png", "image/png", s.member().ID,
		must1(makeSolidPNG(240, 160, color.RGBA{0xF5, 0xA6, 0x23, 0xFF})), 20)

	// Two-gallery split images.
	s.asset("split-a1.png", "image/png", s.editor().ID,
		must1(makeSolidPNG(200, 200, color.RGBA{0x9B, 0x59, 0xB6, 0xFF})), 18)
	s.asset("split-a2.png", "image/png", s.editor().ID,
		must1(makeSolidPNG(200, 200, color.RGBA{0x1A, 0xBC, 0x9C, 0xFF})), 18)
	s.asset("split-b1.png", "image/png", s.editor().ID,
		must1(makeSolidPNG(200, 200, color.RGBA{0xE7, 0x4C, 0x3C, 0xFF})), 18)
	s.asset("split-b2.png", "image/png", s.editor().ID,
		must1(makeSolidPNG(200, 200, color.RGBA{0x34, 0x49, 0x5E, 0xFF})), 18)

	// Inline single image with a pattern.
	s.asset("inline-pattern.png", "image/png", s.owner().ID,
		must1(makePNG(320, 200, color.RGBA{0x10, 0x12, 0x18, 0xFF}, color.RGBA{0x4C, 0x8B, 0xF5, 0xFF})), 15)

	// Canvas hero image.
	s.asset("canvas-hero.png", "image/png", s.owner().ID,
		must1(makePNG(300, 180, color.RGBA{0x22, 0x11, 0x33, 0xFF}, color.RGBA{0xF5, 0xA6, 0x23, 0xFF})), 12)

	// Non-image media: PDF (iframe), WAV (audio), GIF (animated image), zip
	// (generic file chip).
	s.asset("demo-brief.pdf", "application/pdf", s.owner().ID, makePDF("Athena Demo PDF"), 10)
	s.asset("chime.wav", "audio/wav", s.admin().ID, makeWAV(440, 0.6), 10)
	s.asset("loader.gif", "image/gif", s.admin().ID, must1(makeAnimatedGIF(160, 120, 8)), 8)
	s.asset("bundle.zip", "application/zip", s.owner().ID,
		must1(makeZip("readme.txt", "Athena demo bundle. Generated by the seed command.")), 6)
}

// asset writes a file to the uploads directory under an opaque name and records
// the DB row via the domain layer (mirroring handleUploadAsset). daysAgo spreads
// the created_at so the admin asset list is not all-at-once.
func (s *seeder) asset(fileName, mime, uploaderID string, data []byte, daysAgo int) *models.Asset {
	ext := filepath.Ext(fileName)
	storageName := must1(newOpaqueName(ext))
	if err := os.WriteFile(filepath.Join(s.uploads, storageName), data, 0o644); err != nil {
		panic(seedErr{fmt.Errorf("write asset %s: %w", fileName, err)})
	}
	createdAsset := must1(domain.CreateAsset(uploaderID, fileName, mime, int64(len(data)), storageName))
	s.exec(`UPDATE assets SET created_at = ? WHERE id = ?`, s.daysAgo(daysAgo), createdAsset.ID)
	sync.RecordAudit(uploaderID, "asset.upload", "ASSET", createdAsset.ID, nil)
	s.assets[fileName] = createdAsset
	return createdAsset
}

func (s *seeder) assetURL(fileName string) string {
	return "/api/v1/assets/" + s.assets[fileName].ID
}

// --- todos -------------------------------------------------------------------

func (s *seeder) seedTodos() {
	owner := s.owner().ID

	// Daily list: a resettable ritual list.
	s.todoDaily = s.todoList(models.TodoKindDaily, "Daily Rituals", &owner)
	morning := s.todoItem(s.todoDaily.ID, "Morning pages", nil, owner)
	s.updateItem(s.todoDaily.ID, morning.ID, domain.TodoItemPatch{Done: ptrBool(true)}, owner)
	s.todoItem(s.todoDaily.ID, "Stretch for 10 minutes", nil, owner)
	// Repeat and due dates are general-list features: a daily list clears
	// itself, and everything on it is today's business by definition.
	inbox := s.todoItem(s.todoDaily.ID, "Triage inbox", nil, owner)
	s.updateItem(s.todoDaily.ID, inbox.ID, domain.TodoItemPatch{Priority: ptrInt(1)}, owner)
	s.todoItem(s.todoDaily.ID, "Water the plants", nil, owner)

	// General list: a Trello-like named list with notes and a progress bar.
	s.todoGeneral = s.todoList(models.TodoKindGeneral, "Launch Checklist", &owner)
	notes := "Everything that has to land before the public demo."
	s.must1UpdateList(s.todoGeneral.ID, &notes, owner)

	readme := s.todoItem(s.todoGeneral.ID, "Draft the README", nil, owner)
	s.updateItem(s.todoGeneral.ID, readme.ID, domain.TodoItemPatch{Done: ptrBool(true)}, owner)

	ciTask := s.todoItem(s.todoGeneral.ID, "Wire up CI", nil, owner)
	s.updateItem(s.todoGeneral.ID, ciTask.ID, domain.TodoItemPatch{
		Priority: ptrInt(3),
		DueAt:    ptrTime(s.daysAhead(3)),
	}, owner)

	ship := s.todoItem(s.todoGeneral.ID, "Ship the demo seeder", nil, owner)
	s.updateItem(s.todoGeneral.ID, ship.ID, domain.TodoItemPatch{Priority: ptrInt(2)}, owner)
	// One-level subtask under "Ship the demo seeder".
	s.todoItem(s.todoGeneral.ID, "Generate sample media", &ship.ID, owner)

	weekly := s.todoItem(s.todoGeneral.ID, "Record a walkthrough", nil, owner)
	s.updateItem(s.todoGeneral.ID, weekly.ID, domain.TodoItemPatch{
		Recurrence: strptr("weekly"),
		DueAt:      ptrTime(s.daysAhead(7)),
	}, owner)

	monthly := s.todoItem(s.todoGeneral.ID, "Pay the server bill", nil, owner)
	s.updateItem(s.todoGeneral.ID, monthly.ID, domain.TodoItemPatch{
		Recurrence: strptr("monthly"),
		DueAt:      ptrTime(s.daysAhead(20)),
	}, owner)

	// Item linked to a moment; the moment_id is set once moments exist.
	s.todoMomentItem = s.todoItem(s.todoGeneral.ID, "Revisit the welcome note", nil, owner)
}

func (s *seeder) todoList(kind, title string, author *string) *models.TodoList {
	list := must1(domain.CreateTodoList(kind, title, author))
	sync.RecordEvent("TODO_LIST_CREATED", "TODO_LIST", list.ID, author, list)
	sync.RecordAudit(*author, "todo.list.create", "TODO_LIST", list.ID, map[string]string{"kind": kind, "title": title})
	return list
}

func (s *seeder) todoItem(listID, text string, parent *string, author string) *models.TodoItem {
	item := must1(domain.CreateTodoItem(listID, text, parent))
	sync.RecordEvent("TODO_ITEM_CREATED", "TODO_ITEM", item.ID, &author, item)
	return item
}

func (s *seeder) updateItem(listID, id string, p domain.TodoItemPatch, author string) *models.TodoItem {
	it, err := domain.UpdateTodoItem(id, p)
	s.must(err)
	sync.RecordEvent("TODO_ITEM_UPDATED", "TODO_ITEM", id, &author, it)
	return it
}

func (s *seeder) must1UpdateList(id string, notes *string, author string) {
	list := must1(domain.UpdateTodoList(id, nil, notes, nil, nil))
	sync.RecordEvent("TODO_LIST_UPDATED", "TODO_LIST", id, &author, list)
}

func ptrBool(v bool) *bool { return &v }
func ptrInt(v int) *int    { return &v }

// --- canvas ------------------------------------------------------------------

func (s *seeder) seedCanvasShell() {
	owner := s.owner().ID
	s.canvas = must1(domain.CreateCanvas("Demo Board", &owner))
	sync.RecordEvent("CANVAS_CREATED", "CANVAS", s.canvas.ID, &owner, s.canvas)
	sync.RecordAudit(owner, "canvas.create", "CANVAS", s.canvas.ID, map[string]string{"title": "Demo Board"})
}

func (s *seeder) seedCanvasContent() {
	canvasID := s.canvas.ID

	momentRef := s.node(models.CanvasNodeMomentRef, 40, 40, 240, 120, s.welcome.ID, nil)
	text := s.node(models.CanvasNodeText, 340, 40, 220, 120, "Ideas parking lot. Drop anything here.", nil)
	image := s.node(models.CanvasNodeImage, 40, 220, 300, 180, s.assetURL("canvas-hero.png"), nil)
	sticky := s.node(models.CanvasNodeSticky, 620, 40, 180, 140, "Remember to breathe.",
		strptr(`{"color":"#F5A623","fontSize":16}`))
	shape := s.node(models.CanvasNodeShape, 620, 220, 160, 120, "",
		strptr(`{"color":"#4C8BF5","shape":"rounded"}`))
	link := s.node(models.CanvasNodeLink, 380, 220, 240, 90, "https://create.roblox.com/docs", nil)
	todoRef := s.node(models.CanvasNodeTodoRef, 340, 340, 260, 150, s.todoGeneral.ID, nil)

	// Connect a few nodes so canvas_edges is exercised.
	s.edge(canvasID, momentRef.ID, text.ID)
	s.edge(canvasID, text.ID, todoRef.ID)
	s.edge(canvasID, sticky.ID, shape.ID)
	s.edge(canvasID, image.ID, link.ID)
}

func (s *seeder) node(kind string, x, y, w, h float64, content string, style *string) *models.CanvasNode {
	createdNode := must1(domain.CreateCanvasNode(s.canvas.ID, kind, x, y, w, h, content, style))
	owner := s.owner().ID
	sync.RecordEvent("CANVAS_NODE_CREATED", "CANVAS_NODE", createdNode.ID, &owner, createdNode)
	return createdNode
}

func (s *seeder) edge(canvasID, from, to string) {
	createdEdge := must1(domain.CreateCanvasEdge(canvasID, from, to))
	if createdEdge == nil {
		return
	}
	owner := s.owner().ID
	sync.RecordEvent("CANVAS_EDGE_CREATED", "CANVAS_EDGE", createdEdge.ID, &owner, createdEdge)
}

// --- moments -----------------------------------------------------------------

func (s *seeder) seedMoments() {
	// The welcome moment is the cross-reference target and the rich-markdown
	// showcase. Created first so later moments can embed it.
	s.welcome = s.moment(s.general.ID, s.owner().ID, "Welcome to Athena",
		s.welcomeBody(), s.tagIDs("welcome", "guide"), 12)

	// Cross-reference / embed showcase: moment, todo, and canvas tokens.
	s.moment(s.projectLog.ID, s.editor().ID, "Everything wires together",
		s.embedBody(), s.tagIDs("guide"), 10)

	// Three-image gallery (consecutive image lines auto-group).
	s.moment(s.fieldNotes.ID, s.member().ID, "Trip photos",
		s.gallery3Body(), s.tagIDs("media"), 9)

	// Two galleries separated by a --- rule.
	s.moment(s.fieldNotes.ID, s.editor().ID, "Before and after",
		s.twoGalleriesBody(), s.tagIDs("media"), 8)

	// Single inline image with a caption.
	s.moment(s.general.ID, s.owner().ID, "A pattern I like",
		s.inlineImageBody(), s.tagIDs("media"), 7)

	// Mixed media attachments (PDF, audio, animated GIF, generic file).
	s.moment(s.projectLog.ID, s.admin().ID, "Attachments of every kind",
		s.mediaBody(), s.tagIDs("media", "guide"), 6)

	// A plain moment by a Member to show cross-author authorship.
	s.moment(s.fieldNotes.ID, s.member().ID, "Quiet morning",
		"Nothing fancy today, just a short note to show a Member's authorship in the feed.", nil, 5)

	// Pinned moment (library-shared pin).
	pinned := s.moment(s.general.ID, s.owner().ID, "Read me first",
		"This moment is **pinned** so it stays at the top of the feed for everyone.", s.tagIDs("pinned"), 4)
	pinnedMoment := must1(domain.SetMomentPinned(pinned.ID, true))
	oid := s.owner().ID
	sync.RecordEvent("MOMENT_PINNED", "MOMENT", pinned.ID, &oid, pinnedMoment)
	sync.RecordAudit(oid, "moment.pin", "MOMENT", pinned.ID, nil)

	// Legacy-badged moment (migrated-style: no author, is_legacy = 1).
	legacy := s.moment(s.general.ID, "", "From the old library",
		"> This entry was carried over from a previous system.\n\nIt renders with a **legacy** badge.", s.tagIDs("legacy"), 40)
	s.exec(`UPDATE moments SET is_legacy = 1, author_id = NULL WHERE id = ?`, legacy.ID)

	// Soft-deleted moment (recoverable from the trash).
	del := s.moment(s.projectLog.ID, s.editor().ID, "Oops, deleted this",
		"This moment was soft-deleted; it should appear only in the trash / recovery view.", nil, 3)
	s.must(domain.DeleteMoment(del.ID))
	eid := s.editor().ID
	sync.RecordEvent("MOMENT_DELETED", "MOMENT", del.ID, &eid, nil)
	sync.RecordAudit(eid, "moment.delete", "MOMENT", del.ID, nil)
}

// moment creates a moment through the domain layer, records the authentic
// event + audit entry, and backdates its feed timestamp so the demo feed is
// spread over time. authorID "" creates an authorless (legacy) moment.
func (s *seeder) moment(archiveID, authorID, title, content string, tagIDs []string, daysAgo int) *models.Moment {
	createdMoment := must1(domain.CreateMoment(archiveID, authorID, title, content, tagIDs))
	timestamp := s.daysAgo(daysAgo)
	s.exec(`UPDATE moments SET timestamp = ?, created_at = ?, updated_at = ? WHERE id = ?`, timestamp, timestamp, timestamp, createdMoment.ID)
	createdMoment.Timestamp = timestamp
	var authorArg *string
	if authorID != "" {
		authorArg = &authorID
		sync.RecordAudit(authorID, "moment.create", "MOMENT", createdMoment.ID, map[string]string{"title": title})
	}
	sync.RecordEvent("MOMENT_CREATED", "MOMENT", createdMoment.ID, authorArg, createdMoment)
	s.momentCount++
	return createdMoment
}

func (s *seeder) linkTodoToMoment() {
	owner := s.owner().ID
	s.updateItem(s.todoGeneral.ID, s.todoMomentItem.ID, domain.TodoItemPatch{
		MomentID: strptr(s.welcome.ID),
	}, owner)
}

// --- chat --------------------------------------------------------------------

func (s *seeder) seedChat() {
	s.chat(s.owner().ID, nil, "Welcome to the library chat! This is where we talk shop.", 11, false)
	s.chat(s.admin().ID, nil, "Assets and moments are seeded. Take a look at the feed.", 10, false)
	s.chat(s.editor().ID, nil, "Love the new canvas board. The todo embed is slick.", 8, false)
	s.chat(s.member().ID, nil, "First post! Excited to be here.", 6, false)
	// A legacy chat message: no author, a preserved display name, is_legacy = 1.
	s.chat("", strptr("OldTimer"), "Greetings from the archives of the old system.", 45, true)
	s.chat(s.owner().ID, nil, "Reminder: the demo credentials are printed by `npm run demo`.", 1, false)
}

func (s *seeder) chat(authorID string, displayName *string, content string, daysAgo int, legacy bool) {
	var authorArg *string
	if authorID != "" {
		authorArg = &authorID
	}
	message := must1(domain.CreateChatMessage(authorArg, displayName, content))
	timestamp := s.daysAgo(daysAgo)
	if legacy {
		s.exec(`UPDATE chat_messages SET is_legacy = 1, created_at = ?, updated_at = ? WHERE id = ?`, timestamp, timestamp, message.ID)
	} else {
		s.exec(`UPDATE chat_messages SET created_at = ?, updated_at = ? WHERE id = ?`, timestamp, timestamp, message.ID)
	}
	sync.RecordEvent("CHAT_CREATED", "CHAT_MESSAGE", message.ID, authorArg, message)
	if authorID != "" {
		sync.RecordAudit(authorID, "chat.create", "CHAT_MESSAGE", message.ID, nil)
	}
	s.chatCount++
}

// --- link previews & settings ------------------------------------------------

func (s *seeder) seedLinkPreviews() {
	// Seed a cached preview for the link used in the welcome moment and the
	// canvas link node, so the preview feature renders without any network
	// scrape (unavailable during seeding).
	s.must(domain.SaveLinkPreview(&models.LinkPreview{
		URL:         "https://create.roblox.com/docs",
		Title:       "Roblox Creator Documentation",
		Description: "Guides, tutorials, and API reference for building on Roblox.",
		ImageURL:    "https://create.roblox.com/og-image.png",
		ScrapedAt:   s.daysAgo(1),
	}))
}

func (s *seeder) seedSettings() {
	owner := s.owner().ID
	s.must(domain.SetSetting("show_legacy_moment_badges", "true"))
	s.must(domain.SetSetting("show_legacy_chat_badges", "true"))
	sync.RecordAudit(owner, "settings.update", "SETTINGS", "", map[string]string{
		"show_legacy_moment_badges": "true",
		"show_legacy_chat_badges":   "true",
	})
}

// --- summary -----------------------------------------------------------------

func (s *seeder) printSummary() {
	version, _ := sync.GetCurrentVersion()
	fmt.Println()
	fmt.Println("Demo library seeded successfully.")
	fmt.Printf("  moments:        %d\n", s.momentCount)
	fmt.Printf("  chat messages:  %d\n", s.chatCount)
	fmt.Printf("  assets:         %d\n", len(s.assets))
	fmt.Printf("  library version: %d\n", version)
	fmt.Println()
	fmt.Println("Demo credentials (username / password / role / email):")
	fmt.Println("  ------------------------------------------------------------------")
	for _, p := range s.personas {
		fmt.Printf("  %-12s  %-18s  %-7s  %s\n", p.user.Username, p.password, p.role, p.email)
	}
	fmt.Println("  ------------------------------------------------------------------")
	fmt.Println("The first user (athena) is the server Owner.")
}

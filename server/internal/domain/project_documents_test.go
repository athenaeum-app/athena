package domain

import (
	"errors"
	"testing"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
)

// newDocumentProject is the two-line preamble every documents test needs: a
// project to hang a tree off.
func newDocumentProject(t *testing.T, title string) *models.Project {
	t.Helper()
	p, err := CreateProject(title, nil)
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	return p
}

func newDocument(t *testing.T, projectID, kind, title string, parentID *string) *models.ProjectDocument {
	t.Helper()
	d, err := CreateProjectDocument(projectID, kind, title, "", parentID, nil, nil)
	if err != nil {
		t.Fatalf("create %s %q: %v", kind, title, err)
	}
	if d == nil {
		t.Fatalf("create %s %q: project not found", kind, title)
	}
	return d
}

// A tree that spans two projects is not a tree, and the folder picker is
// per-project, so a parent from elsewhere can only be a client bug or a forged
// request.
func TestCreateProjectDocument_RejectsParentFromAnotherProject(t *testing.T) {
	setupDB(t)
	mine := newDocumentProject(t, "Mine")
	theirs := newDocumentProject(t, "Theirs")
	elsewhere := newDocument(t, theirs.ID, models.ProjectDocumentKindFolder, "Research", nil)

	_, err := CreateProjectDocument(mine.ID, models.ProjectDocumentKindDocument, "Decision", "", &elsewhere.ID, nil, nil)
	if !errors.Is(err, ErrProjectDocumentParent) {
		t.Fatalf("cross-project parent gave %v, want ErrProjectDocumentParent", err)
	}
}

func TestCreateProjectDocument_RejectsDocumentAsParent(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	doc := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Decision", nil)

	_, err := CreateProjectDocument(p.ID, models.ProjectDocumentKindDocument, "Nested", "", &doc.ID, nil, nil)
	if !errors.Is(err, ErrProjectDocumentParent) {
		t.Fatalf("document as parent gave %v, want ErrProjectDocumentParent", err)
	}
}

func TestCreateProjectDocument_RejectsUnknownKind(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")

	_, err := CreateProjectDocument(p.ID, "wiki", "Decision", "", nil, nil, nil)
	if !errors.Is(err, ErrProjectDocumentKind) {
		t.Fatalf("unknown kind gave %v, want ErrProjectDocumentKind", err)
	}
}

// Dropping a folder into its own descendant would cut that branch out of the
// tree and leave it circling with no route back to the root.
func TestUpdateProjectDocument_RejectsMoveIntoOwnDescendant(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	top := newDocument(t, p.ID, models.ProjectDocumentKindFolder, "Design", nil)
	middle := newDocument(t, p.ID, models.ProjectDocumentKindFolder, "Combat", &top.ID)
	bottom := newDocument(t, p.ID, models.ProjectDocumentKindFolder, "Weapons", &middle.ID)

	for name, parent := range map[string]string{"itself": top.ID, "child": middle.ID, "grandchild": bottom.ID} {
		_, err := UpdateProjectDocument(top.ID, ProjectDocumentPatch{ParentID: &parent})
		if !errors.Is(err, ErrProjectDocumentCycle) {
			t.Errorf("move into %s gave %v, want ErrProjectDocumentCycle", name, err)
		}
	}

	// The legal direction still works: a branch moves up to the root.
	moved, err := UpdateProjectDocument(bottom.ID, ProjectDocumentPatch{ClearParentID: true})
	if err != nil {
		t.Fatalf("move to root: %v", err)
	}
	if moved.ParentID != nil {
		t.Errorf("moved to root but parent is %v", *moved.ParentID)
	}
}

func TestUpdateProjectDocument_LockedRefusesTitleAndBody(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	doc := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Netcode", nil)

	locked := models.ProjectDocumentStatusLocked
	if _, err := UpdateProjectDocument(doc.ID, ProjectDocumentPatch{Status: &locked}); err != nil {
		t.Fatalf("lock: %v", err)
	}

	title := "Netcode (revised)"
	if _, err := UpdateProjectDocument(doc.ID, ProjectDocumentPatch{Title: &title}); !errors.Is(err, ErrProjectDocumentLocked) {
		t.Errorf("title edit while locked gave %v, want ErrProjectDocumentLocked", err)
	}
	body := "rollback, actually"
	if _, err := UpdateProjectDocument(doc.ID, ProjectDocumentPatch{Body: &body}); !errors.Is(err, ErrProjectDocumentLocked) {
		t.Errorf("body edit while locked gave %v, want ErrProjectDocumentLocked", err)
	}

	// Moving and reordering a locked document is not editing it, and unlocking
	// it has to stay possible or the lock would be permanent.
	if _, err := UpdateProjectDocument(doc.ID, ProjectDocumentPatch{Position: floatPtr(3)}); err != nil {
		t.Errorf("reposition while locked: %v", err)
	}
	draft := models.ProjectDocumentStatusDraft
	unlocked, err := UpdateProjectDocument(doc.ID, ProjectDocumentPatch{Status: &draft})
	if err != nil {
		t.Fatalf("unlock: %v", err)
	}
	if unlocked.Status != models.ProjectDocumentStatusDraft {
		t.Fatalf("status after unlock is %q", unlocked.Status)
	}
	if _, err := UpdateProjectDocument(doc.ID, ProjectDocumentPatch{Body: &body}); err != nil {
		t.Errorf("body edit after unlock: %v", err)
	}
}

func TestDeleteProjectDocument_ReturnsSubtreeAndCascades(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	keep := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Keep me", nil)
	top := newDocument(t, p.ID, models.ProjectDocumentKindFolder, "Design", nil)
	middle := newDocument(t, p.ID, models.ProjectDocumentKindFolder, "Combat", &top.ID)
	leaf := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Weapons", &middle.ID)
	if _, err := CreateProjectDocumentVersion(leaf.ID, nil); err != nil {
		t.Fatalf("snapshot leaf: %v", err)
	}

	removed, err := DeleteProjectDocument(top.ID)
	if err != nil {
		t.Fatalf("delete folder: %v", err)
	}
	if len(removed) != 3 {
		t.Fatalf("delete returned %d rows, want the whole subtree of 3", len(removed))
	}
	// Parents first, or a restore would insert a child against a parent that
	// is not back yet.
	if removed[0].ID != top.ID {
		t.Errorf("subtree starts at %q, want the deleted root %q", removed[0].Title, top.Title)
	}
	seen := map[string]bool{}
	for _, d := range removed {
		seen[d.ID] = true
	}
	for _, want := range []*models.ProjectDocument{top, middle, leaf} {
		if !seen[want.ID] {
			t.Errorf("subtree is missing %q", want.Title)
		}
	}

	var rows int
	if err := db.DB.QueryRow(`SELECT COUNT(*) FROM project_documents`).Scan(&rows); err != nil {
		t.Fatalf("count documents: %v", err)
	}
	if rows != 1 {
		t.Errorf("%d documents survived, want only the untouched sibling", rows)
	}
	var versions int
	if err := db.DB.QueryRow(`SELECT COUNT(*) FROM project_document_versions`).Scan(&versions); err != nil {
		t.Fatalf("count versions: %v", err)
	}
	if versions != 0 {
		t.Errorf("%d versions survived their document", versions)
	}
	if got, err := getProjectDocument(keep.ID); err != nil || got == nil {
		t.Errorf("sibling outside the subtree was deleted (%v)", err)
	}
	if _, err := DeleteProjectDocument(top.ID); err != nil {
		t.Errorf("second delete of a gone row: %v", err)
	}
}

// The undo stack restores identity, not a copy: embeds and links already point
// at these ids.
func TestRestoreProjectDocuments_ReinsertsWithOriginalIDs(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	top := newDocument(t, p.ID, models.ProjectDocumentKindFolder, "Design", nil)
	middle := newDocument(t, p.ID, models.ProjectDocumentKindFolder, "Combat", &top.ID)
	leaf := newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Weapons", &middle.ID)

	removed, err := DeleteProjectDocument(top.ID)
	if err != nil {
		t.Fatalf("delete folder: %v", err)
	}
	restored, err := RestoreProjectDocuments(p.ID, removed)
	if err != nil {
		t.Fatalf("restore subtree: %v", err)
	}
	if len(restored) != 3 {
		t.Fatalf("restored %d rows, want 3", len(restored))
	}

	for _, want := range []*models.ProjectDocument{top, middle, leaf} {
		got, err := getProjectDocument(want.ID)
		if err != nil {
			t.Fatalf("read restored %q: %v", want.Title, err)
		}
		if got == nil {
			t.Fatalf("%q did not come back under its own id", want.Title)
		}
		if got.Title != want.Title || got.Kind != want.Kind {
			t.Errorf("%q came back as %q/%q", want.Title, got.Title, got.Kind)
		}
		if (got.ParentID == nil) != (want.ParentID == nil) {
			t.Errorf("%q came back with parent %v, want %v", want.Title, got.ParentID, want.ParentID)
		}
		if got.ParentID != nil && *got.ParentID != *want.ParentID {
			t.Errorf("%q came back under %q, want %q", want.Title, *got.ParentID, *want.ParentID)
		}
	}

	// Restoring twice would mint duplicates of live rows, so the second one is
	// refused rather than being a no-op.
	if _, err := RestoreProjectDocuments(p.ID, removed); !errors.Is(err, ErrProjectDocumentIDTaken) {
		t.Errorf("second restore gave %v, want ErrProjectDocumentIDTaken", err)
	}
}

func TestRestoreProjectDocuments_RejectsAnotherProjectsRows(t *testing.T) {
	setupDB(t)
	mine := newDocumentProject(t, "Mine")
	theirs := newDocumentProject(t, "Theirs")
	doc := newDocument(t, theirs.ID, models.ProjectDocumentKindDocument, "Their notes", nil)

	removed, err := DeleteProjectDocument(doc.ID)
	if err != nil {
		t.Fatalf("delete document: %v", err)
	}
	if _, err := RestoreProjectDocuments(mine.ID, removed); !errors.Is(err, ErrProjectDocumentProject) {
		t.Errorf("restore into another project gave %v, want ErrProjectDocumentProject", err)
	}
}

// An edit opens at most one version an hour: a snapshot per save would mint
// one per typing pause, and none at all would lose an afternoon's rewrite.
func TestUpdateProjectDocument_AutoSnapshotsAtMostOncePerHour(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	doc, err := CreateProjectDocument(p.ID, models.ProjectDocumentKindDocument, "Netcode", "one", nil, nil, nil)
	if err != nil {
		t.Fatalf("create document: %v", err)
	}

	editBody(t, doc.ID, "two")
	versions := listVersions(t, doc.ID)
	if len(versions) != 1 {
		t.Fatalf("first edit left %d versions, want 1 (a document with no history always snapshots)", len(versions))
	}
	if versions[0].Title != "Netcode" {
		t.Errorf("snapshot holds title %q, want the pre-edit title", versions[0].Title)
	}
	first, err := GetProjectDocumentVersion(versions[0].ID)
	if err != nil {
		t.Fatalf("read version: %v", err)
	}
	if first.Body != "one" {
		t.Errorf("snapshot holds body %q, want the pre-edit body", first.Body)
	}

	editBody(t, doc.ID, "three")
	if got := listVersions(t, doc.ID); len(got) != 1 {
		t.Fatalf("an edit inside the window left %d versions, want the original 1", len(got))
	}

	// A rewrite of the same text is not an edit, so it takes no snapshot even
	// once the window has passed.
	ageVersions(t, doc.ID, 2*time.Hour)
	editBody(t, doc.ID, "three")
	if got := listVersions(t, doc.ID); len(got) != 1 {
		t.Fatalf("an unchanged body left %d versions, want 1", len(got))
	}

	editBody(t, doc.ID, "four")
	after := listVersions(t, doc.ID)
	if len(after) != 2 {
		t.Fatalf("an edit past the window left %d versions, want 2", len(after))
	}
	newest, err := GetProjectDocumentVersion(after[0].ID)
	if err != nil {
		t.Fatalf("read newest version: %v", err)
	}
	if newest.Body != "three" {
		t.Errorf("newest snapshot holds %q, want the body that was about to be overwritten", newest.Body)
	}
}

func TestRestoreProjectDocumentVersion_SnapshotsCurrentStateFirst(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	doc, err := CreateProjectDocument(p.ID, models.ProjectDocumentKindDocument, "Netcode", "rollback", nil, nil, nil)
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	saved, err := CreateProjectDocumentVersion(doc.ID, nil)
	if err != nil {
		t.Fatalf("save version: %v", err)
	}

	editBody(t, doc.ID, "lockstep")
	title := "Netcode (v2)"
	if _, err := UpdateProjectDocument(doc.ID, ProjectDocumentPatch{Title: &title}); err != nil {
		t.Fatalf("retitle: %v", err)
	}

	restored, err := RestoreProjectDocumentVersion(saved.ID, nil)
	if err != nil {
		t.Fatalf("restore version: %v", err)
	}
	if restored.Body != "rollback" || restored.Title != "Netcode" {
		t.Errorf("restored document is %q/%q, want the snapshot's title and body", restored.Title, restored.Body)
	}

	// The state the restore overwrote has to be reachable, or a mis-click
	// would be the one destructive action in the module.
	versions := listVersions(t, doc.ID)
	if len(versions) != 2 {
		t.Fatalf("restore left %d versions, want the saved one plus a snapshot of what it replaced", len(versions))
	}
	var replaced *models.ProjectDocumentVersion
	for _, v := range versions {
		if v.ID == saved.ID {
			continue
		}
		full, err := GetProjectDocumentVersion(v.ID)
		if err != nil {
			t.Fatalf("read version: %v", err)
		}
		replaced = full
	}
	if replaced == nil {
		t.Fatal("no snapshot of the pre-restore state")
	}
	if replaced.Title != "Netcode (v2)" || replaced.Body != "lockstep" {
		t.Errorf("pre-restore snapshot is %q/%q, want the state the restore overwrote", replaced.Title, replaced.Body)
	}
}

func TestListProjectDocumentVersions_OmitsBodies(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	doc, err := CreateProjectDocument(p.ID, models.ProjectDocumentKindDocument, "Netcode", "rollback", nil, nil, nil)
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	if _, err := CreateProjectDocumentVersion(doc.ID, nil); err != nil {
		t.Fatalf("save version: %v", err)
	}
	versions := listVersions(t, doc.ID)
	if len(versions) != 1 {
		t.Fatalf("got %d versions, want 1", len(versions))
	}
	if versions[0].Body != "" {
		t.Errorf("the version list carried a body: %q", versions[0].Body)
	}
	full, err := GetProjectDocumentVersion(versions[0].ID)
	if err != nil {
		t.Fatalf("read version: %v", err)
	}
	if full.Body != "rollback" {
		t.Errorf("single-version read gave body %q, want %q", full.Body, "rollback")
	}
}

// Documents ride along in the project payload the way milestones and cards do,
// which is what lets the Hub render the tab from one request.
func TestGetProject_IncludesDocuments(t *testing.T) {
	setupDB(t)
	p := newDocumentProject(t, "Game")
	folder := newDocument(t, p.ID, models.ProjectDocumentKindFolder, "Design", nil)
	newDocument(t, p.ID, models.ProjectDocumentKindDocument, "Weapons", &folder.ID)

	got, err := GetProject(p.ID)
	if err != nil {
		t.Fatalf("get project: %v", err)
	}
	if len(got.Documents) != 2 {
		t.Fatalf("project payload carried %d documents, want 2", len(got.Documents))
	}
	empty := newDocumentProject(t, "Empty")
	list, err := ListProjects()
	if err != nil {
		t.Fatalf("list projects: %v", err)
	}
	for _, proj := range list {
		if proj.ID == empty.ID && proj.Documents == nil {
			t.Error("a project with no documents serialized documents as null, want []")
		}
	}
}

func floatPtr(f float64) *float64 { return &f }

func editBody(t *testing.T, id, body string) {
	t.Helper()
	if _, err := UpdateProjectDocument(id, ProjectDocumentPatch{Body: &body}); err != nil {
		t.Fatalf("edit body of %s: %v", id, err)
	}
}

func listVersions(t *testing.T, id string) []models.ProjectDocumentVersion {
	t.Helper()
	versions, err := ListProjectDocumentVersions(id)
	if err != nil {
		t.Fatalf("list versions: %v", err)
	}
	if versions == nil {
		t.Fatalf("list versions: document %s not found", id)
	}
	return versions
}

// ageVersions backdates a document's snapshots so the next edit sees the
// window as expired, which is otherwise only observable by waiting an hour.
func ageVersions(t *testing.T, id string, by time.Duration) {
	t.Helper()
	if _, err := db.DB.Exec(
		`UPDATE project_document_versions SET created_at = ? WHERE document_id = ?`,
		time.Now().UTC().Add(-by), id,
	); err != nil {
		t.Fatalf("age versions: %v", err)
	}
}

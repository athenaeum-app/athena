package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/domain"
)

// seedBrokenLibrary reproduces what a server migrated before the asset fix
// looks like: real v2 content whose bodies still point at v1 /uploads/ URLs,
// with no matching assets rows and nothing in the v2 uploads directory.
func seedBrokenLibrary(t *testing.T, momentContent, chatContent string) (ownerID, v1Uploads, v2Uploads string) {
	t.Helper()
	ownerID = registerOwnerForMigration(t)

	archive, err := domain.CreateArchive("Journal")
	if err != nil {
		t.Fatalf("create archive: %v", err)
	}
	if _, err := domain.CreateMoment(archive.ID, ownerID, "Holiday", momentContent, nil); err != nil {
		t.Fatalf("create moment: %v", err)
	}
	if _, err := domain.CreateChatMessage(&ownerID, nil, chatContent); err != nil {
		t.Fatalf("create chat message: %v", err)
	}

	v1Uploads = writeV1Uploads(t, "1778966276_holiday.png", "1778966277_notes.pdf", "1778966278_orphan.png")
	v2Uploads = t.TempDir() + "/v2uploads"
	return ownerID, v1Uploads, v2Uploads
}

// TestRepairAssets_ImportsAndRepointsLegacyReferences is the production case:
// a library that is already live on v2, whose legacy images are broken because
// the original migration copied no files.
func TestRepairAssets_ImportsAndRepointsLegacyReferences(t *testing.T) {
	openV2Fixture(t)
	_, v1Uploads, v2Uploads := seedBrokenLibrary(t,
		"Trip:\n\nhttp://192.168.2.43:8080/uploads/1778966276_holiday.png \n\nnice",
		"notes here https://athena.example.com/uploads/1778966277_notes.pdf",
	)

	if err := runRepairAssets(db.DB, v1Uploads, v2Uploads, false); err != nil {
		t.Fatalf("runRepairAssets: %v", err)
	}

	assets, err := domain.ListAssets()
	if err != nil {
		t.Fatalf("list assets: %v", err)
	}
	// Only the two referenced files; the orphan is left in v1.
	if len(assets) != 2 {
		t.Fatalf("imported %d assets, want 2 (the orphan should not be imported)", len(assets))
	}
	byName := map[string]string{}
	for _, a := range assets {
		byName[a.FileName] = a.ID
		if _, err := os.Stat(filepath.Join(v2Uploads, a.StoragePath)); err != nil {
			t.Errorf("asset %s missing on disk: %v", a.FileName, err)
		}
	}

	moments, err := domain.ListMoments(nil, nil, 10, nil)
	if err != nil || len(moments) != 1 {
		t.Fatalf("list moments: %v (got %d)", err, len(moments))
	}
	want := "![holiday.png](/api/v1/assets/" + byName["holiday.png"] + ")"
	if !strings.Contains(moments[0].Content, want) {
		t.Errorf("moment content = %q\nwant it to contain %q", moments[0].Content, want)
	}
	if strings.Contains(moments[0].Content, "/uploads/") {
		t.Errorf("moment still references a v1 upload URL: %q", moments[0].Content)
	}

	msgs, err := domain.ListChatMessages(nil, 10)
	if err != nil || len(msgs) != 1 {
		t.Fatalf("list chat: %v (got %d)", err, len(msgs))
	}
	wantLink := "[notes.pdf](/api/v1/assets/" + byName["notes.pdf"] + ")"
	if !strings.Contains(msgs[0].Content, wantLink) {
		t.Errorf("chat content = %q\nwant it to contain %q", msgs[0].Content, wantLink)
	}
}

// TestRepairAssets_IsIdempotent matters because this runs against live data:
// a second run must not re-import the files or touch the content again.
func TestRepairAssets_IsIdempotent(t *testing.T) {
	openV2Fixture(t)
	_, v1Uploads, v2Uploads := seedBrokenLibrary(t,
		"http://host/uploads/1778966276_holiday.png",
		"http://host/uploads/1778966277_notes.pdf",
	)

	if err := runRepairAssets(db.DB, v1Uploads, v2Uploads, false); err != nil {
		t.Fatalf("first run: %v", err)
	}
	firstAssets, _ := domain.ListAssets()
	firstMoments, _ := domain.ListMoments(nil, nil, 10, nil)

	if err := runRepairAssets(db.DB, v1Uploads, v2Uploads, false); err != nil {
		t.Fatalf("second run: %v", err)
	}
	secondAssets, _ := domain.ListAssets()
	secondMoments, _ := domain.ListMoments(nil, nil, 10, nil)

	if len(secondAssets) != len(firstAssets) {
		t.Errorf("second run changed the asset count: %d -> %d", len(firstAssets), len(secondAssets))
	}
	if secondMoments[0].Content != firstMoments[0].Content {
		t.Errorf("second run changed content:\n %q\n %q", firstMoments[0].Content, secondMoments[0].Content)
	}
	if n := len(filesIn(t, v2Uploads)); n != 2 {
		t.Errorf("v2 uploads holds %d files after two runs, want 2", n)
	}
}

// TestRepairAssets_DryRunWritesNothing guards the flag used to preview the
// change on a live server before committing to it.
func TestRepairAssets_DryRunWritesNothing(t *testing.T) {
	openV2Fixture(t)
	_, v1Uploads, v2Uploads := seedBrokenLibrary(t,
		"http://host/uploads/1778966276_holiday.png",
		"nothing here",
	)

	if err := runRepairAssets(db.DB, v1Uploads, v2Uploads, true); err != nil {
		t.Fatalf("dry run: %v", err)
	}

	if assets, _ := domain.ListAssets(); len(assets) != 0 {
		t.Errorf("dry run created %d asset rows, want 0", len(assets))
	}
	if n := len(filesIn(t, v2Uploads)); n != 0 {
		t.Errorf("dry run copied %d files, want 0", n)
	}
	moments, _ := domain.ListMoments(nil, nil, 10, nil)
	if !strings.Contains(moments[0].Content, "/uploads/1778966276_holiday.png") {
		t.Errorf("dry run modified content: %q", moments[0].Content)
	}
}

// TestRepairAssets_LeavesLiveContentAlone: the repair runs on a library that
// has been in use, so content with no legacy reference (including assets
// uploaded natively to v2) must come through untouched.
func TestRepairAssets_LeavesLiveContentAlone(t *testing.T) {
	openV2Fixture(t)
	ownerID, v1Uploads, v2Uploads := seedBrokenLibrary(t,
		"http://host/uploads/1778966276_holiday.png",
		"plain chat, no attachments",
	)

	archive, _ := domain.CreateArchive("Later")
	native, err := domain.CreateMoment(archive.ID, ownerID, "Native", "![](/api/v1/assets/already-native) plus https://example.com/page", nil)
	if err != nil {
		t.Fatalf("create native moment: %v", err)
	}

	if err := runRepairAssets(db.DB, v1Uploads, v2Uploads, false); err != nil {
		t.Fatalf("runRepairAssets: %v", err)
	}

	after, err := domain.GetMoment(native.ID)
	if err != nil || after == nil {
		t.Fatalf("get native moment: %v", err)
	}
	if after.Content != native.Content {
		t.Errorf("live v2 content was modified:\n old %q\n new %q", native.Content, after.Content)
	}
}

// TestRepairAssets_MissingFileLeavesReferenceAlone: a reference whose file is
// gone must stay as it is rather than being repointed at an asset that does
// not exist.
func TestRepairAssets_MissingFileLeavesReferenceAlone(t *testing.T) {
	openV2Fixture(t)
	_, v1Uploads, v2Uploads := seedBrokenLibrary(t,
		"gone: http://host/uploads/deleted_long_ago.png",
		"kept: http://host/uploads/1778966277_notes.pdf",
	)

	if err := runRepairAssets(db.DB, v1Uploads, v2Uploads, false); err != nil {
		t.Fatalf("runRepairAssets: %v", err)
	}

	moments, _ := domain.ListMoments(nil, nil, 10, nil)
	if !strings.Contains(moments[0].Content, "/uploads/deleted_long_ago.png") {
		t.Errorf("reference to a missing file should be left alone, got %q", moments[0].Content)
	}
	msgs, _ := domain.ListChatMessages(nil, 10)
	if strings.Contains(msgs[0].Content, "/uploads/") {
		t.Errorf("the reference whose file exists should have been repaired, got %q", msgs[0].Content)
	}
}

// TestRepairAssets_NoLegacyReferencesIsNoOp covers a library that never had
// any (or has already been repaired).
func TestRepairAssets_NoLegacyReferencesIsNoOp(t *testing.T) {
	openV2Fixture(t)
	_, v1Uploads, v2Uploads := seedBrokenLibrary(t, "nothing", "nothing")

	if err := runRepairAssets(db.DB, v1Uploads, v2Uploads, false); err != nil {
		t.Fatalf("runRepairAssets: %v", err)
	}
	if assets, _ := domain.ListAssets(); len(assets) != 0 {
		t.Errorf("imported %d assets into a library with no legacy references, want 0", len(assets))
	}
}

func filesIn(t *testing.T, dir string) []os.DirEntry {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("read %s: %v", dir, err)
	}
	return entries
}

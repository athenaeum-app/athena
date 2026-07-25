package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/domain"
	_ "modernc.org/sqlite"
)

// openV1AssetFixture builds a v1 database shaped like a real one: an archive,
// a moment whose content embeds an uploaded image as a bare absolute URL, and
// a chat message doing the same with a non-image file. Crucially the v1
// `assets` table is left EMPTY, which is what a real v1 server looks like.
// Its upload handler wrote files to disk and never recorded a row.
func openV1AssetFixture(t *testing.T, momentContent, chatContent string) *sql.DB {
	t.Helper()
	path := t.TempDir() + "/v1.db"
	v1, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open v1 fixture: %v", err)
	}
	t.Cleanup(func() { v1.Close() })

	stamp := time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339)
	for _, stmt := range []string{
		`CREATE TABLE archives (id TEXT PRIMARY KEY, name TEXT, created_at TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT, colour TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE moments (id TEXT PRIMARY KEY, archive_id TEXT, title TEXT, content TEXT, timestamp TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE moment_tags (moment_id TEXT, tag_id TEXT)`,
		`CREATE TABLE assets (id TEXT PRIMARY KEY, file_name TEXT, local_uri TEXT UNIQUE NOT NULL)`,
		`CREATE TABLE buffer_messages (id TEXT PRIMARY KEY, author_name TEXT, content TEXT, timestamp TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0)`,
	} {
		if _, err := v1.Exec(stmt); err != nil {
			t.Fatalf("create v1 schema: %v", err)
		}
	}
	if _, err := v1.Exec(
		`INSERT INTO archives (id, name, created_at, updated_at) VALUES ('arch-1', 'Journal', ?, ?)`, stamp, stamp,
	); err != nil {
		t.Fatalf("insert v1 archive: %v", err)
	}
	if _, err := v1.Exec(
		`INSERT INTO moments (id, archive_id, title, content, timestamp, updated_at) VALUES ('mom-1', 'arch-1', 'With a photo', ?, ?, ?)`,
		momentContent, stamp, stamp,
	); err != nil {
		t.Fatalf("insert v1 moment: %v", err)
	}
	if _, err := v1.Exec(
		`INSERT INTO buffer_messages (id, author_name, content, timestamp, updated_at) VALUES ('msg-1', 'Old User', ?, ?, ?)`,
		chatContent, stamp, stamp,
	); err != nil {
		t.Fatalf("insert v1 buffer_message: %v", err)
	}
	return v1
}

// writeV1Uploads creates a v1 uploads directory holding the given files and
// returns its path.
func writeV1Uploads(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir() + "/v1uploads"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir v1 uploads: %v", err)
	}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("file contents for "+name), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

// registerOwnerForMigration creates the owner account migrate attributes
// legacy content to.
func registerOwnerForMigration(t *testing.T) string {
	t.Helper()
	owner, err := auth.Register("owner", "password123", nil)
	if err != nil {
		t.Fatalf("register owner: %v", err)
	}
	return owner.ID
}

// TestMigrateAssets_CopiesFilesV1NeverRecorded is the core of the "old images
// don't work on the new server" report. v1's upload handler saved files to
// disk and never inserted an assets row, so a migration driven off that table
// found nothing to do and quietly left every file behind.
func TestMigrateAssets_CopiesFilesV1NeverRecorded(t *testing.T) {
	openV2Fixture(t)
	ownerID := registerOwnerForMigration(t)

	v1 := openV1AssetFixture(t, "no attachments here", "none here either")
	v1Uploads := writeV1Uploads(t, "1778966276_holiday.png", "1778966277_notes.pdf")
	v2Uploads := t.TempDir() + "/v2uploads"

	summary := migrationSummary{}
	assets, err := migrateAssets(v1, db.DB, v1Uploads, v2Uploads, ownerID, &summary)
	if err != nil {
		t.Fatalf("migrateAssets: %v", err)
	}
	if summary.assetsCopied != 2 {
		t.Fatalf("copied %d assets, want 2 (the v1 assets table is empty, as it is on a real server)", summary.assetsCopied)
	}

	rows, err := domain.ListAssets()
	if err != nil {
		t.Fatalf("list v2 assets: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("v2 has %d asset rows, want 2", len(rows))
	}
	for _, a := range rows {
		if a.UploaderID != ownerID {
			t.Errorf("asset %s uploader = %q, want the owner", a.FileName, a.UploaderID)
		}
		if a.SizeBytes == 0 {
			t.Errorf("asset %s has size 0", a.FileName)
		}
		if _, err := os.Stat(filepath.Join(v2Uploads, a.StoragePath)); err != nil {
			t.Errorf("asset %s not on disk at %s: %v", a.FileName, a.StoragePath, err)
		}
	}

	// The timestamp prefix v1 prepended is dropped for display.
	if got := assets["1778966276_holiday.png"].fileName; got != "holiday.png" {
		t.Errorf("display name = %q, want %q", got, "holiday.png")
	}
	if got := assets["1778966276_holiday.png"].mimeType; got != "image/png" {
		t.Errorf("mime type = %q, want image/png", got)
	}
}

// TestMigrateAssets_PrefersDeclaredFileNames covers the v1 databases that do
// have assets rows: their recorded file_name is a better display name than
// anything recoverable from the on-disk name.
func TestMigrateAssets_PrefersDeclaredFileNames(t *testing.T) {
	openV2Fixture(t)
	ownerID := registerOwnerForMigration(t)

	v1 := openV1AssetFixture(t, "x", "y")
	if _, err := v1.Exec(
		`INSERT INTO assets (id, file_name, local_uri) VALUES ('a-1', 'Holiday Photo.png', '/uploads/1778966276_holiday.png')`,
	); err != nil {
		t.Fatalf("insert v1 asset row: %v", err)
	}
	v1Uploads := writeV1Uploads(t, "1778966276_holiday.png")

	summary := migrationSummary{}
	assets, err := migrateAssets(v1, db.DB, v1Uploads, t.TempDir()+"/v2uploads", ownerID, &summary)
	if err != nil {
		t.Fatalf("migrateAssets: %v", err)
	}
	if got := assets["1778966276_holiday.png"].fileName; got != "Holiday Photo.png" {
		t.Errorf("display name = %q, want the name v1 recorded", got)
	}
}

// TestMigrateAssets_MissingUploadsDirIsNotFatal: an operator who never had any
// uploads should still be able to migrate everything else.
func TestMigrateAssets_MissingUploadsDirIsNotFatal(t *testing.T) {
	openV2Fixture(t)
	ownerID := registerOwnerForMigration(t)
	v1 := openV1AssetFixture(t, "x", "y")

	summary := migrationSummary{}
	assets, err := migrateAssets(v1, db.DB, t.TempDir()+"/does-not-exist", t.TempDir()+"/v2uploads", ownerID, &summary)
	if err != nil {
		t.Fatalf("migrateAssets with no uploads dir should not fail: %v", err)
	}
	if len(assets) != 0 || summary.assetsCopied != 0 {
		t.Errorf("expected no assets, got %d", len(assets))
	}
}

// TestMigrate_LegacyImageURLsResolveOnV2 is the end-to-end version: after
// migrating, the image reference in a legacy moment must point at a v2 asset
// that actually exists, using markdown syntax v2 renders as an image.
func TestMigrate_LegacyImageURLsResolveOnV2(t *testing.T) {
	openV2Fixture(t)
	ownerID := registerOwnerForMigration(t)

	momentContent := "Look at this:\n\nhttp://192.168.1.20:8080/uploads/1778966276_holiday.png \n\nnice trip"
	chatContent := "the notes: https://athena.example.com/uploads/1778966277_notes.pdf"
	v1 := openV1AssetFixture(t, momentContent, chatContent)
	v1Uploads := writeV1Uploads(t, "1778966276_holiday.png", "1778966277_notes.pdf")

	summary := migrationSummary{}
	assets, err := migrateAssets(v1, db.DB, v1Uploads, t.TempDir()+"/v2uploads", ownerID, &summary)
	if err != nil {
		t.Fatalf("migrateAssets: %v", err)
	}
	if err := migrateArchives(v1, db.DB, &summary); err != nil {
		t.Fatalf("migrateArchives: %v", err)
	}
	if err := migrateMoments(v1, db.DB, ownerID, assets, &summary); err != nil {
		t.Fatalf("migrateMoments: %v", err)
	}
	if err := migrateChatMessages(v1, db.DB, assets, &summary); err != nil {
		t.Fatalf("migrateChatMessages: %v", err)
	}
	if summary.urlsRewritten != 2 {
		t.Errorf("rewrote %d references, want 2", summary.urlsRewritten)
	}

	moment, err := domain.GetMoment("mom-1")
	if err != nil || moment == nil {
		t.Fatalf("get migrated moment: %v", err)
	}
	imageID := assets["1778966276_holiday.png"].id
	wantImage := "![holiday.png](/api/v1/assets/" + imageID + ")"
	if !strings.Contains(moment.Content, wantImage) {
		t.Errorf("moment content = %q\nwant it to contain %q", moment.Content, wantImage)
	}
	if strings.Contains(moment.Content, "/uploads/") {
		t.Errorf("moment content still points at a v1 upload URL: %q", moment.Content)
	}
	// The asset the rewritten URL names must actually be servable.
	if _, err := domain.GetAsset(imageID); err != nil {
		t.Errorf("rewritten URL names asset %s, which does not exist: %v", imageID, err)
	}

	msgs, err := domain.ListChatMessages(nil, 10)
	if err != nil {
		t.Fatalf("list chat: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 chat message, got %d", len(msgs))
	}
	// A PDF is not an image, so it becomes a named link, not an image embed.
	wantLink := "[notes.pdf](/api/v1/assets/" + assets["1778966277_notes.pdf"].id + ")"
	if !strings.Contains(msgs[0].Content, wantLink) {
		t.Errorf("chat content = %q\nwant it to contain %q", msgs[0].Content, wantLink)
	}
	if strings.Contains(msgs[0].Content, "![") {
		t.Errorf("a PDF should not be embedded as an image: %q", msgs[0].Content)
	}
}

func TestRewriteLegacyAssetURLs(t *testing.T) {
	assets := map[string]migratedAsset{
		"1778966276_holiday.png": {id: "img-id", fileName: "holiday.png", mimeType: "image/png"},
		"1778966277_notes.pdf":   {id: "pdf-id", fileName: "notes.pdf", mimeType: "application/pdf"},
		"odd name.png":           {id: "odd-id", fileName: "odd name.png", mimeType: "image/png"},
	}

	for _, tc := range []struct {
		name    string
		in      string
		want    string
		wantNum int
	}{
		{
			name:    "bare absolute url becomes an image embed",
			in:      "before http://host:8080/uploads/1778966276_holiday.png after",
			want:    "before ![holiday.png](/api/v1/assets/img-id) after",
			wantNum: 1,
		},
		{
			name:    "root-relative url is matched too",
			in:      "/uploads/1778966276_holiday.png",
			want:    "![holiday.png](/api/v1/assets/img-id)",
			wantNum: 1,
		},
		{
			name:    "non-image becomes a named link",
			in:      "https://host/uploads/1778966277_notes.pdf",
			want:    "[notes.pdf](/api/v1/assets/pdf-id)",
			wantNum: 1,
		},
		{
			name:    "existing markdown image keeps its syntax",
			in:      "![my caption](http://host/uploads/1778966276_holiday.png)",
			want:    "![my caption](/api/v1/assets/img-id)",
			wantNum: 1,
		},
		{
			name:    "existing markdown link keeps its syntax",
			in:      "[the notes](http://host/uploads/1778966277_notes.pdf)",
			want:    "[the notes](/api/v1/assets/pdf-id)",
			wantNum: 1,
		},
		{
			name:    "percent-encoded name resolves to the file on disk",
			in:      "http://host/uploads/odd%20name.png",
			want:    "![odd name.png](/api/v1/assets/odd-id)",
			wantNum: 1,
		},
		{
			name:    "several references in one body",
			in:      "http://host/uploads/1778966276_holiday.png and /uploads/1778966277_notes.pdf",
			want:    "![holiday.png](/api/v1/assets/img-id) and [notes.pdf](/api/v1/assets/pdf-id)",
			wantNum: 2,
		},
		{
			name:    "unknown file is left untouched rather than broken",
			in:      "http://host/uploads/never_migrated.png",
			want:    "http://host/uploads/never_migrated.png",
			wantNum: 0,
		},
		{
			name:    "unrelated content is untouched",
			in:      "read https://example.com/article and ![](https://cdn.example.com/x.png)",
			want:    "read https://example.com/article and ![](https://cdn.example.com/x.png)",
			wantNum: 0,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, n := rewriteLegacyAssetURLs(tc.in, assets)
			if got != tc.want {
				t.Errorf("got  %q\nwant %q", got, tc.want)
			}
			if n != tc.wantNum {
				t.Errorf("rewrote %d references, want %d", n, tc.wantNum)
			}
		})
	}
}

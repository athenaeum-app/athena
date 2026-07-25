package main

import (
	"database/sql"
	"flag"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/storage"
	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

// migrateCmd implements the `athena-server migrate` subcommand.
//
// It reads a v1 Athena database and uploads directory and writes the
// transformed data into a v2 database and uploads directory. The v1 schema
// is documented in ADR-0001 and the v1 source at Athena/athena-server/database.
//
// Usage:
//
//	athena-server migrate --v1-db=... --v1-uploads=... --v2-db=... --v2-uploads=...
//
// The command is one-shot: if the destination database already contains data
// it refuses to run, so it is safe to invoke repeatedly without risk of
// duplicating rows.
func migrateCmd(args []string) int {
	flagSet := flag.NewFlagSet("migrate", flag.ContinueOnError)
	v1DB := flagSet.String("v1-db", "", "path to the v1 SQLite database (athenaeum.db)")
	v1Uploads := flagSet.String("v1-uploads", "", "path to the v1 uploads directory")
	v2DB := flagSet.String("v2-db", "", "path to the v2 SQLite database to write")
	v2Uploads := flagSet.String("v2-uploads", "", "path to the v2 uploads directory to write")

	if err := flagSet.Parse(args); err != nil {
		return 2
	}

	for _, p := range []struct{ name, val string }{
		{"--v1-db", *v1DB},
		{"--v1-uploads", *v1Uploads},
		{"--v2-db", *v2DB},
		{"--v2-uploads", *v2Uploads},
	} {
		if p.val == "" {
			fmt.Fprintf(os.Stderr, "migrate: missing required flag %s\n", p.name)
			flagSet.Usage()
			return 2
		}
	}

	if err := runMigration(*v1DB, *v1Uploads, *v2DB, *v2Uploads); err != nil {
		fmt.Fprintf(os.Stderr, "migrate: %v\n", err)
		return 1
	}
	return 0
}

// runMigration performs the full v1 -> v2 migration.
func runMigration(v1DBPath, v1UploadsDir, v2DBPath, v2UploadsDir string) error {
	v1, err := sql.Open("sqlite", v1DBPath)
	if err != nil {
		return fmt.Errorf("open v1 database: %w", err)
	}
	defer v1.Close()
	if err := v1.Ping(); err != nil {
		return fmt.Errorf("ping v1 database: %w", err)
	}

	if err := db.Open(v2DBPath); err != nil {
		return fmt.Errorf("open v2 database: %w", err)
	}
	defer db.Close()
	v2 := db.DB

	// Refuse to migrate into a database that already holds data.
	occupied, err := v2HasMigratableContent(v2)
	if err != nil {
		return fmt.Errorf("check v2 occupancy: %w", err)
	}
	if occupied {
		return fmt.Errorf("v2 database already contains data, refusing to migrate")
	}

	// Legacy content is attributed to the server owner (see docs/GLOSSARY.md,
	// "Migration"), so the owner account must exist before migrating.
	ownerID, err := ownerUserID(v2)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(v2UploadsDir, 0o755); err != nil {
		return fmt.Errorf("create v2 uploads dir: %w", err)
	}

	summary := migrationSummary{}

	if err := migrateArchives(v1, v2, &summary); err != nil {
		return err
	}
	if err := migrateTags(v1, v2, &summary); err != nil {
		return err
	}
	// Assets go first now: moments and chat messages embed their files by URL,
	// and rewriting those URLs needs the v1-filename -> v2-asset-id mapping
	// this step produces.
	assets, err := migrateAssets(v1, v2, v1UploadsDir, v2UploadsDir, ownerID, &summary)
	if err != nil {
		return err
	}
	if err := migrateMoments(v1, v2, ownerID, assets, &summary); err != nil {
		return err
	}
	if err := migrateMomentTags(v1, v2, &summary); err != nil {
		return err
	}
	if err := migrateChatMessages(v1, v2, assets, &summary); err != nil {
		return err
	}

	printSummary(&summary)
	return nil
}

// migrationSummary tallies rows migrated per table plus asset stats.
type migrationSummary struct {
	archives      int
	tags          int
	moments       int
	momentTags    int
	chatMessages  int
	assetsCopied  int
	assetsSkipped int
	// urlsRewritten counts legacy /uploads/ references repointed at the v2
	// asset endpoint across moment and chat content.
	urlsRewritten int
}

// v1TimeFormats are the timestamp encodings migrate knows how to read from a
// v1 database. v1 timestamps are parsed into time.Time (rather than copied
// through as raw strings) so that migrated rows get written using the same
// on-disk text encoding the live v2 server uses for new rows: SQLite stores
// DATETIME columns as TEXT and ORDER BY on them is a byte-wise string
// compare, so mixing two different timestamp encodings in the same column
// silently breaks chronological ordering between legacy and new rows
// whenever they land on the same calendar date.
var v1TimeFormats = []string{
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02 15:04:05.999999999-07:00",
	"2006-01-02 15:04:05",
	"2006-01-02T15:04:05",
}

// parseV1Timestamp parses a timestamp string read from the v1 database into
// a time.Time in UTC, trying each of v1TimeFormats in turn.
func parseV1Timestamp(s string) (time.Time, error) {
	for _, f := range v1TimeFormats {
		if t, err := time.Parse(f, s); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognized v1 timestamp format: %q", s)
}

// v2HasMigratableContent reports whether the v2 database already holds content
// migrate would write. It checks every such table, not just archives: a v1
// server with chat and uploads but no archives would otherwise pass the guard
// and get its messages and files imported a second time on a re-run.
func v2HasMigratableContent(v2 *sql.DB) (bool, error) {
	for _, table := range []string{"archives", "moments", "chat_messages", "assets"} {
		var n int
		if err := v2.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
			return false, fmt.Errorf("count %s: %w", table, err)
		}
		if n > 0 {
			return true, nil
		}
	}
	return false, nil
}

// ownerUserID returns the id of the v2 server's owner account. Migration
// attributes legacy moments and assets to this account, so it must already
// exist (i.e. first-time setup must be completed before running migrate).
func ownerUserID(v2 *sql.DB) (string, error) {
	var id string
	err := v2.QueryRow(`SELECT id FROM users WHERE is_owner = 1 LIMIT 1`).Scan(&id)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("no owner account found in v2 database; complete first-time setup (register the owner user) before running migrate")
	}
	if err != nil {
		return "", fmt.Errorf("query owner user: %w", err)
	}
	return id, nil
}

// migrateArchives copies non-deleted v1 archives into v2.
func migrateArchives(v1, v2 *sql.DB, s *migrationSummary) error {
	rows, err := v1.Query(`SELECT id, name, created_at, updated_at FROM archives WHERE deleted = 0`)
	if err != nil {
		return fmt.Errorf("query v1 archives: %w", err)
	}
	defer rows.Close()

	tx, err := v2.Begin()
	if err != nil {
		return fmt.Errorf("begin archives tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.Prepare(`INSERT INTO archives (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare archives insert: %w", err)
	}
	defer stmt.Close()

	count := 0
	for rows.Next() {
		var id, name string
		var createdAtStr string
		var updatedAtStr sql.NullString
		if err := rows.Scan(&id, &name, &createdAtStr, &updatedAtStr); err != nil {
			return fmt.Errorf("scan archive: %w", err)
		}
		createdAt, err := parseV1Timestamp(createdAtStr)
		if err != nil {
			return fmt.Errorf("archive %s: %w", id, err)
		}
		updatedAt := createdAt
		if updatedAtStr.Valid && updatedAtStr.String != "" {
			if updatedAt, err = parseV1Timestamp(updatedAtStr.String); err != nil {
				return fmt.Errorf("archive %s: %w", id, err)
			}
		}
		if _, err := stmt.Exec(id, name, createdAt, updatedAt); err != nil {
			return fmt.Errorf("insert archive %s: %w", id, err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate archives: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit archives: %w", err)
	}

	s.archives = count
	fmt.Printf("Migrating archives... %d rows\n", count)
	return nil
}

// migrateTags copies non-deleted v1 tags into v2, renaming colour -> color.
// v1 tags have no created_at, so updated_at is used for both v2 timestamps.
func migrateTags(v1, v2 *sql.DB, s *migrationSummary) error {
	rows, err := v1.Query(`SELECT id, name, colour, updated_at FROM tags WHERE deleted = 0`)
	if err != nil {
		return fmt.Errorf("query v1 tags: %w", err)
	}
	defer rows.Close()

	tx, err := v2.Begin()
	if err != nil {
		return fmt.Errorf("begin tags tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.Prepare(`INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare tags insert: %w", err)
	}
	defer stmt.Close()

	count := 0
	for rows.Next() {
		var id, name, colour string
		var updatedAtStr sql.NullString
		if err := rows.Scan(&id, &name, &colour, &updatedAtStr); err != nil {
			return fmt.Errorf("scan tag: %w", err)
		}
		now := time.Now().UTC()
		if updatedAtStr.Valid && updatedAtStr.String != "" {
			var err error
			if now, err = parseV1Timestamp(updatedAtStr.String); err != nil {
				return fmt.Errorf("tag %s: %w", id, err)
			}
		}
		if _, err := stmt.Exec(id, name, colour, now, now); err != nil {
			return fmt.Errorf("insert tag %s: %w", id, err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate tags: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tags: %w", err)
	}

	s.tags = count
	fmt.Printf("Migrating tags... %d rows\n", count)
	return nil
}

// migrateMoments copies non-deleted v1 moments into v2, attributed to the
// owner account, with is_legacy = 1. timestamp is used for both v2 timestamp
// and created_at. Embedded v1 upload URLs are repointed at the v2 asset
// endpoint using the map from migrateAssets.
func migrateMoments(v1, v2 *sql.DB, ownerID string, assets map[string]migratedAsset, s *migrationSummary) error {
	rows, err := v1.Query(`SELECT id, archive_id, title, content, timestamp, updated_at FROM moments WHERE deleted = 0`)
	if err != nil {
		return fmt.Errorf("query v1 moments: %w", err)
	}
	defer rows.Close()

	tx, err := v2.Begin()
	if err != nil {
		return fmt.Errorf("begin moments tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.Prepare(`INSERT INTO moments (id, archive_id, author_id, title, content, timestamp, is_legacy, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare moments insert: %w", err)
	}
	defer stmt.Close()

	count := 0
	for rows.Next() {
		var id, archiveID, title, content, timestampStr string
		var updatedAtStr sql.NullString
		if err := rows.Scan(&id, &archiveID, &title, &content, &timestampStr, &updatedAtStr); err != nil {
			return fmt.Errorf("scan moment: %w", err)
		}
		timestamp, err := parseV1Timestamp(timestampStr)
		if err != nil {
			return fmt.Errorf("moment %s: %w", id, err)
		}
		updated := timestamp
		if updatedAtStr.Valid && updatedAtStr.String != "" {
			if updated, err = parseV1Timestamp(updatedAtStr.String); err != nil {
				return fmt.Errorf("moment %s: %w", id, err)
			}
		}
		content, rewritten := rewriteLegacyAssetURLs(content, assets)
		s.urlsRewritten += rewritten
		if _, err := stmt.Exec(id, archiveID, ownerID, title, content, timestamp, timestamp, updated); err != nil {
			return fmt.Errorf("insert moment %s: %w", id, err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate moments: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit moments: %w", err)
	}

	s.moments = count
	fmt.Printf("Migrating moments... %d rows\n", count)
	return nil
}

// migrateMomentTags copies moment/tag links for moments that survived the
// migration filter. We re-check deleted=0 on both sides to avoid inserting
// dangling links for soft-deleted moments or tags.
func migrateMomentTags(v1, v2 *sql.DB, s *migrationSummary) error {
	rows, err := v1.Query(`
		SELECT mt.moment_id, mt.tag_id
		FROM moment_tags mt
		JOIN moments m ON m.id = mt.moment_id AND m.deleted = 0
		JOIN tags t ON t.id = mt.tag_id AND t.deleted = 0`)
	if err != nil {
		return fmt.Errorf("query v1 moment_tags: %w", err)
	}
	defer rows.Close()

	tx, err := v2.Begin()
	if err != nil {
		return fmt.Errorf("begin moment_tags tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.Prepare(`INSERT OR IGNORE INTO moment_tags (moment_id, tag_id) VALUES (?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare moment_tags insert: %w", err)
	}
	defer stmt.Close()

	count := 0
	for rows.Next() {
		var momentID, tagID string
		if err := rows.Scan(&momentID, &tagID); err != nil {
			return fmt.Errorf("scan moment_tag: %w", err)
		}
		if _, err := stmt.Exec(momentID, tagID); err != nil {
			return fmt.Errorf("insert moment_tag %s/%s: %w", momentID, tagID, err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate moment_tags: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit moment_tags: %w", err)
	}

	s.momentTags = count
	fmt.Printf("Migrating moment_tags... %d rows\n", count)
	return nil
}

// migrateChatMessages copies non-deleted v1 buffer_messages into v2
// chat_messages with author_id NULL, display_name = author_name, is_legacy = 1.
// Embedded v1 upload URLs are repointed the same way as in moments.
func migrateChatMessages(v1, v2 *sql.DB, assets map[string]migratedAsset, s *migrationSummary) error {
	rows, err := v1.Query(`SELECT id, author_name, content, timestamp, updated_at FROM buffer_messages WHERE deleted = 0`)
	if err != nil {
		return fmt.Errorf("query v1 buffer_messages: %w", err)
	}
	defer rows.Close()

	tx, err := v2.Begin()
	if err != nil {
		return fmt.Errorf("begin chat_messages tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.Prepare(`INSERT INTO chat_messages (id, author_id, display_name, content, is_legacy, deleted_at, created_at, updated_at) VALUES (?, NULL, ?, ?, 1, NULL, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare chat_messages insert: %w", err)
	}
	defer stmt.Close()

	count := 0
	for rows.Next() {
		var id, authorName, content, timestampStr string
		var updatedAtStr string
		if err := rows.Scan(&id, &authorName, &content, &timestampStr, &updatedAtStr); err != nil {
			return fmt.Errorf("scan buffer_message: %w", err)
		}
		timestamp, err := parseV1Timestamp(timestampStr)
		if err != nil {
			return fmt.Errorf("chat_message %s: %w", id, err)
		}
		updated := timestamp
		if updatedAtStr != "" {
			if updated, err = parseV1Timestamp(updatedAtStr); err != nil {
				return fmt.Errorf("chat_message %s: %w", id, err)
			}
		}
		content, rewritten := rewriteLegacyAssetURLs(content, assets)
		s.urlsRewritten += rewritten
		if _, err := stmt.Exec(id, authorName, content, timestamp, updated); err != nil {
			return fmt.Errorf("insert chat_message %s: %w", id, err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate buffer_messages: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit chat_messages: %w", err)
	}

	s.chatMessages = count
	fmt.Printf("Migrating chat_messages... %d rows\n", count)
	return nil
}

// migratedAsset is the v2 identity of a file that came from v1, keyed during
// migration by the name it had on disk in the v1 uploads directory.
type migratedAsset struct {
	id       string // v2 assets.id, which is what the v2 URL is built from
	fileName string // display name, used as markdown link text / alt text
	mimeType string
}

// v1AssetFileNames reads the v1 assets table for display names, keyed by the
// file's name on disk (the last segment of local_uri).
//
// It is best-effort on purpose. v1 created this table but its upload handler
// never wrote to it: files were saved straight into data/uploads and the URL
// was embedded in the content. So on a real v1 database this returns nothing
// and the uploads directory is the only record that a file ever existed. The
// lookup is still done because a v1 database that *does* have rows carries
// better display names than the on-disk ones.
func v1AssetFileNames(v1 *sql.DB) map[string]string {
	names := map[string]string{}
	rows, err := v1.Query(`SELECT file_name, local_uri FROM assets`)
	if err != nil {
		return names
	}
	defer rows.Close()
	for rows.Next() {
		var fileName, localURI string
		if err := rows.Scan(&fileName, &localURI); err != nil {
			return names
		}
		diskName := localURI
		if idx := strings.LastIndex(localURI, "/"); idx >= 0 {
			diskName = localURI[idx+1:]
		}
		if diskName != "" {
			names[diskName] = fileName
		}
	}
	return names
}

// v1DiskNamePrefix matches the "<unix seconds>_" prefix v1's upload handler
// prepended to every sanitized filename.
var v1DiskNamePrefix = regexp.MustCompile(`^[0-9]{9,}_`)

// displayNameForDiskFile recovers something presentable from a v1 on-disk
// filename by dropping the upload timestamp prefix. Falls back to the disk
// name when it doesn't have one.
func displayNameForDiskFile(diskName string) string {
	trimmed := v1DiskNamePrefix.ReplaceAllString(diskName, "")
	if trimmed == "" || trimmed == filepath.Ext(diskName) {
		return diskName
	}
	return trimmed
}

// migrateAssets copies v1 upload files into the v2 uploads directory and
// creates v2 assets rows for them, attributed to the owner account
// (uploader_id is NOT NULL with a foreign key to users). It returns the
// v1-disk-name -> v2-asset map that content rewriting needs.
//
// The uploads directory, not the v1 assets table, is what gets walked. v1
// never populated that table, so driving from it migrated exactly zero files
// on every real server. The files stayed behind and every image in the
// library pointed at a v1 URL v2 doesn't serve.
func migrateAssets(v1, v2 *sql.DB, v1UploadsDir, v2UploadsDir, ownerID string, s *migrationSummary) (map[string]migratedAsset, error) {
	assets := map[string]migratedAsset{}

	entries, err := os.ReadDir(v1UploadsDir)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("warning: v1 uploads directory does not exist, no files migrated: %s", v1UploadsDir)
			fmt.Printf("Migrating assets... 0 copied, 0 skipped\n")
			return assets, nil
		}
		return nil, fmt.Errorf("read v1 uploads dir: %w", err)
	}

	declaredNames := v1AssetFileNames(v1)

	if err := os.MkdirAll(v2UploadsDir, 0o755); err != nil {
		return nil, fmt.Errorf("create v2 uploads dir: %w", err)
	}

	tx, err := v2.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin assets tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.Prepare(`INSERT INTO assets (id, uploader_id, file_name, mime_type, size_bytes, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return nil, fmt.Errorf("prepare assets insert: %w", err)
	}
	defer stmt.Close()

	copied := 0
	skipped := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		diskName := entry.Name()
		info, err := entry.Info()
		if err != nil {
			log.Printf("warning: cannot stat upload %s, skipping: %v", diskName, err)
			skipped++
			continue
		}

		fileName := declaredNames[diskName]
		if fileName == "" {
			fileName = displayNameForDiskFile(diskName)
		}

		ext := filepath.Ext(diskName)
		mimeType := storage.MimeTypeForName(diskName)

		newID := uuid.NewString()
		newName := newID + ext
		if err := copyFile(filepath.Join(v1UploadsDir, diskName), filepath.Join(v2UploadsDir, newName)); err != nil {
			return nil, fmt.Errorf("copy asset %s: %w", diskName, err)
		}

		created := info.ModTime().UTC().Format(time.RFC3339)
		if _, err := stmt.Exec(newID, ownerID, fileName, mimeType, info.Size(), newName, created); err != nil {
			return nil, fmt.Errorf("insert asset %s: %w", diskName, err)
		}
		assets[diskName] = migratedAsset{id: newID, fileName: fileName, mimeType: mimeType}
		copied++
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit assets: %w", err)
	}

	s.assetsCopied = copied
	s.assetsSkipped = skipped
	fmt.Printf("Migrating assets... %d copied, %d skipped\n", copied, skipped)
	return assets, nil
}

// v1UploadRef matches a reference to a v1-served upload inside moment or chat
// content: an optional scheme+host, then "/uploads/<filename>". v1's client
// stored these as absolute URLs against whatever address the old server was
// reachable at, so the host is whatever the user had configured and only the
// trailing path is dependable. Capture group 1 is the filename.
var v1UploadRef = regexp.MustCompile(`(?:[a-zA-Z][a-zA-Z0-9+.\-]*://[^\s)"'<>]*?)?/uploads/([^\s)"'<>\]]+)`)

// rewriteLegacyAssetURLs repoints v1 upload references at the v2 asset
// endpoint, returning the new content and how many references it changed.
//
// v1 embedded a bare URL and rendered any bare media link as an attachment.
// v2 renders content as markdown and only shows an image for markdown image
// syntax, so a bare URL carried across verbatim would render as a link at
// best. References already sitting in a markdown destination keep their
// syntax and only have the URL swapped; bare ones are wrapped, as an image
// when the file is one and a named link otherwise.
//
// A reference whose file isn't in the map (deleted from disk before the
// migration, or hosted somewhere else entirely) is left exactly as it was:
// rewriting it to a v2 URL would turn a dead link into a broken image.
func rewriteLegacyAssetURLs(content string, assets map[string]migratedAsset) (string, int) {
	matches := v1UploadRef.FindAllStringSubmatchIndex(content, -1)
	if len(matches) == 0 {
		return content, 0
	}

	var b strings.Builder
	last := 0
	rewritten := 0
	for _, m := range matches {
		start, end := m[0], m[1]
		name := content[m[2]:m[3]]
		asset, ok := lookupAsset(assets, name)
		if !ok {
			continue
		}

		b.WriteString(content[last:start])
		url := "/api/v1/assets/" + asset.id
		switch {
		case isMarkdownDestination(content, start):
			b.WriteString(url)
		case strings.HasPrefix(asset.mimeType, "image/"):
			b.WriteString("![" + markdownLabel(asset.fileName) + "](" + url + ")")
		default:
			b.WriteString("[" + markdownLabel(asset.fileName) + "](" + url + ")")
		}
		last = end
		rewritten++
	}
	b.WriteString(content[last:])
	return b.String(), rewritten
}

// lookupAsset resolves a filename from content against the migrated files,
// retrying percent-decoded since a URL in content may be escaped while the
// name on disk is not.
func lookupAsset(assets map[string]migratedAsset, name string) (migratedAsset, bool) {
	if a, ok := assets[name]; ok {
		return a, true
	}
	if decoded, err := url.PathUnescape(name); err == nil && decoded != name {
		if a, ok := assets[decoded]; ok {
			return a, true
		}
	}
	return migratedAsset{}, false
}

// isMarkdownDestination reports whether the reference starting at idx is
// already the destination of a markdown link or image, i.e. preceded by "](".
func isMarkdownDestination(content string, idx int) bool {
	i := idx - 1
	for i >= 0 && (content[i] == ' ' || content[i] == '\t') {
		i--
	}
	if i < 0 || content[i] != '(' {
		return false
	}
	return i > 0 && content[i-1] == ']'
}

// markdownLabel makes a filename safe to drop into a markdown link label.
func markdownLabel(name string) string {
	replacer := strings.NewReplacer("[", "", "]", "", "\n", " ", "\replacer", "")
	label := strings.TrimSpace(replacer.Replace(name))
	if label == "" {
		return "attachment"
	}
	return label
}

// copyFile copies src to dst, creating dst with the same permissions as src.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close() //nolint:errcheck

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

// printSummary writes the final migration report to stdout.
func printSummary(s *migrationSummary) {
	fmt.Println()
	fmt.Println("Migration summary:")
	fmt.Printf("  archives:      %d\n", s.archives)
	fmt.Printf("  tags:          %d\n", s.tags)
	fmt.Printf("  moments:       %d\n", s.moments)
	fmt.Printf("  moment_tags:   %d\n", s.momentTags)
	fmt.Printf("  chat_messages: %d\n", s.chatMessages)
	fmt.Printf("  assets:        %d copied, %d skipped\n", s.assetsCopied, s.assetsSkipped)
	fmt.Printf("  asset links:   %d rewritten\n", s.urlsRewritten)
	fmt.Println("Migration complete.")
}

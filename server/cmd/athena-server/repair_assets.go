package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/storage"
	"github.com/google/uuid"
)

// repairAssetsCmd implements the `athena-server repair-legacy-assets`
// subcommand.
//
// Before 2026-07-24, `migrate` looked for uploaded files in v1's `assets`
// table. v1 created that table but never wrote to it. Its upload handler
// saved files to data/uploads/ and returned a URL the client embedded in the
// content, so the query matched nothing, no file was copied, and every
// legacy image in the migrated library pointed at a /uploads/ path v2 does not
// serve.
//
// `migrate` is fixed, but re-running it is not an option for a server that has
// been live since: it refuses to write into a populated database, and starting
// over would discard everything created natively in v2. This command repairs
// such a library in place instead, importing the files its content still
// refers to and repointing those references at the v2 asset endpoint.
//
// It is safe to run repeatedly. Only files named by a surviving /uploads/
// reference are imported, so once a library is repaired there is nothing left
// to match and a second run is a no-op. Stop the server (or at least stop
// writes) before running it.
func repairAssetsCmd(args []string) int {
	flagSet := flag.NewFlagSet("repair-legacy-assets", flag.ContinueOnError)
	dbPath := flagSet.String("db", "", "path to the v2 SQLite database to repair")
	v2Uploads := flagSet.String("uploads", "", "path to the v2 uploads directory to import into")
	v1Uploads := flagSet.String("v1-uploads", "", "path to the original v1 uploads directory to import from")
	dryRun := flagSet.Bool("dry-run", false, "report what would change without writing anything")

	if err := flagSet.Parse(args); err != nil {
		return 2
	}
	for _, p := range []struct{ name, val string }{
		{"--db", *dbPath},
		{"--uploads", *v2Uploads},
		{"--v1-uploads", *v1Uploads},
	} {
		if p.val == "" {
			fmt.Fprintf(os.Stderr, "repair-legacy-assets: missing required flag %s\n", p.name)
			flagSet.Usage()
			return 2
		}
	}

	if err := db.Open(*dbPath); err != nil {
		fmt.Fprintf(os.Stderr, "repair-legacy-assets: open database: %v\n", err)
		return 1
	}
	defer db.Close()

	if err := runRepairAssets(db.DB, *v1Uploads, *v2Uploads, *dryRun); err != nil {
		fmt.Fprintf(os.Stderr, "repair-legacy-assets: %v\n", err)
		return 1
	}
	return 0
}

// contentTable is one table whose content column can hold legacy references.
type contentTable struct {
	name  string
	idCol string
}

var legacyContentTables = []contentTable{
	{"moments", "id"},
	{"chat_messages", "id"},
}

// repairAssetsReport tallies what a repair run found and changed.
type repairAssetsReport struct {
	referenced    int // distinct v1 filenames named by surviving references
	imported      int // files copied into v2 and given an asset row
	missing       int // referenced but not present in the v1 uploads directory
	unreferenced  int // files in the v1 uploads directory nothing points at
	rowsRewritten int
	refsRewritten int
}

// runRepairAssets imports the v1 files the library still refers to and
// rewrites those references, in a single transaction.
func runRepairAssets(dbConn *sql.DB, v1UploadsDir, v2UploadsDir string, dryRun bool) error {
	ownerID, err := ownerUserID(dbConn)
	if err != nil {
		return err
	}

	// Which legacy files does the content actually still point at?
	referenced, err := collectLegacyRefs(dbConn)
	if err != nil {
		return err
	}
	report := repairAssetsReport{referenced: len(referenced)}
	if len(referenced) == 0 {
		fmt.Println("No legacy /uploads/ references found: nothing to repair.")
		return nil
	}

	onDisk, err := indexUploadsDir(v1UploadsDir)
	if err != nil {
		return err
	}

	names := make([]string, 0, len(referenced))
	for name := range referenced {
		names = append(names, name)
	}
	sort.Strings(names)

	tx, err := dbConn.Begin()
	if err != nil {
		return fmt.Errorf("begin repair tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// Import each referenced file, building the map the rewrite needs. The map
	// is keyed by the name as it appears in the content, which is what
	// rewriteLegacyAssetURLs looks up.
	assets := map[string]migratedAsset{}
	imported := map[string]bool{}
	for _, name := range names {
		diskName, ok := resolveDiskName(onDisk, name)
		if !ok {
			log.Printf("repair-legacy-assets: %q is referenced but not in %s, leaving its references unchanged", name, v1UploadsDir)
			report.missing++
			continue
		}
		// Two references can spell the same file differently (one escaped,
		// one not); import it once and point both at the same asset.
		if existing, done := assets[diskName]; done {
			assets[name] = existing
			continue
		}
		asset, err := importLegacyFile(tx, v1UploadsDir, v2UploadsDir, diskName, ownerID, dryRun)
		if err != nil {
			return err
		}
		assets[name] = asset
		assets[diskName] = asset
		imported[diskName] = true
		report.imported++
	}
	report.unreferenced = len(onDisk) - len(imported) - report.missing
	if report.unreferenced < 0 {
		report.unreferenced = 0
	}

	if len(assets) == 0 {
		fmt.Println("None of the referenced files are present in the v1 uploads directory: nothing to repair.")
		return nil
	}

	for _, table := range legacyContentTables {
		rows, refs, err := rewriteTableContent(tx, table, assets, dryRun)
		if err != nil {
			return fmt.Errorf("rewrite %s: %w", table.name, err)
		}
		fmt.Printf("%s: %d rows rewritten, %d references repointed\n", table.name, rows, refs)
		report.rowsRewritten += rows
		report.refsRewritten += refs
	}

	if dryRun {
		printRepairAssetsReport(&report, true)
		return nil
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit repair tx: %w", err)
	}
	printRepairAssetsReport(&report, false)
	return nil
}

// collectLegacyRefs scans every content column for surviving v1 upload
// references and returns the set of filenames they name.
func collectLegacyRefs(dbConn *sql.DB) (map[string]bool, error) {
	refs := map[string]bool{}
	for _, table := range legacyContentTables {
		rows, err := dbConn.Query(fmt.Sprintf(`SELECT content FROM %s WHERE content LIKE '%%/uploads/%%'`, table.name))
		if err != nil {
			return nil, fmt.Errorf("scan %s for legacy references: %w", table.name, err)
		}
		for rows.Next() {
			var content string
			if err := rows.Scan(&content); err != nil {
				rows.Close()
				return nil, fmt.Errorf("scan %s content: %w", table.name, err)
			}
			for _, name := range legacyRefNames(content) {
				refs[name] = true
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return refs, nil
}

// legacyRefNames returns the v1 upload filenames referenced in one body of
// content, using the same pattern the migration rewrite matches on.
func legacyRefNames(content string) []string {
	matches := v1UploadRef.FindAllStringSubmatch(content, -1)
	names := make([]string, 0, len(matches))
	for _, m := range matches {
		names = append(names, m[1])
	}
	return names
}

// indexUploadsDir returns the set of filenames in the v1 uploads directory.
func indexUploadsDir(dir string) (map[string]bool, error) {
	index := map[string]bool{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("v1 uploads directory does not exist: %s", dir)
		}
		return nil, fmt.Errorf("read v1 uploads dir: %w", err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			index[e.Name()] = true
		}
	}
	return index, nil
}

// resolveDiskName matches a filename as written in content against the files
// on disk, retrying percent-decoded since a URL may be escaped while the name
// on disk is not.
func resolveDiskName(onDisk map[string]bool, name string) (string, bool) {
	if onDisk[name] {
		return name, true
	}
	if decoded, err := url.PathUnescape(name); err == nil && onDisk[decoded] {
		return decoded, true
	}
	return "", false
}

// importLegacyFile copies one v1 upload into the v2 uploads directory under a
// fresh UUID and records the matching assets row.
func importLegacyFile(tx *sql.Tx, v1UploadsDir, v2UploadsDir, diskName, ownerID string, dryRun bool) (migratedAsset, error) {
	info, err := os.Stat(filepath.Join(v1UploadsDir, diskName))
	if err != nil {
		return migratedAsset{}, fmt.Errorf("stat %s: %w", diskName, err)
	}

	ext := filepath.Ext(diskName)
	asset := migratedAsset{
		id:       uuid.NewString(),
		fileName: displayNameForDiskFile(diskName),
		mimeType: storage.MimeTypeForName(diskName),
	}
	if dryRun {
		return asset, nil
	}

	if err := os.MkdirAll(v2UploadsDir, 0o755); err != nil {
		return migratedAsset{}, fmt.Errorf("create v2 uploads dir: %w", err)
	}
	storageName := asset.id + ext
	if err := copyFile(filepath.Join(v1UploadsDir, diskName), filepath.Join(v2UploadsDir, storageName)); err != nil {
		return migratedAsset{}, fmt.Errorf("copy %s: %w", diskName, err)
	}
	if _, err := tx.Exec(
		`INSERT INTO assets (id, uploader_id, file_name, mime_type, size_bytes, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		asset.id, ownerID, asset.fileName, asset.mimeType, info.Size(), storageName, info.ModTime().UTC().Format(time.RFC3339),
	); err != nil {
		return migratedAsset{}, fmt.Errorf("insert asset for %s: %w", diskName, err)
	}
	return asset, nil
}

// rewriteTableContent repoints the legacy references in one table's content
// column, touching only rows that actually change.
func rewriteTableContent(tx *sql.Tx, table contentTable, assets map[string]migratedAsset, dryRun bool) (rowsChanged, refsChanged int, err error) {
	rows, err := tx.Query(fmt.Sprintf(`SELECT %s, content FROM %s WHERE content LIKE '%%/uploads/%%'`, table.idCol, table.name))
	if err != nil {
		return 0, 0, fmt.Errorf("query: %w", err)
	}

	type update struct {
		id      string
		content string
	}
	var updates []update
	for rows.Next() {
		var id, content string
		if err := rows.Scan(&id, &content); err != nil {
			rows.Close()
			return 0, 0, fmt.Errorf("scan: %w", err)
		}
		rewritten, n := rewriteLegacyAssetURLs(content, assets)
		if n == 0 {
			continue
		}
		updates = append(updates, update{id: id, content: rewritten})
		refsChanged += n
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, 0, err
	}
	rows.Close()

	if dryRun {
		return len(updates), refsChanged, nil
	}

	stmt, err := tx.Prepare(fmt.Sprintf(`UPDATE %s SET content = ? WHERE %s = ?`, table.name, table.idCol))
	if err != nil {
		return 0, 0, fmt.Errorf("prepare update: %w", err)
	}
	defer stmt.Close()
	for _, u := range updates {
		if _, err := stmt.Exec(u.content, u.id); err != nil {
			return 0, 0, fmt.Errorf("update id=%s: %w", u.id, err)
		}
		rowsChanged++
	}
	return rowsChanged, refsChanged, nil
}

func printRepairAssetsReport(r *repairAssetsReport, dryRun bool) {
	fmt.Println()
	if dryRun {
		fmt.Println("Dry run, nothing written. Would have:")
	} else {
		fmt.Println("Repair complete:")
	}
	fmt.Printf("  files referenced:   %d\n", r.referenced)
	fmt.Printf("  files imported:     %d\n", r.imported)
	fmt.Printf("  files missing:      %d (references left unchanged)\n", r.missing)
	fmt.Printf("  files unreferenced: %d (left in v1, nothing points at them)\n", r.unreferenced)
	fmt.Printf("  rows rewritten:     %d\n", r.rowsRewritten)
	fmt.Printf("  references fixed:   %d\n", r.refsRewritten)
}

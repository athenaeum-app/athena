package sync

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	stdsync "sync"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
)

// BackupInfo describes a single backup file for the backups GUI.
type BackupInfo struct {
	Name      string    `json:"name"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}

// BackupDir returns the backups directory derived from the live DB path
// (a `backups` sibling of the DB's parent), matching the worker's layout.
func BackupDir(dbPath string) string {
	return filepath.Join(filepath.Dir(dbPath), "backups")
}

// ListBackups returns the backups on disk, newest first.
func ListBackups(dbPath string) ([]BackupInfo, error) {
	dir := BackupDir(dbPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []BackupInfo{}, nil
		}
		return nil, fmt.Errorf("read backups dir: %w", err)
	}
	out := []BackupInfo{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".db") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, BackupInfo{Name: e.Name(), SizeBytes: info.Size(), CreatedAt: info.ModTime()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// CreateBackupNow takes an on-demand VACUUM INTO snapshot and returns its
// info. Unlike the worker, it does not trim old backups (manual backups are
// assumed intentional).
func CreateBackupNow(dbPath string) (*BackupInfo, error) {
	dir := BackupDir(dbPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create backups dir: %w", err)
	}
	timestamp := time.Now().Format("2006-01-02_15-04-05")
	name := fmt.Sprintf("athenaeum_%s.db", timestamp)
	dest := filepath.Join(dir, name)
	if _, err := db.DB.Exec(fmt.Sprintf("VACUUM INTO '%s';", dest)); err != nil {
		return nil, fmt.Errorf("vacuum into %s: %w", dest, err)
	}
	info, err := os.Stat(dest)
	if err != nil {
		return nil, err
	}
	return &BackupInfo{Name: name, SizeBytes: info.Size(), CreatedAt: info.ModTime()}, nil
}

// BackupFilePath resolves a backup name to its on-disk path, rejecting any
// name that escapes the backups directory (path traversal guard).
func BackupFilePath(dbPath, name string) (string, error) {
	if name == "" || strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return "", fmt.Errorf("invalid backup name")
	}
	return filepath.Join(BackupDir(dbPath), name), nil
}

// restoreMarkerPath is the sentinel file that requests a restore-on-startup.
func restoreMarkerPath(dbPath string) string {
	return filepath.Join(filepath.Dir(dbPath), "RESTORE_PENDING")
}

// sqliteHeaderMagic is the fixed 16-byte magic string every valid SQLite
// database file begins with.
const sqliteHeaderMagic = "SQLite format 3\x00"

// validSQLiteFile rejects anything that isn't a real SQLite database, so a
// corrupt, truncated, or unrelated file can't be staged (or applied) as a
// restore target.
func validSQLiteFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	header := make([]byte, len(sqliteHeaderMagic))
	if _, err := io.ReadFull(f, header); err != nil {
		return fmt.Errorf("not a valid SQLite database file")
	}
	if string(header) != sqliteHeaderMagic {
		return fmt.Errorf("not a valid SQLite database file")
	}
	return nil
}

// RequestRestore validates the named backup and stages it for restore. The
// swap happens on next startup (ApplyPendingRestore) because SQLite cannot
// safely overwrite an open database file. Returns nil on success; the caller
// should tell the user to restart the server.
func RequestRestore(dbPath, name string) error {
	path, err := BackupFilePath(dbPath, name)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("backup not found: %w", err)
	}
	if err := validSQLiteFile(path); err != nil {
		return err
	}
	if err := os.WriteFile(restoreMarkerPath(dbPath), []byte(path), 0o644); err != nil {
		return fmt.Errorf("stage restore: %w", err)
	}
	return nil
}

// ApplyPendingRestore checks for a staged restore and, if present, swaps the
// chosen backup in over the live database (removing stale -wal/-shm
// sidecars) before the DB is opened. Call this once at startup, before
// db.Open. It is a no-op when no restore is pending.
func ApplyPendingRestore(dbPath string) error {
	marker := restoreMarkerPath(dbPath)
	data, err := os.ReadFile(marker)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read restore marker: %w", err)
	}
	src := strings.TrimSpace(string(data))
	if src == "" {
		os.Remove(marker)
		return nil
	}
	// Re-validate at apply time too. Time has passed since staging, and this
	// is the point of no return for the live DB.
	if err := validSQLiteFile(src); err != nil {
		os.Remove(marker)
		return fmt.Errorf("staged restore file is no longer valid, aborting: %w", err)
	}
	log.Printf("Applying staged restore from %s", src)
	// Copy into a temp file in the same directory as dbPath, then swap it in
	// with an atomic rename. dbPath itself is never opened/truncated until
	// the copy has fully succeeded and been fsync'd, so a failure partway
	// through (disk full, crash, etc.) leaves the live DB untouched instead
	// of half-overwritten.
	tmp := dbPath + ".restoring"
	if err := copyFile(src, tmp); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("restore copy: %w", err)
	}
	if err := os.Rename(tmp, dbPath); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("restore swap: %w", err)
	}
	// Remove WAL/SHM sidecars so the restored DB is authoritative.
	os.Remove(dbPath + "-wal")
	os.Remove(dbPath + "-shm")
	if err := os.Remove(marker); err != nil {
		log.Printf("Failed to clear restore marker: %v", err)
	}
	log.Println("Restore applied")
	return nil
}

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
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

// backupRetention is the number of backups to keep. It is set by the backup
// worker so attemptBackup can reach it without taking it as a parameter (the
// v1 attemptBackup signature only accepted a path).
var backupRetention = 7

// backupCtl is the package-level controller for the (at most one) running
// backup worker. It lets the settings API stop and restart the worker with new
// interval/retention values without a full server restart.
var backupCtl struct {
	mu   stdsync.Mutex
	stop chan struct{} // closed to signal the current worker goroutine to exit
}

// StartBackupWorker launches (or replaces) the background worker that
// periodically snapshots the database via VACUUM INTO and retains the last
// `retention` backups. Backups are written to
// ./data/backups/athenaeum_YYYY-MM-DD_HH-MM-SS.db. If interval is 0 the worker
// is stopped/left stopped (backups disabled). Calling it again restarts the
// worker with the new settings; it is safe to call concurrently.
//
// dbPath is the live database path; the backup directory is derived as a
// `backups` sibling of dbPath's parent (matching v1's ./data/backups).
func StartBackupWorker(interval time.Duration, retention int, dbPath string) {
	backupCtl.mu.Lock()
	defer backupCtl.mu.Unlock()

	// Stop any worker already running.
	if backupCtl.stop != nil {
		close(backupCtl.stop)
		backupCtl.stop = nil
	}

	backupRetention = retention

	if interval <= 0 {
		log.Println("Backup interval is 0; automated backups disabled.")
		return
	}

	backupDir := filepath.Join(filepath.Dir(dbPath), "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		log.Println("Failed to create backup directory:", err)
		return
	}

	log.Printf("Automated backups will occur every %s, keeping the last %d in %s", interval, retention, backupDir)

	stop := make(chan struct{})
	backupCtl.stop = stop

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				if err := attemptBackup(backupDir); err != nil {
					log.Println("Backup failed:", err)
				}
			case <-stop:
				return
			}
		}
	}()
}

// StopBackupWorker stops the running backup worker, if any. Safe to call when
// no worker is running.
func StopBackupWorker() {
	backupCtl.mu.Lock()
	defer backupCtl.mu.Unlock()
	if backupCtl.stop != nil {
		close(backupCtl.stop)
		backupCtl.stop = nil
	}
}

// attemptBackup runs a single VACUUM INTO snapshot into the given backup
// directory and then trims old backups. The filename is timestamped to the
// second so backups taken at least a second apart never collide.
//
// VACUUM INTO cannot be parameterized; the path is built from a trusted
// timestamp, not user input.
func attemptBackup(backupDir string) error {
	timestamp := time.Now().Format("2006-01-02_15-04-05")
	backupPath := filepath.Join(backupDir, fmt.Sprintf("athenaeum_%s.db", timestamp))

	query := fmt.Sprintf("VACUUM INTO '%s';", backupPath)
	if _, err := db.DB.Exec(query); err != nil {
		return fmt.Errorf("vacuum into %s: %w", backupPath, err)
	}

	log.Println("Database backup created:", backupPath)
	cleanOldBackups(backupDir, backupRetention)
	return nil
}

// cleanOldBackups deletes the oldest backups beyond `retention`, sorted by
// modification time. No-op if the directory is unreadable or contains
// `retention` or fewer files.
func cleanOldBackups(backupDir string, retention int) {
	files, err := os.ReadDir(backupDir)
	if err != nil {
		return
	}

	var backups []os.DirEntry
	for _, f := range files {
		if !f.IsDir() {
			backups = append(backups, f)
		}
	}

	if len(backups) <= retention {
		return
	}

	sort.Slice(backups, func(i, j int) bool {
		infoI, _ := backups[i].Info()
		infoJ, _ := backups[j].Info()
		return infoI.ModTime().Before(infoJ.ModTime())
	})

	toDelete := len(backups) - retention
	for i := range toDelete {
		path := filepath.Join(backupDir, backups[i].Name())
		if err := os.Remove(path); err != nil {
			log.Println("Failed to delete old backup:", backups[i].Name(), err)
		} else {
			log.Println("Deleted old backup:", backups[i].Name())
		}
	}
}

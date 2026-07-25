package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
)

// canonicalTimeFormat is the layout modernc.org/sqlite writes for a bound
// time.Time when no _time_format DSN param is set (it falls back to
// time.Time.String()). Live server writes always go through this path, so
// this is the "correct" on-disk encoding every timestamp column should end
// up in.
const canonicalTimeFormat = "2006-01-02 15:04:05.999999999 -0700 MST"

// legacyTimestampColumn identifies one timestamp column to check/repair.
type legacyTimestampColumn struct {
	table string
	idCol string
	col   string
}

// legacyTimestampColumns lists every column that migrate wrote v1 timestamp
// strings into before the fix. archives and tags have no is_legacy flag to
// filter on, so repair instead detects non-canonical encoding directly (see
// repairColumn) and only touches rows that actually need it.
var legacyTimestampColumns = []legacyTimestampColumn{
	{"archives", "id", "created_at"},
	{"archives", "id", "updated_at"},
	{"tags", "id", "created_at"},
	{"tags", "id", "updated_at"},
	{"moments", "id", "timestamp"},
	{"moments", "id", "created_at"},
	{"moments", "id", "updated_at"},
	{"chat_messages", "id", "created_at"},
	{"chat_messages", "id", "updated_at"},
}

// repairTimestampsCmd implements the `athena-server repair-legacy-timestamps`
// subcommand.
//
// Before 2026-07-24, `migrate` wrote v1 timestamps into v2 as raw copied
// strings, while live v2 writes bind a time.Time (formatted by the driver as
// canonicalTimeFormat). SQLite stores DATETIME columns as TEXT and compares
// them byte-wise for ORDER BY, so a v2 database migrated before the fix can
// have legacy rows sorting out of chronological order relative to rows
// created natively in v2. This command re-parses every timestamp column and
// rewrites any value that isn't already in canonicalTimeFormat, so ordering
// becomes consistent without re-running the migration (which would discard
// anything created natively in v2 since).
//
// It is safe to run repeatedly: rows already in canonicalTimeFormat are left
// untouched, and no v1 access is required. Stop the server (or at least stop
// writes) before running it.
func repairTimestampsCmd(args []string) int {
	flagSet := flag.NewFlagSet("repair-legacy-timestamps", flag.ContinueOnError)
	dbPath := flagSet.String("db", "", "path to the v2 SQLite database to repair")

	if err := flagSet.Parse(args); err != nil {
		return 2
	}
	if *dbPath == "" {
		fmt.Fprintln(os.Stderr, "repair-legacy-timestamps: missing required flag --db")
		flagSet.Usage()
		return 2
	}

	if err := db.Open(*dbPath); err != nil {
		fmt.Fprintf(os.Stderr, "repair-legacy-timestamps: open database: %v\n", err)
		return 1
	}
	defer db.Close()

	if err := runRepairTimestamps(db.DB); err != nil {
		fmt.Fprintf(os.Stderr, "repair-legacy-timestamps: %v\n", err)
		return 1
	}
	return 0
}

// runRepairTimestamps re-encodes every non-canonical timestamp it finds
// across legacyTimestampColumns, in a single transaction.
func runRepairTimestamps(dbConn *sql.DB) error {
	tx, err := dbConn.Begin()
	if err != nil {
		return fmt.Errorf("begin repair tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	totalChecked, totalRepaired, totalUnrecognized := 0, 0, 0
	for _, c := range legacyTimestampColumns {
		checked, repaired, unrecognized, err := repairColumn(tx, c)
		if err != nil {
			return fmt.Errorf("repair %s.%s: %w", c.table, c.col, err)
		}
		fmt.Printf("%s.%s: %d checked, %d repaired, %d unrecognized\n", c.table, c.col, checked, repaired, unrecognized)
		totalChecked += checked
		totalRepaired += repaired
		totalUnrecognized += unrecognized
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit repair tx: %w", err)
	}

	fmt.Println()
	fmt.Printf("Repair complete: %d checked, %d repaired, %d left unrecognized (unchanged)\n", totalChecked, totalRepaired, totalUnrecognized)
	return nil
}

// repairColumn re-encodes every value in one (table, column) that isn't
// already in canonicalTimeFormat. Rows whose value doesn't match any known
// v1 encoding are logged and left untouched rather than guessed at.
func repairColumn(tx *sql.Tx, c legacyTimestampColumn) (checked, repaired, unrecognized int, err error) {
	// CAST(... AS TEXT) stops the driver from auto-parsing the DATETIME
	// column into a time.Time on the way out (which would silently
	// normalize the value and hide the very mismatch we're checking for).
	rows, err := tx.Query(fmt.Sprintf(`SELECT %s, CAST(%s AS TEXT) FROM %s`, c.idCol, c.col, c.table))
	if err != nil {
		return 0, 0, 0, fmt.Errorf("query: %w", err)
	}

	type fix struct {
		id string
		t  time.Time
	}
	var fixes []fix
	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return 0, 0, 0, fmt.Errorf("scan: %w", err)
		}
		checked++

		if _, err := time.Parse(canonicalTimeFormat, raw); err == nil {
			continue // already the canonical live-write encoding
		}

		parsed, perr := parseV1Timestamp(raw)
		if perr != nil {
			log.Printf("repair-legacy-timestamps: %s.%s id=%s: unrecognized timestamp %q, leaving unchanged", c.table, c.col, id, raw)
			unrecognized++
			continue
		}
		fixes = append(fixes, fix{id: id, t: parsed})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, 0, 0, fmt.Errorf("iterate: %w", err)
	}
	rows.Close()

	stmt, err := tx.Prepare(fmt.Sprintf(`UPDATE %s SET %s = ? WHERE %s = ?`, c.table, c.col, c.idCol))
	if err != nil {
		return 0, 0, 0, fmt.Errorf("prepare update: %w", err)
	}
	defer stmt.Close()

	for _, f := range fixes {
		if _, err := stmt.Exec(f.t, f.id); err != nil {
			return 0, 0, 0, fmt.Errorf("update %s id=%s: %w", c.table, f.id, err)
		}
		repaired++
	}

	return checked, repaired, unrecognized, nil
}

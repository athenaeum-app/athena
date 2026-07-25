package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/config"
	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/domain"
	"github.com/athenaeum-app/athena/server/internal/seed"
)

// seedCmd implements the `athena-server seed` subcommand. It populates the
// database with a rich, deterministic demo library that showcases every
// user-facing feature, driving the real domain layer so sync events and audit
// entries are authentic (mirroring migrate.go's structure).
//
// Usage:
//
//	athena-server seed [--reset]
//
// Without --reset the command refuses to run against a database that already
// holds content, so it can never clobber a real library by accident. With
// --reset it first wipes the database file and uploads directory, then lets
// db.Open recreate a fresh, fully-migrated schema before seeding.
func seedCmd(args []string) int {
	flagSet := flag.NewFlagSet("seed", flag.ContinueOnError)
	reset := flagSet.Bool("reset", false, "wipe all existing data (database + uploads) before seeding")
	if err := flagSet.Parse(args); err != nil {
		return 2
	}

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "seed: load config: %v\n", err)
		return 1
	}

	// On --reset, remove the on-disk state before opening the DB so db.Open
	// recreates a clean, fully-migrated schema (SQLite cannot safely truncate
	// an open database file).
	if *reset {
		if err := wipeData(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "seed: reset: %v\n", err)
			return 1
		}
	}

	if err := db.Open(cfg.DBPath); err != nil {
		fmt.Fprintf(os.Stderr, "seed: open database: %v\n", err)
		return 1
	}
	defer db.Close()

	// Wire config into the packages that consult it, exactly as runServer does.
	auth.SetConfig(cfg)
	domain.Config = cfg

	// Safety: without --reset, refuse to seed on top of existing content.
	if !*reset {
		occupied, err := dbOccupied()
		if err != nil {
			fmt.Fprintf(os.Stderr, "seed: check occupancy: %v\n", err)
			return 1
		}
		if occupied {
			fmt.Fprintln(os.Stderr, "seed: database already contains data; re-run with --reset to wipe and reseed")
			return 1
		}
	}

	if err := seed.Run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "seed: %v\n", err)
		return 1
	}
	return 0
}

// wipeData deletes the database file (and its WAL/SHM sidecars) and clears the
// uploads directory, then recreates an empty uploads directory. It mirrors what
// `npm run reset:server` does (deleting server/data) but scoped to the
// configured paths so a temp-dir test run stays isolated.
func wipeData(cfg *config.Config) error {
	for _, p := range []string{cfg.DBPath, cfg.DBPath + "-wal", cfg.DBPath + "-shm"} {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", p, err)
		}
	}
	if err := os.RemoveAll(cfg.UploadsPath); err != nil {
		return fmt.Errorf("remove uploads: %w", err)
	}
	if err := os.MkdirAll(cfg.UploadsPath, 0o755); err != nil {
		return fmt.Errorf("recreate uploads: %w", err)
	}
	return nil
}

// dbOccupied reports whether the database already holds user-visible content,
// used to guard the non-reset path.
func dbOccupied() (bool, error) {
	total := 0
	for _, table := range []string{"users", "moments", "chat_messages", "canvases", "todo_lists"} {
		var n int
		if err := db.DB.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
			return false, fmt.Errorf("count %s: %w", table, err)
		}
		total += n
	}
	return total > 0, nil
}

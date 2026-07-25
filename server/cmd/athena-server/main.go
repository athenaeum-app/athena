package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/athenaeum-app/athena/server/internal/api"
	"github.com/athenaeum-app/athena/server/internal/auth"
	"github.com/athenaeum-app/athena/server/internal/config"
	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/domain"
	"github.com/athenaeum-app/athena/server/internal/sync"
)

func main() {
	// The first positional argument selects a subcommand. If absent or
	// unrecognized, fall through to running the server (the historical
	// default behaviour).
	if len(os.Args) >= 2 {
		switch os.Args[1] {
		case "migrate":
			os.Exit(migrateCmd(os.Args[2:]))
		case "repair-legacy-timestamps":
			os.Exit(repairTimestampsCmd(os.Args[2:]))
		case "repair-legacy-assets":
			os.Exit(repairAssetsCmd(os.Args[2:]))
		case "seed":
			os.Exit(seedCmd(os.Args[2:]))
		case "-h", "--help", "help":
			printUsage()
			return
		}
	}

	runServer()
}

func printUsage() {
	fmt.Println("athena-server [subcommand]")
	fmt.Println()
	fmt.Println("Subcommands:")
	fmt.Println("  migrate                   Migrate a v1 database and uploads directory into v2.")
	fmt.Println("  repair-legacy-timestamps  Re-encode a migrated v2 database's legacy timestamps in place.")
	fmt.Println("  repair-legacy-assets      Import v1 upload files a migrated v2 library still refers to.")
	fmt.Println("  seed                      Seed a rich, deterministic demo library (use --reset to wipe first).")
	fmt.Println("  (none)                    Run the HTTP server (default).")
	fmt.Println()
	fmt.Println("Run a subcommand with no further args (or -h) to see its flags.")
}

func runServer() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Apply a staged backup restore, if any, before the DB is opened
	// (SQLite cannot safely overwrite an open database file; ADR-0010, 4.12).
	if err := sync.ApplyPendingRestore(cfg.DBPath); err != nil {
		log.Fatalf("Failed to apply pending restore: %v", err)
	}

	if err := db.Open(cfg.DBPath); err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()

	// Wire config into packages that need it
	auth.SetConfig(cfg)
	domain.Config = cfg

	// Start background workers. StartBackupWorker self-disables when the
	// resolved interval is 0 (backups OFF); by default backups are ON (~24h).
	sync.StartBackupWorker(cfg.BackupInterval, cfg.BackupRetention, cfg.DBPath)

	sync.StartPruneWorker(
		24*time.Hour,
		cfg.PruneAfterDays,
		domain.PruneDeletedMoments,
		domain.PruneDeletedChatMessages,
	)

	// Start the HTTP server
	server := api.NewServer(cfg)

	addr := ":" + cfg.Port
	fmt.Printf("Athena server starting on %s\n", addr)

	if err := http.ListenAndServe(addr, server); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

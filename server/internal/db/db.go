// Package db manages the SQLite connection, runs migrations, and provides
// query helpers. It uses modernc.org/sqlite (pure Go, no CGO) so the
// server can be cross-compiled without a C toolchain.
package db

import (
	"database/sql"
	"embed"
	"fmt"
	"log"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// DB is the global database connection. Set by Open().
var DB *sql.DB

// Open opens the SQLite database at the given path, enables WAL mode and
// foreign keys, and runs pending migrations.
func Open(path string) error {
	var err error
	DB, err = sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}

	// SQLite is best with a single connection for writes. Set a modest
	// connection pool for read concurrency.
	DB.SetMaxOpenConns(1)

	if err := DB.Ping(); err != nil {
		return fmt.Errorf("ping database: %w", err)
	}

	if err := migrate(); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}

	log.Println("Database opened and migrated")
	return nil
}

// migrate runs all pending migrations from the embedded migrations/ directory.
// Migrations are named NNNN_description.up.sql / NNNN_description.down.sql.
// A `schema_migrations` table tracks which migrations have been applied.
func migrate() error {
	if _, err := DB.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		return fmt.Errorf("create schema_migrations table: %w", err)
	}

	applied, err := getAppliedMigrations()
	if err != nil {
		return err
	}

	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read migrations directory: %w", err)
	}

	var upMigrations []string
	for _, e := range entries {
		name := e.Name()
		if len(name) > 7 && name[len(name)-7:] == ".up.sql" {
			upMigrations = append(upMigrations, name)
		}
	}

	for _, name := range upMigrations {
		version, err := migrationVersion(name)
		if err != nil {
			return err
		}
		if applied[version] {
			continue
		}

		log.Printf("Running migration %s", name)

		content, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}

		tx, err := DB.Begin()
		if err != nil {
			return fmt.Errorf("begin migration transaction: %w", err)
		}

		if _, err := tx.Exec(string(content)); err != nil {
			tx.Rollback()
			return fmt.Errorf("exec migration %s: %w", name, err)
		}

		if _, err := tx.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, version); err != nil {
			tx.Rollback()
			return fmt.Errorf("record migration %s: %w", name, err)
		}

		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %s: %w", name, err)
		}
	}

	return nil
}

func getAppliedMigrations() (map[int64]bool, error) {
	rows, err := DB.Query(`SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("query applied migrations: %w", err)
	}
	defer rows.Close()

	applied := make(map[int64]bool)
	for rows.Next() {
		var version int64
		if err := rows.Scan(&version); err != nil {
			return nil, fmt.Errorf("scan migration version: %w", err)
		}
		applied[version] = true
	}
	return applied, nil
}

// migrationVersion extracts the 4-digit version prefix from a migration
// filename, e.g. "0001_initial_schema.up.sql" -> 1.
func migrationVersion(name string) (int64, error) {
	if len(name) < 4 {
		return 0, fmt.Errorf("invalid migration filename: %s", name)
	}
	var version int64
	for i := 0; i < 4; i++ {
		if name[i] < '0' || name[i] > '9' {
			return 0, fmt.Errorf("invalid migration version in filename: %s", name)
		}
		version = version*10 + int64(name[i]-'0')
	}
	return version, nil
}

// Close closes the database connection.
func Close() error {
	if DB != nil {
		return DB.Close()
	}
	return nil
}

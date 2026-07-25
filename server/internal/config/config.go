package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Config holds all server configuration. Infra settings (port, paths) are
// env-only. Runtime-tunable settings (backups) are resolved by merging a
// server-generated JSON config file with environment overrides.
type Config struct {
	Port              string
	DBPath            string
	UploadsPath       string
	ConfigPath        string // JSON runtime-config file (sibling of the DB)
	SessionExpiryDays int    // 0 = no expiry
	PruneAfterDays    int
	BackupEnabled     bool
	BackupInterval    time.Duration // 0 = auto-backups disabled
	BackupIntervalHrs int
	BackupRetention   int
	PreviewCacheTTL   time.Duration
	MaxUploadBytes    int64
}

// Load reads configuration, applying defaults. Infra settings come from env
// vars; backup settings are merged from (in increasing precedence) built-in
// defaults, the JSON config file, then env vars.
func Load() (*Config, error) {
	cfg := &Config{
		Port:              envOr("PORT", "8080"),
		DBPath:            envOr("DB_PATH", "./data/athenaeum.db"),
		UploadsPath:       envOr("UPLOADS_PATH", "./data/uploads"),
		SessionExpiryDays: envIntOr("SESSION_EXPIRY_DAYS", 30),
		PruneAfterDays:    envIntOr("PRUNE_AFTER_DAYS", 365),
		PreviewCacheTTL:   envHoursOr("PREVIEW_CACHE_TTL_HOURS", 168*time.Hour),
		MaxUploadBytes:    int64(envIntOr("MAX_UPLOAD_MB", 50)) << 20,
	}

	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0o755); err != nil {
		return nil, fmt.Errorf("create db directory: %w", err)
	}
	if err := os.MkdirAll(cfg.UploadsPath, 0o755); err != nil {
		return nil, fmt.Errorf("create uploads directory: %w", err)
	}

	// Runtime config file lives next to the DB. It is generated with sensible
	// defaults (backups ON, ~24h, keep 7) on first startup if missing.
	cfg.ConfigPath = filepath.Join(filepath.Dir(cfg.DBPath), "athena.config.json")
	file, err := LoadOrCreateFileConfig(cfg.ConfigPath)
	if err != nil {
		return nil, err
	}

	if err := cfg.resolveBackupSettings(file); err != nil {
		return nil, err
	}

	return cfg, nil
}

// resolveBackupSettings merges the file config with env overrides and stores
// the effective backup settings on cfg. Precedence: env var > file > default.
func (c *Config) resolveBackupSettings(file *FileConfig) error {
	enabled := file.Backup.Enabled
	intervalHrs := file.Backup.IntervalHours
	if intervalHrs < 1 {
		intervalHrs = DefaultBackupIntervalHours
	}
	retention := envIntOr("BACKUP_RETENTION", file.Backup.Retention)
	if retention < 1 {
		retention = DefaultBackupRetention
	}

	interval := time.Duration(0)
	if enabled {
		interval = time.Duration(intervalHrs) * time.Hour
	}

	// An explicit BACKUP_INTERVAL env var overrides the file entirely.
	if s := os.Getenv("BACKUP_INTERVAL"); s != "" {
		d, err := time.ParseDuration(s)
		if err != nil {
			return fmt.Errorf("invalid BACKUP_INTERVAL %q: %w", s, err)
		}
		interval = d
		enabled = d > 0
		intervalHrs = int(d.Hours())
	}

	c.BackupEnabled = enabled
	c.BackupInterval = interval
	c.BackupIntervalHrs = intervalHrs
	c.BackupRetention = retention
	return nil
}

// UploadLimitMB returns the max upload size in megabytes (for display).
func (c *Config) UploadLimitMB() int {
	return int(c.MaxUploadBytes >> 20)
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return n
}

// envHoursOr reads a setting whose name promises hours. A bare number is read
// as a count of hours, which is what the variable name says it is. A Go
// duration string ("168h", "30m") is accepted too, so a value written against
// the previous behaviour keeps working.
//
// The bare-number form used to fall through to the fallback silently, because
// time.ParseDuration rejects a value with no unit. Setting the documented
// PREVIEW_CACHE_TTL_HOURS=24 therefore produced the 168h default instead of 24
// hours, with nothing logged either way.
func envHoursOr(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	if hours, err := strconv.Atoi(value); err == nil && hours > 0 {
		return time.Duration(hours) * time.Hour
	}
	if parsed, err := time.ParseDuration(value); err == nil && parsed > 0 {
		return parsed
	}
	return fallback
}

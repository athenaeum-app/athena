package config

import (
	"encoding/json"
	"fmt"
	"os"
)

// Default backup settings used to generate the config file on first startup
// and as fallbacks when the file omits or under-specifies a value. Backups are
// ON by default (~24h interval, keep 7) so a fresh install is protected with
// no env vars set.
const (
	DefaultBackupIntervalHours = 24
	DefaultBackupRetention     = 7
)

// BackupSettings are the runtime-tunable backup knobs persisted in the JSON
// config file and editable via the backups API.
type BackupSettings struct {
	Enabled       bool `json:"enabled"`
	IntervalHours int  `json:"interval_hours"`
	Retention     int  `json:"retention"`
}

// FileConfig is the on-disk JSON runtime configuration (data/athena.config.json).
// It currently holds only backup settings; infra settings stay env-only.
type FileConfig struct {
	Backup BackupSettings `json:"backup"`
}

// DefaultFileConfig returns the built-in defaults written when no config file
// exists yet.
func DefaultFileConfig() *FileConfig {
	return &FileConfig{
		Backup: BackupSettings{
			Enabled:       true,
			IntervalHours: DefaultBackupIntervalHours,
			Retention:     DefaultBackupRetention,
		},
	}
}

// LoadOrCreateFileConfig reads the JSON config at path. If the file does not
// exist it is generated with DefaultFileConfig and that value is returned.
func LoadOrCreateFileConfig(path string) (*FileConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			fileConfig := DefaultFileConfig()
			if err := SaveFileConfig(path, fileConfig); err != nil {
				return nil, err
			}
			return fileConfig, nil
		}
		return nil, fmt.Errorf("read config file %s: %w", path, err)
	}

	fileConfig := DefaultFileConfig()
	if err := json.Unmarshal(data, fileConfig); err != nil {
		return nil, fmt.Errorf("parse config file %s: %w", path, err)
	}
	return fileConfig, nil
}

// SaveFileConfig writes the config to path as indented JSON.
func SaveFileConfig(path string, fileConfig *FileConfig) error {
	data, err := json.MarshalIndent(fileConfig, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("write config file %s: %w", path, err)
	}
	return nil
}

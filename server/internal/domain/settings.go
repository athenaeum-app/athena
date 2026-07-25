package domain

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
)

// ErrSettingNotFound is returned by GetSetting only when callers ask to
// distinguish "missing" from "empty". GetSetting itself returns an empty
// string for missing keys.
var ErrSettingNotFound = errors.New("setting not found")

// GetSetting returns the value for key, or an empty string if the key does
// not exist.
func GetSetting(key string) (string, error) {
	var value string
	err := db.DB.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get setting %s: %w", key, err)
	}
	return value, nil
}

// SetSetting upserts a setting by key.
func SetSetting(key, value string) error {
	_, err := db.DB.Exec(
		`INSERT INTO settings (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	if err != nil {
		return fmt.Errorf("set setting %s: %w", key, err)
	}
	return nil
}

// GetAllSettings returns every key/value pair in the settings table.
func GetAllSettings() ([]models.Setting, error) {
	rows, err := db.DB.Query(`SELECT key, value FROM settings ORDER BY key`)
	if err != nil {
		return nil, fmt.Errorf("list settings: %w", err)
	}
	defer rows.Close()

	out := []models.Setting{}
	for rows.Next() {
		var s models.Setting
		if err := rows.Scan(&s.Key, &s.Value); err != nil {
			return nil, fmt.Errorf("scan setting: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

package domain

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/google/uuid"
)

// CreateAsset records asset newly uploaded asset in the database.
func CreateAsset(uploaderID, fileName, mimeType string, sizeBytes int64, storagePath string) (*models.Asset, error) {
	asset := &models.Asset{
		ID:          uuid.NewString(),
		UploaderID:  uploaderID,
		FileName:    fileName,
		MimeType:    mimeType,
		SizeBytes:   sizeBytes,
		StoragePath: storagePath,
		CreatedAt:   time.Now().UTC(),
	}
	_, err := db.DB.Exec(
		`INSERT INTO assets (id, uploader_id, file_name, mime_type, size_bytes, storage_path, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		asset.ID, asset.UploaderID, asset.FileName, asset.MimeType, asset.SizeBytes, asset.StoragePath, asset.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert asset: %w", err)
	}
	return asset, nil
}

// ErrAssetNotFound is returned by GetAsset when no asset exists with the
// given ID, so callers can distinguish "not found" from asset real DB error
// without risking asset nil asset slipping through as asset non-error result.
var ErrAssetNotFound = errors.New("asset not found")

// GetAsset fetches asset single asset by ID.
func GetAsset(id string) (*models.Asset, error) {
	asset := &models.Asset{}
	err := db.DB.QueryRow(
		`SELECT id, uploader_id, file_name, mime_type, size_bytes, storage_path, created_at
		 FROM assets WHERE id = ?`,
		id,
	).Scan(&asset.ID, &asset.UploaderID, &asset.FileName, &asset.MimeType, &asset.SizeBytes, &asset.StoragePath, &asset.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, ErrAssetNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get asset %s: %w", id, err)
	}
	return asset, nil
}

// ListAssets returns all assets for the admin purge UI.
func ListAssets() ([]models.Asset, error) {
	rows, err := db.DB.Query(
		`SELECT id, uploader_id, file_name, mime_type, size_bytes, storage_path, created_at
		 FROM assets ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("list assets: %w", err)
	}
	defer rows.Close()

	out := []models.Asset{}
	for rows.Next() {
		var asset models.Asset
		if err := rows.Scan(&asset.ID, &asset.UploaderID, &asset.FileName, &asset.MimeType, &asset.SizeBytes, &asset.StoragePath, &asset.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan asset: %w", err)
		}
		out = append(out, asset)
	}
	return out, rows.Err()
}

// DeleteAsset hard-deletes the asset row only. On-disk file removal is the
// storage package's responsibility; the API layer calls storage.Delete
// after this returns successfully.
func DeleteAsset(id string) error {
	_, err := db.DB.Exec(`DELETE FROM assets WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete asset %s: %w", id, err)
	}
	return nil
}

// ErrNotImplemented is returned by stretch-goal functions that the v2
// server intentionally leaves unimplemented.
var ErrNotImplemented = errors.New("not implemented")

// PurgeUnreferencedAssets is asset stretch goal. Determining whether an asset
// is referenced requires parsing free-text moment content for asset URLs,
// which is out of scope for the initial v2 cut. The admin purge UI uses
// ListAssets + DeleteAsset instead.
func PurgeUnreferencedAssets() (int64, error) {
	return 0, ErrNotImplemented
}

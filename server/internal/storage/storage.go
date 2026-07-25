// Package storage handles file I/O for uploaded assets. Files are stored
// on local disk under an opaque UUID filename. The original filename is
// kept in the database (assets.file_name) and returned via the API.
package storage

import (
	"errors"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"

	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/google/uuid"
)

type LocalStorage struct {
	basePath string
}

func New(basePath string) *LocalStorage {
	return &LocalStorage{basePath: basePath}
}

// Save writes the uploaded file to disk and returns an Asset model
// (without the DB row; the caller inserts that via domain.CreateAsset).
func (ls *LocalStorage) Save(file io.Reader, fileHeader *multipart.FileHeader, uploaderID string) (*models.Asset, error) {
	ext := filepath.Ext(fileHeader.Filename)
	assetID := uuid.New().String()
	storageName := assetID + ext
	storagePath := filepath.Join(ls.basePath, storageName)

	dst, err := os.Create(storagePath)
	if err != nil {
		return nil, err
	}
	defer dst.Close()

	written, err := io.Copy(dst, file)
	if err != nil {
		os.Remove(storagePath)
		return nil, err
	}

	return &models.Asset{
		ID:          assetID,
		UploaderID:  uploaderID,
		FileName:    fileHeader.Filename,
		MimeType:    MimeTypeForName(fileHeader.Filename),
		SizeBytes:   written,
		StoragePath: storageName,
	}, nil
}

// FullPath returns the absolute path on disk for a stored asset.
func (ls *LocalStorage) FullPath(storagePath string) string {
	return filepath.Join(ls.basePath, storagePath)
}

// Delete removes a file from disk. Returns nil if the file doesn't exist.
func (ls *LocalStorage) Delete(storagePath string) error {
	full := ls.FullPath(storagePath)
	err := os.Remove(full)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

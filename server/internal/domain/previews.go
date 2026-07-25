package domain

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
)

// GetLinkPreview returns a cached preview for the given URL if it exists
// and is fresher than config.PreviewCacheTTL. Returns nil (without error)
// when the entry is missing or stale, signalling the API layer to trigger
// a re-scrape.
func GetLinkPreview(url string) (*models.LinkPreview, error) {
	preview := &models.LinkPreview{}
	err := db.DB.QueryRow(
		`SELECT url, title, description, image_url, scraped_at FROM link_previews WHERE url = ?`,
		url,
	).Scan(&preview.URL, &preview.Title, &preview.Description, &preview.ImageURL, &preview.ScrapedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get link preview %s: %w", url, err)
	}

	if Config != nil && time.Since(preview.ScrapedAt) > Config.PreviewCacheTTL {
		return nil, nil
	}
	return preview, nil
}

// SaveLinkPreview upserts a link preview row.
func SaveLinkPreview(preview *models.LinkPreview) error {
	_, err := db.DB.Exec(
		`INSERT INTO link_previews (url, title, description, image_url, scraped_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(url) DO UPDATE SET
		   title = excluded.title,
		   description = excluded.description,
		   image_url = excluded.image_url,
		   scraped_at = excluded.scraped_at`,
		preview.URL, preview.Title, preview.Description, preview.ImageURL, preview.ScrapedAt,
	)
	if err != nil {
		return fmt.Errorf("save link preview %s: %w", preview.URL, err)
	}
	return nil
}

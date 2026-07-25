package domain

import (
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/athenaeum-app/athena/server/internal/db"
)

// Stats is the server statistics payload. Uptime, library
// version and last-backup info are filled in by the API layer.
type Stats struct {
	MomentsCount   int64 `json:"moments_count"`
	TagsCount      int64 `json:"tags_count"`
	ArchivesCount  int64 `json:"archives_count"`
	UsersCount     int64 `json:"users_count"`
	ChatCount      int64 `json:"chat_count"`
	TodoListsCount int64 `json:"todo_lists_count"`
	CanvasesCount  int64 `json:"canvases_count"`
	AssetsCount    int64 `json:"assets_count"`

	DBSizeBytes      int64 `json:"db_size_bytes"`
	UploadsSizeBytes int64 `json:"uploads_size_bytes"`

	TotalWords           int64   `json:"total_words"`
	AvgWordsPerMoment    float64 `json:"avg_words_per_moment"`
	UntaggedMoments      int64   `json:"untagged_moments"`
	MomentsThisWeek      int64   `json:"moments_this_week"`
	ChatMessagesThisWeek int64   `json:"chat_messages_this_week"`
	TotalDaysActive      int64   `json:"total_days_active"`
}

// GatherStats collects entity counts and on-disk sizes. It reads Config for
// the DB and uploads paths, so Config must be set before calling.
func GatherStats() (*Stats, error) {
	stats := &Stats{}
	counts := []struct {
		q   string
		dst *int64
	}{
		{`SELECT COUNT(*) FROM moments WHERE deleted_at IS NULL`, &stats.MomentsCount},
		{`SELECT COUNT(*) FROM tags`, &stats.TagsCount},
		{`SELECT COUNT(*) FROM archives`, &stats.ArchivesCount},
		{`SELECT COUNT(*) FROM users`, &stats.UsersCount},
		{`SELECT COUNT(*) FROM chat_messages WHERE deleted_at IS NULL`, &stats.ChatCount},
		{`SELECT COUNT(*) FROM todo_lists`, &stats.TodoListsCount},
		{`SELECT COUNT(*) FROM canvases`, &stats.CanvasesCount},
		{`SELECT COUNT(*) FROM assets`, &stats.AssetsCount},
		{`SELECT COUNT(*) FROM moments WHERE deleted_at IS NULL AND id NOT IN (SELECT moment_id FROM moment_tags)`, &stats.UntaggedMoments},
		{`SELECT COUNT(*) FROM moments WHERE deleted_at IS NULL AND timestamp >= datetime('now', '-7 days')`, &stats.MomentsThisWeek},
		{`SELECT COUNT(*) FROM chat_messages WHERE deleted_at IS NULL AND created_at >= datetime('now', '-7 days')`, &stats.ChatMessagesThisWeek},
		{`SELECT COUNT(DISTINCT substr(timestamp, 1, 10)) FROM moments WHERE deleted_at IS NULL`, &stats.TotalDaysActive},
	}
	for _, c := range counts {
		if err := db.DB.QueryRow(c.q).Scan(c.dst); err != nil {
			return nil, err
		}
	}

	words, err := totalWordCount()
	if err != nil {
		return nil, err
	}
	stats.TotalWords = words
	if stats.MomentsCount > 0 {
		stats.AvgWordsPerMoment = float64(words) / float64(stats.MomentsCount)
	}

	if Config != nil {
		stats.DBSizeBytes = fileSize(Config.DBPath) +
			fileSize(Config.DBPath+"-wal") + fileSize(Config.DBPath+"-shm")
		stats.UploadsSizeBytes = dirSize(Config.UploadsPath)
	}
	return stats, nil
}

// totalWordCount sums whitespace-separated tokens across every non-deleted
// moment'stats content. SQLite has no built-in word splitter, so this loads
// content into memory rather than a single SQL aggregate; revisit with a
// maintained word_count column if the moments table grows large enough for
// this to matter.
func totalWordCount() (int64, error) {
	rows, err := db.DB.Query(`SELECT content FROM moments WHERE deleted_at IS NULL`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	var total int64
	for rows.Next() {
		var content string
		if err := rows.Scan(&content); err != nil {
			return 0, err
		}
		total += int64(len(strings.Fields(content)))
	}
	return total, rows.Err()
}

// LegacyStats mirrors the athena-server v1 GET /api/stats response shape.
// External tools (e.g. a homeserver dashboard) already polling that
// endpoint can keep pointing at the same field names.
type LegacyStats struct {
	TotalMoments         int64   `json:"total_moments"`
	TotalWords           int64   `json:"total_words"`
	TotalTags            int64   `json:"total_tags"`
	TotalAssets          int64   `json:"total_assets"`
	TotalArchives        int64   `json:"total_archives"`
	TotalMessages        int64   `json:"total_messages"`
	AvgWordsPerMoment    float64 `json:"avg_words_per_moment"`
	UntaggedMoments      int64   `json:"untagged_moments"`
	MomentsThisWeek      int64   `json:"moments_this_week"`
	UniqueChatters       int64   `json:"unique_chatters"`
	TotalDaysActive      int64   `json:"total_days_active"`
	ChatMessagesThisWeek int64   `json:"chat_messages_this_week"`
	TotalAssetsSize      float64 `json:"total_assets_size"`
}

// GatherLegacyStats builds the v1-compatible payload from the same
// underlying data as GatherStats. v1'stats chat authors were free-text names
// with no account required, so unique_chatters here counts distinct
// (author_id or display_name) rather than registered users.
func GatherLegacyStats() (*LegacyStats, error) {
	stats, err := GatherStats()
	if err != nil {
		return nil, err
	}

	var uniqueChatters int64
	selectSQL := `SELECT COUNT(DISTINCT COALESCE(author_id, display_name)) FROM chat_messages WHERE deleted_at IS NULL`
	if err := db.DB.QueryRow(selectSQL).Scan(&uniqueChatters); err != nil {
		return nil, err
	}

	return &LegacyStats{
		TotalMoments:         stats.MomentsCount,
		TotalWords:           stats.TotalWords,
		TotalTags:            stats.TagsCount,
		TotalAssets:          stats.AssetsCount,
		TotalArchives:        stats.ArchivesCount,
		TotalMessages:        stats.ChatCount,
		AvgWordsPerMoment:    stats.AvgWordsPerMoment,
		UntaggedMoments:      stats.UntaggedMoments,
		MomentsThisWeek:      stats.MomentsThisWeek,
		UniqueChatters:       uniqueChatters,
		TotalDaysActive:      stats.TotalDaysActive,
		ChatMessagesThisWeek: stats.ChatMessagesThisWeek,
		TotalAssetsSize:      math.Round(float64(stats.UploadsSizeBytes)/1073741824*100) / 100,
	}, nil
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

func dirSize(dir string) int64 {
	var total int64
	_ = filepath.Walk(dir, func(_ string, info os.FileInfo, err error) error {
		if err == nil && info != nil && !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

package domain

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/athenaeum-app/athena/server/internal/db"
	"github.com/athenaeum-app/athena/server/internal/models"
	"github.com/google/uuid"
)

// CreateTag inserts a new tag with a generated UUID.
func CreateTag(name, color string) (*models.Tag, error) {
	now := time.Now().UTC()
	tag := &models.Tag{
		ID:        uuid.NewString(),
		Name:      name,
		Color:     color,
		CreatedAt: now,
		UpdatedAt: now,
	}
	_, err := db.DB.Exec(
		`INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		tag.ID, tag.Name, tag.Color, tag.CreatedAt, tag.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert tag: %w", err)
	}
	return tag, nil
}

// GetTag fetches a single tag by ID. Returns nil if not found.
func GetTag(id string) (*models.Tag, error) {
	tag := &models.Tag{}
	err := db.DB.QueryRow(
		`SELECT id, name, color, created_at, updated_at FROM tags WHERE id = ?`,
		id,
	).Scan(&tag.ID, &tag.Name, &tag.Color, &tag.CreatedAt, &tag.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get tag %s: %w", id, err)
	}
	return tag, nil
}

// ListTags returns all tags ordered by name.
func ListTags() ([]models.Tag, error) {
	rows, err := db.DB.Query(
		`SELECT id, name, color, created_at, updated_at FROM tags ORDER BY name ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("list tags: %w", err)
	}
	defer rows.Close()

	out := []models.Tag{}
	for rows.Next() {
		var tag models.Tag
		if err := rows.Scan(&tag.ID, &tag.Name, &tag.Color, &tag.CreatedAt, &tag.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan tag: %w", err)
		}
		out = append(out, tag)
	}
	return out, rows.Err()
}

// UpdateTag performs a partial update: only non-nil fields are written.
func UpdateTag(id string, name, color *string) (*models.Tag, error) {
	now := time.Now().UTC()

	sets := []string{}
	args := []any{}
	if name != nil {
		sets = append(sets, "name = ?")
		args = append(args, *name)
	}
	if color != nil {
		sets = append(sets, "color = ?")
		args = append(args, *color)
	}
	if len(sets) == 0 {
		return GetTag(id)
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, now, id)

	updateSQL := `UPDATE tags SET ` + strings.Join(sets, ", ") + ` WHERE id = ?`
	res, err := db.DB.Exec(updateSQL, args...)
	if err != nil {
		return nil, fmt.Errorf("update tag %s: %w", id, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, nil
	}
	return GetTag(id)
}

// RecolorTags applies new colors to many tags in a single transaction.
// colorByID maps tag ID -> new color; unknown IDs are ignored. Returns the
// full updated tag set so the API layer can emit per-tag sync events.
func RecolorTags(colorByID map[string]string) ([]models.Tag, error) {
	if len(colorByID) == 0 {
		return ListTags()
	}
	now := time.Now().UTC()

	tx, err := db.DB.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin recolor tx: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`UPDATE tags SET color = ?, updated_at = ? WHERE id = ?`)
	if err != nil {
		return nil, fmt.Errorf("prepare recolor: %w", err)
	}
	defer stmt.Close()
	for id, color := range colorByID {
		if _, err := stmt.Exec(color, now, id); err != nil {
			return nil, fmt.Errorf("recolor tag %s: %w", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit recolor: %w", err)
	}
	return ListTags()
}

// DeleteTag hard-deletes a tag. moment_tags rows cascade via FK.
func DeleteTag(id string) error {
	_, err := db.DB.Exec(`DELETE FROM tags WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete tag %s: %w", id, err)
	}
	return nil
}

// TagFacets returns, for every tag that still appears on at least one moment
// matching the given filters, how many of those moments carry it.
//
// This exists because tag filtering is AND, not OR: with #games and #cooking
// both selected a moment must carry both, so it is easy to assemble a
// combination no moment satisfies and land on an empty feed with no clue which
// choice was the wrong one. The client uses this to only offer tags that keep
// the result set non-empty, so every click narrows rather than gambles.
//
// It deliberately counts across the whole library rather than the loaded page.
// The feed pages in at 100 moments, so a facet set derived client-side would
// omit tags used only on older entries and then grow as the reader scrolled,
// which reads as tags flickering into existence.
//
// selectedTagIDs are the tags already chosen, applied with the same AND
// semantics the feed uses. They come back in the result (they are on every
// surviving moment by definition), which is what lets the caller keep showing
// them so they can be deselected.
func TagFacets(archiveID *string, search string, selectedTagIDs []string, filter *MomentFilter) (map[string]int, error) {
	// The two moment sources differ only in their FROM clause; both alias the
	// moments table to `moment` so one filter prefix serves both.
	var base string
	args := []any{}
	// Through the same builder SearchMoments uses, or the counts would answer a
	// different question from the feed they are counting.
	match := FTSQuery(search)
	if match != "" {
		base = `SELECT moment.id
		        FROM moments_fts fts
		        JOIN moments moment ON moment.rowid = fts.rowid
		        WHERE moments_fts MATCH ? AND moment.deleted_at IS NULL`
		args = append(args, match)
	} else {
		base = `SELECT moment.id FROM moments moment WHERE moment.deleted_at IS NULL`
	}
	if archiveID != nil {
		base += ` AND moment.archive_id = ?`
		args = append(args, *archiveID)
	}
	base, args = appendMomentFilter(base, args, filter, "moment.")

	// AND over the selected tags: a moment qualifies only if it carries all of
	// them, which is what HAVING COUNT(DISTINCT ...) = len checks.
	if len(selectedTagIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(selectedTagIDs)), ",")
		base += ` AND moment.id IN (
		            SELECT moment_id FROM moment_tags
		            WHERE tag_id IN (` + placeholders + `)
		            GROUP BY moment_id
		            HAVING COUNT(DISTINCT tag_id) = ?)`
		for _, id := range selectedTagIDs {
			args = append(args, id)
		}
		args = append(args, len(selectedTagIDs))
	}

	rows, err := db.DB.Query(
		`SELECT mt.tag_id, COUNT(*) FROM moment_tags mt WHERE mt.moment_id IN (`+base+`) GROUP BY mt.tag_id`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("tag facets: %w", err)
	}
	defer rows.Close()

	counts := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("scan tag facet: %w", err)
		}
		counts[id] = n
	}
	return counts, rows.Err()
}

// TagGraph is how often each tag is used and how often each pair of tags lands
// on the same moment. Pairs are recorded both ways round, so a caller holding
// one tag reads its partners straight out of Pairs[thatTag].
// ArchiveTotals is the same usage count sliced by the archive the moment was
// filed in. The composer ranks a tag it has never seen in the archive being
// written into behind every tag that archive does use, so writing into Work
// stops offering the vocabulary of a different archive first.
//
// Shipped as a dimension of the same answer rather than as a filter parameter,
// which is what keeps this endpoint free of the caller's current view: the
// client picks the slice for the archive its composer is pointed at, and
// changing that dropdown costs no request.
type TagGraph struct {
	Totals        map[string]int            `json:"totals"`
	Pairs         map[string]map[string]int `json:"pairs"`
	ArchiveTotals map[string]map[string]int `json:"archive_totals"`
}

// TagCoOccurrence counts tag usage and tag pairings across every live moment in
// the library.
//
// The composer ranks its tag suggestions from this. Counting client-side has
// the failure TagFacets describes plus a worse one: the feed pages in at 100
// moments and arrives already narrowed by whatever archive, search and date
// filters the reader has set, so a client-side count answers "which tags go
// together in what I am looking at right now" when the question asked is about
// the library. Suggestions would reorder as the reader scrolled or switched
// archive, which makes the ranking feel arbitrary at exactly the moment it is
// supposed to be helping.
//
// Deliberately takes no filters. A pairing is a property of the library, so
// the answer must not depend on the caller's current view.
func TagCoOccurrence() (*TagGraph, error) {
	graph := &TagGraph{
		Totals:        map[string]int{},
		Pairs:         map[string]map[string]int{},
		ArchiveTotals: map[string]map[string]int{},
	}

	totals, err := db.DB.Query(
		`SELECT mt.tag_id, COUNT(*)
		 FROM moment_tags mt
		 JOIN moments moment ON moment.id = mt.moment_id
		 WHERE moment.deleted_at IS NULL
		 GROUP BY mt.tag_id`,
	)
	if err != nil {
		return nil, fmt.Errorf("tag totals: %w", err)
	}
	defer totals.Close()
	for totals.Next() {
		var id string
		var n int
		if err := totals.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("scan tag total: %w", err)
		}
		graph.Totals[id] = n
	}
	if err := totals.Err(); err != nil {
		return nil, fmt.Errorf("tag totals: %w", err)
	}

	archived, err := db.DB.Query(
		`SELECT moment.archive_id, mt.tag_id, COUNT(*)
		 FROM moment_tags mt
		 JOIN moments moment ON moment.id = mt.moment_id
		 WHERE moment.deleted_at IS NULL
		 GROUP BY moment.archive_id, mt.tag_id`,
	)
	if err != nil {
		return nil, fmt.Errorf("tag archive totals: %w", err)
	}
	defer archived.Close()
	for archived.Next() {
		var archiveID, tagID string
		var n int
		if err := archived.Scan(&archiveID, &tagID, &n); err != nil {
			return nil, fmt.Errorf("scan tag archive total: %w", err)
		}
		if graph.ArchiveTotals[archiveID] == nil {
			graph.ArchiveTotals[archiveID] = map[string]int{}
		}
		graph.ArchiveTotals[archiveID][tagID] = n
	}
	if err := archived.Err(); err != nil {
		return nil, fmt.Errorf("tag archive totals: %w", err)
	}

	// `b.tag_id > a.tag_id` counts each unordered pair once instead of twice,
	// and drops the self-join of a tag with itself.
	pairs, err := db.DB.Query(
		`SELECT a.tag_id, b.tag_id, COUNT(*)
		 FROM moment_tags a
		 JOIN moment_tags b ON b.moment_id = a.moment_id AND b.tag_id > a.tag_id
		 JOIN moments moment ON moment.id = a.moment_id
		 WHERE moment.deleted_at IS NULL
		 GROUP BY a.tag_id, b.tag_id`,
	)
	if err != nil {
		return nil, fmt.Errorf("tag pairs: %w", err)
	}
	defer pairs.Close()
	for pairs.Next() {
		var left, right string
		var n int
		if err := pairs.Scan(&left, &right, &n); err != nil {
			return nil, fmt.Errorf("scan tag pair: %w", err)
		}
		if graph.Pairs[left] == nil {
			graph.Pairs[left] = map[string]int{}
		}
		if graph.Pairs[right] == nil {
			graph.Pairs[right] = map[string]int{}
		}
		graph.Pairs[left][right] = n
		graph.Pairs[right][left] = n
	}
	return graph, pairs.Err()
}

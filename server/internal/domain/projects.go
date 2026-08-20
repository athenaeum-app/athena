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

// The projects module: a portfolio of tabbed hubs (overview document, track
// board of milestones, graveyard), library-shared with last-write-wins
// concurrency like todos and canvas. No permission checks here; the API layer
// gates on permissions.ManageProjects.
//
// Ordering uses REAL positions with midpoint inserts, so a drop between two
// rows is a single UPDATE rather than a renumber.

// ListProjects returns every project with milestones and cards attached,
// ordered by position then creation time. Dismissed cards are included; the
// client owns how the graveyard is presented.
func ListProjects() ([]models.Project, error) {
	rows, err := db.DB.Query(`SELECT ` + projectColumns + ` FROM projects ORDER BY position ASC, created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()

	projects := []models.Project{}
	ids := []string{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		projects = append(projects, *p)
		ids = append(ids, p.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return projects, nil
	}

	milestonesBy, err := getMilestonesForProjects(ids)
	if err != nil {
		return nil, err
	}
	cardsBy, err := getCardsForProjects(ids)
	if err != nil {
		return nil, err
	}
	documentsBy, err := getDocumentsForProjects(ids)
	if err != nil {
		return nil, err
	}
	for i := range projects {
		// Missing map entries stay the non-nil empty slices scanProject seeded,
		// so the JSON is [] rather than null (same guard as ListTodoLists).
		if m := milestonesBy[projects[i].ID]; m != nil {
			projects[i].Milestones = m
		}
		if c := cardsBy[projects[i].ID]; c != nil {
			projects[i].Cards = c
		}
		if d := documentsBy[projects[i].ID]; d != nil {
			projects[i].Documents = d
		}
	}
	return projects, nil
}

// GetProject fetches one project with milestones and cards. Returns nil if gone.
func GetProject(id string) (*models.Project, error) {
	p, err := scanProject(db.DB.QueryRow(`SELECT `+projectColumns+` FROM projects WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get project %s: %w", id, err)
	}
	milestones, err := getMilestonesForProjects([]string{id})
	if err != nil {
		return nil, err
	}
	cards, err := getCardsForProjects([]string{id})
	if err != nil {
		return nil, err
	}
	documents, err := getDocumentsForProjects([]string{id})
	if err != nil {
		return nil, err
	}
	if milestones[id] != nil {
		p.Milestones = milestones[id]
	}
	if cards[id] != nil {
		p.Cards = cards[id]
	}
	if documents[id] != nil {
		p.Documents = documents[id]
	}
	return p, nil
}

// CreateProject inserts an empty project. No default milestones: a roadmap's
// phases are the project's own vocabulary, and naming them is a ten-second
// inline operation.
func CreateProject(title string, authorID *string) (*models.Project, error) {
	now := time.Now().UTC()
	p := &models.Project{
		ID:         uuid.NewString(),
		Title:      title,
		AuthorID:   authorID,
		CreatedAt:  now,
		UpdatedAt:  now,
		Milestones: []models.ProjectMilestone{},
		Cards:      []models.ProjectCard{},
		Documents:  []models.ProjectDocument{},
	}
	p.Accent = "#67b8c7"
	p.Icon = "space_dashboard"
	_ = db.DB.QueryRow(`SELECT COALESCE(MAX(position)+1, 0) FROM projects`).Scan(&p.Position)
	if _, err := db.DB.Exec(
		`INSERT INTO projects (id, title, overview, accent, icon, author_id, position, archived, created_at, updated_at)
		 VALUES (?, ?, '', ?, ?, ?, ?, 0, ?, ?)`,
		p.ID, p.Title, p.Accent, p.Icon, p.AuthorID, p.Position, p.CreatedAt, p.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("insert project: %w", err)
	}
	return p, nil
}

// UpdateProject partially updates title/overview/accent/icon/position/archived.
func UpdateProject(id string, title, overview, accent, icon *string, position *int, archived *bool) (*models.Project, error) {
	sets := []string{}
	args := []any{}
	if title != nil {
		sets = append(sets, "title = ?")
		args = append(args, *title)
	}
	if overview != nil {
		sets = append(sets, "overview = ?")
		args = append(args, *overview)
	}
	if accent != nil {
		sets = append(sets, "accent = ?")
		args = append(args, *accent)
	}
	if icon != nil {
		sets = append(sets, "icon = ?")
		args = append(args, *icon)
	}
	if position != nil {
		sets = append(sets, "position = ?")
		args = append(args, *position)
	}
	if archived != nil {
		sets = append(sets, "archived = ?")
		args = append(args, *archived)
	}
	if len(sets) == 0 {
		return GetProject(id)
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, time.Now().UTC(), id)
	res, err := db.DB.Exec(`UPDATE projects SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("update project %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, nil
	}
	return GetProject(id)
}

// DeleteProject hard-deletes a project; milestones and cards cascade.
func DeleteProject(id string) error {
	if _, err := db.DB.Exec(`DELETE FROM projects WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete project %s: %w", id, err)
	}
	return nil
}

// CreateProjectMilestone appends a milestone to a project's roadmap in its own
// board track. Returns nil if the project is gone.
func CreateProjectMilestone(projectID, title string, dueAt *time.Time) (*models.ProjectMilestone, error) {
	var exists int
	if err := db.DB.QueryRow(`SELECT 1 FROM projects WHERE id = ?`, projectID).Scan(&exists); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	now := time.Now().UTC()
	m := &models.ProjectMilestone{
		ID:        uuid.NewString(),
		ProjectID: projectID,
		Title:     title,
		DueAt:     dueAt,
		CreatedAt: now,
		UpdatedAt: now,
	}
	_ = db.DB.QueryRow(`SELECT COALESCE(MAX(position)+1, 0) FROM project_milestones WHERE project_id = ?`, projectID).Scan(&m.Position)
	_ = db.DB.QueryRow(`SELECT COALESCE(MAX(track)+1, 0) FROM project_milestones WHERE project_id = ?`, projectID).Scan(&m.Track)
	if _, err := db.DB.Exec(
		`INSERT INTO project_milestones (id, project_id, title, due_at, track, position, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, m.ProjectID, m.Title, m.DueAt, m.Track, m.Position, m.CreatedAt, m.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("insert milestone: %w", err)
	}
	return m, nil
}

// UpdateProjectMilestone partially updates title/track/position/due date.
// clearDue wins over dueAt.
func UpdateProjectMilestone(id string, title *string, track *int, position *float64, dueAt *time.Time, clearDue bool) (*models.ProjectMilestone, error) {
	sets := []string{}
	args := []any{}
	if title != nil {
		sets = append(sets, "title = ?")
		args = append(args, *title)
	}
	if track != nil {
		sets = append(sets, "track = ?")
		args = append(args, *track)
	}
	if position != nil {
		sets = append(sets, "position = ?")
		args = append(args, *position)
	}
	if clearDue {
		sets = append(sets, "due_at = NULL")
	} else if dueAt != nil {
		sets = append(sets, "due_at = ?")
		args = append(args, *dueAt)
	}
	if len(sets) == 0 {
		return getProjectMilestone(id)
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, time.Now().UTC(), id)
	res, err := db.DB.Exec(`UPDATE project_milestones SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("update milestone %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, nil
	}
	return getProjectMilestone(id)
}

// DeleteProjectMilestone removes a board column. Its cards (graveyard
// included) move to the nearest surviving milestone first: the milestone was
// structure, and deleting structure must not delete work. Only when it is the
// project's last milestone do its cards go with it (FK cascade).
func DeleteProjectMilestone(id string) error {
	tx, err := db.DB.Begin()
	if err != nil {
		return fmt.Errorf("begin delete milestone: %w", err)
	}
	defer tx.Rollback()

	var fallback sql.NullString
	err = tx.QueryRow(
		`SELECT id FROM project_milestones
		 WHERE project_id = (SELECT project_id FROM project_milestones WHERE id = ?) AND id != ?
		 ORDER BY position ASC, created_at ASC LIMIT 1`, id, id,
	).Scan(&fallback)
	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("find fallback milestone: %w", err)
	}
	if fallback.Valid {
		if _, err := tx.Exec(
			`UPDATE project_cards SET milestone_id = ?, updated_at = ? WHERE milestone_id = ?`,
			fallback.String, time.Now().UTC(), id,
		); err != nil {
			return fmt.Errorf("rehome cards: %w", err)
		}
	}
	if _, err := tx.Exec(`DELETE FROM project_milestones WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete milestone %s: %w", id, err)
	}
	return tx.Commit()
}

// CreateProjectCards appends cards in one call, which is what makes pasting a
// ten-line brain dump ten cards in one request. Blank titles are skipped.
// Returns nil if the milestone is gone or not the project's.
func CreateProjectCards(projectID, milestoneID string, titles []string, authorID *string) ([]models.ProjectCard, error) {
	var exists int
	err := db.DB.QueryRow(
		`SELECT 1 FROM project_milestones WHERE id = ? AND project_id = ?`, milestoneID, projectID,
	).Scan(&exists)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	var pos float64
	_ = db.DB.QueryRow(`SELECT COALESCE(MAX(position)+1, 0) FROM project_cards WHERE milestone_id = ?`, milestoneID).Scan(&pos)

	tx, err := db.DB.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin create cards: %w", err)
	}
	defer tx.Rollback()
	out := []models.ProjectCard{}
	for _, t := range titles {
		title := strings.TrimSpace(t)
		if title == "" {
			continue
		}
		card := models.ProjectCard{
			ID:          uuid.NewString(),
			ProjectID:   projectID,
			MilestoneID: milestoneID,
			Title:       title,
			Position:    pos,
			AuthorID:    authorID,
			CreatedAt:   now,
			UpdatedAt:   now,
		}
		pos++
		if _, err := tx.Exec(
			`INSERT INTO project_cards (id, project_id, milestone_id, title, body, labels, priority, position, author_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, '', '', 0, ?, ?, ?, ?)`,
			card.ID, card.ProjectID, card.MilestoneID, card.Title, card.Position, card.AuthorID, card.CreatedAt, card.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("insert card: %w", err)
		}
		out = append(out, card)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit create cards: %w", err)
	}
	return out, nil
}

// ProjectCardPatch is a partial update. Non-nil means "set"; the Clear* flags
// null a nullable field and win over their pointer.
type ProjectCardPatch struct {
	Title           *string
	Body            *string
	Labels          *string
	Priority        *int
	MilestoneID     *string
	Position        *float64
	Done            *bool
	Dismissed       *bool
	DueAt           *time.Time
	ClearDueAt      bool
	AssigneeID      *string
	ClearAssigneeID bool
}

// UpdateProjectCard applies a partial update. Ticking done stamps
// completed_at (what the momentum strip reads); unticking clears it. Moving
// milestone and position land in one UPDATE, so a drag is one write.
func UpdateProjectCard(id string, p ProjectCardPatch) (*models.ProjectCard, error) {
	sets := []string{}
	args := []any{}
	if p.Title != nil {
		sets = append(sets, "title = ?")
		args = append(args, *p.Title)
	}
	if p.Body != nil {
		sets = append(sets, "body = ?")
		args = append(args, *p.Body)
	}
	if p.Labels != nil {
		sets = append(sets, "labels = ?")
		args = append(args, *p.Labels)
	}
	if p.Priority != nil {
		sets = append(sets, "priority = ?")
		args = append(args, *p.Priority)
	}
	if p.MilestoneID != nil {
		// Refuse a move to another project's milestone (or a deleted one)
		// rather than storing a dangling reference.
		var ok int
		err := db.DB.QueryRow(
			`SELECT 1 FROM project_milestones m JOIN project_cards c ON c.project_id = m.project_id
			 WHERE m.id = ? AND c.id = ?`, *p.MilestoneID, id,
		).Scan(&ok)
		if err == sql.ErrNoRows {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		sets = append(sets, "milestone_id = ?")
		args = append(args, *p.MilestoneID)
	}
	if p.Position != nil {
		sets = append(sets, "position = ?")
		args = append(args, *p.Position)
	}
	if p.Done != nil {
		sets = append(sets, "done = ?")
		args = append(args, *p.Done)
		if *p.Done {
			sets = append(sets, "completed_at = ?")
			args = append(args, time.Now().UTC())
		} else {
			sets = append(sets, "completed_at = NULL")
		}
	}
	if p.Dismissed != nil {
		sets = append(sets, "dismissed = ?")
		args = append(args, *p.Dismissed)
	}
	if p.ClearDueAt {
		sets = append(sets, "due_at = NULL")
	} else if p.DueAt != nil {
		sets = append(sets, "due_at = ?")
		args = append(args, *p.DueAt)
	}
	if p.ClearAssigneeID {
		sets = append(sets, "assignee_id = NULL")
	} else if p.AssigneeID != nil {
		sets = append(sets, "assignee_id = ?")
		args = append(args, *p.AssigneeID)
	}
	if len(sets) == 0 {
		return getProjectCard(id)
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, time.Now().UTC(), id)
	res, err := db.DB.Exec(`UPDATE project_cards SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("update card %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, nil
	}
	return getProjectCard(id)
}

// DeleteProjectCard hard-deletes one card, which is how the graveyard is
// emptied; the normal removal path is dismissal.
func DeleteProjectCard(id string) error {
	if _, err := db.DB.Exec(`DELETE FROM project_cards WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete card %s: %w", id, err)
	}
	return nil
}

// --- scanning ---

const projectColumns = `id, title, overview, accent, icon, author_id, position, archived, created_at, updated_at`

func scanProject(s scannerT) (*models.Project, error) {
	p := &models.Project{
		Milestones: []models.ProjectMilestone{},
		Cards:      []models.ProjectCard{},
		Documents:  []models.ProjectDocument{},
	}
	if err := s.Scan(&p.ID, &p.Title, &p.Overview, &p.Accent, &p.Icon, &p.AuthorID, &p.Position, &p.Archived, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, err
	}
	return p, nil
}

const projectMilestoneColumns = `id, project_id, title, due_at, track, position, created_at, updated_at`

func scanProjectMilestone(s scannerT) (*models.ProjectMilestone, error) {
	m := &models.ProjectMilestone{}
	var dueAt sql.NullTime
	if err := s.Scan(&m.ID, &m.ProjectID, &m.Title, &dueAt, &m.Track, &m.Position, &m.CreatedAt, &m.UpdatedAt); err != nil {
		return nil, err
	}
	if dueAt.Valid {
		m.DueAt = &dueAt.Time
	}
	return m, nil
}

func getProjectMilestone(id string) (*models.ProjectMilestone, error) {
	m, err := scanProjectMilestone(db.DB.QueryRow(`SELECT `+projectMilestoneColumns+` FROM project_milestones WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get milestone %s: %w", id, err)
	}
	return m, nil
}

const projectCardColumns = `id, project_id, milestone_id, title, body, labels, priority, due_at, assignee_id,
	 done, completed_at, dismissed, position, author_id, created_at, updated_at`

func scanProjectCard(s scannerT) (*models.ProjectCard, error) {
	c := &models.ProjectCard{}
	var assignee sql.NullString
	var dueAt, completedAt sql.NullTime
	if err := s.Scan(
		&c.ID, &c.ProjectID, &c.MilestoneID, &c.Title, &c.Body, &c.Labels, &c.Priority, &dueAt, &assignee,
		&c.Done, &completedAt, &c.Dismissed, &c.Position, &c.AuthorID, &c.CreatedAt, &c.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if dueAt.Valid {
		c.DueAt = &dueAt.Time
	}
	if completedAt.Valid {
		c.CompletedAt = &completedAt.Time
	}
	if assignee.Valid {
		c.AssigneeID = &assignee.String
	}
	return c, nil
}

func getProjectCard(id string) (*models.ProjectCard, error) {
	c, err := scanProjectCard(db.DB.QueryRow(`SELECT `+projectCardColumns+` FROM project_cards WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get card %s: %w", id, err)
	}
	return c, nil
}

func getMilestonesForProjects(ids []string) (map[string][]models.ProjectMilestone, error) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := db.DB.Query(
		`SELECT `+projectMilestoneColumns+` FROM project_milestones WHERE project_id IN (`+placeholders+`)
		 ORDER BY position ASC, created_at ASC`, args...,
	)
	if err != nil {
		return nil, fmt.Errorf("get milestones: %w", err)
	}
	defer rows.Close()
	out := map[string][]models.ProjectMilestone{}
	for rows.Next() {
		m, err := scanProjectMilestone(rows)
		if err != nil {
			return nil, fmt.Errorf("scan milestone: %w", err)
		}
		out[m.ProjectID] = append(out[m.ProjectID], *m)
	}
	return out, rows.Err()
}

func getCardsForProjects(ids []string) (map[string][]models.ProjectCard, error) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := db.DB.Query(
		`SELECT `+projectCardColumns+` FROM project_cards WHERE project_id IN (`+placeholders+`)
		 ORDER BY position ASC, created_at ASC`, args...,
	)
	if err != nil {
		return nil, fmt.Errorf("get cards: %w", err)
	}
	defer rows.Close()
	out := map[string][]models.ProjectCard{}
	for rows.Next() {
		c, err := scanProjectCard(rows)
		if err != nil {
			return nil, fmt.Errorf("scan card: %w", err)
		}
		out[c.ProjectID] = append(out[c.ProjectID], *c)
	}
	return out, rows.Err()
}

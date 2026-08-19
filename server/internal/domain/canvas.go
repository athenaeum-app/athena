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

// Canvas module (ADR-0013): server-synced, library-shared,
// last-write-wins. Hard delete + audit (ADR-0010). DeleteCanvas returns the
// pre-delete state so the API layer can retain it in the audit log. No
// permission checks here; the API layer gates on permissions.ManageCanvas.

// ListCanvases returns every canvas with its nodes attached.
func ListCanvases() ([]models.Canvas, error) {
	rows, err := db.DB.Query(
		`SELECT id, title, author_id, created_at, updated_at FROM canvases ORDER BY updated_at DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("list canvases: %w", err)
	}
	defer rows.Close()

	out := []models.Canvas{}
	ids := []string{}
	for rows.Next() {
		var canvas models.Canvas
		canvas.Nodes = []models.CanvasNode{}
		canvas.Edges = []models.CanvasEdge{}
		if err := rows.Scan(&canvas.ID, &canvas.Title, &canvas.AuthorID, &canvas.CreatedAt, &canvas.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan canvas: %w", err)
		}
		out = append(out, canvas)
		ids = append(ids, canvas.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return out, nil
	}
	nodesByCanvas, err := getNodesForCanvases(ids)
	if err != nil {
		return nil, err
	}
	edgesByCanvas, err := getEdgesForCanvases(ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		if nodes := nodesByCanvas[out[i].ID]; nodes != nil {
			out[i].Nodes = nodes
		}
		if edges := edgesByCanvas[out[i].ID]; edges != nil {
			out[i].Edges = edges
		}
	}
	return out, nil
}

// GetCanvas fetches one canvas with its nodes and edges. Returns nil if not found.
func GetCanvas(id string) (*models.Canvas, error) {
	canvas := &models.Canvas{Nodes: []models.CanvasNode{}, Edges: []models.CanvasEdge{}}
	err := db.DB.QueryRow(
		`SELECT id, title, author_id, created_at, updated_at FROM canvases WHERE id = ?`, id,
	).Scan(&canvas.ID, &canvas.Title, &canvas.AuthorID, &canvas.CreatedAt, &canvas.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get canvas %s: %w", id, err)
	}
	nodes, err := getNodesForCanvases([]string{id})
	if err != nil {
		return nil, err
	}
	if canvasNodes := nodes[id]; canvasNodes != nil {
		canvas.Nodes = canvasNodes
	}
	edges, err := getEdgesForCanvases([]string{id})
	if err != nil {
		return nil, err
	}
	if canvasEdges := edges[id]; canvasEdges != nil {
		canvas.Edges = canvasEdges
	}
	return canvas, nil
}

// CreateCanvas inserts a new empty canvas.
func CreateCanvas(title string, authorID *string) (*models.Canvas, error) {
	now := time.Now().UTC()
	canvas := &models.Canvas{
		ID:        uuid.NewString(),
		Title:     title,
		AuthorID:  authorID,
		CreatedAt: now,
		UpdatedAt: now,
		Nodes:     []models.CanvasNode{},
		Edges:     []models.CanvasEdge{},
	}
	_, err := db.DB.Exec(
		`INSERT INTO canvases (id, title, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		canvas.ID, canvas.Title, canvas.AuthorID, canvas.CreatedAt, canvas.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert canvas: %w", err)
	}
	return canvas, nil
}

// UpdateCanvas updates the title and bumps updated_at.
func UpdateCanvas(id string, title *string) (*models.Canvas, error) {
	if title == nil {
		return GetCanvas(id)
	}
	res, err := db.DB.Exec(
		`UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?`, *title, time.Now().UTC(), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update canvas %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, nil
	}
	return GetCanvas(id)
}

// DeleteCanvas hard-deletes a canvas (nodes cascade). It first loads the full
// canvas so the caller can retain the pre-delete state in the audit log.
// Returns nil if the canvas did not exist.
func DeleteCanvas(id string) (*models.Canvas, error) {
	pre, err := GetCanvas(id)
	if err != nil {
		return nil, err
	}
	if pre == nil {
		return nil, nil
	}
	if _, err := db.DB.Exec(`DELETE FROM canvases WHERE id = ?`, id); err != nil {
		return nil, fmt.Errorf("delete canvas %s: %w", id, err)
	}
	return pre, nil
}

// allowedCanvasKinds is the set of node kinds that persist as-is. Any other
// kind falls back to text (see CreateCanvasNode) so unknown kinds are tolerated.
var allowedCanvasKinds = map[string]bool{
	models.CanvasNodeMomentRef:  true,
	models.CanvasNodeText:       true,
	models.CanvasNodeImage:      true,
	models.CanvasNodeSticky:     true,
	models.CanvasNodeShape:      true,
	models.CanvasNodeLink:       true,
	models.CanvasNodeTodoRef:    true,
	models.CanvasNodeProjectRef: true,
	models.CanvasNodeCanvasRef:  true,
}

// CreateCanvasNode adds a node. Returns nil if the canvas is gone. style is an
// optional JSON blob (nil = no styling).
func CreateCanvasNode(canvasID, kind string, x, y, w, h float64, content string, style *string) (*models.CanvasNode, error) {
	var exists int
	if err := db.DB.QueryRow(`SELECT 1 FROM canvases WHERE id = ?`, canvasID).Scan(&exists); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	if !allowedCanvasKinds[kind] {
		kind = models.CanvasNodeText
	}
	now := time.Now().UTC()
	canvasNode := &models.CanvasNode{
		ID:        uuid.NewString(),
		CanvasID:  canvasID,
		Kind:      kind,
		X:         x,
		Y:         y,
		W:         w,
		H:         h,
		Content:   content,
		Style:     style,
		CreatedAt: now,
		UpdatedAt: now,
	}
	_ = db.DB.QueryRow(`SELECT COALESCE(MAX(z_order)+1, 0) FROM canvas_nodes WHERE canvas_id = ?`, canvasID).Scan(&canvasNode.ZOrder)
	_, err := db.DB.Exec(
		`INSERT INTO canvas_nodes (id, canvas_id, kind, x, y, w, h, z_order, content, style, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		canvasNode.ID, canvasNode.CanvasID, canvasNode.Kind, canvasNode.X, canvasNode.Y, canvasNode.W, canvasNode.H, canvasNode.ZOrder, canvasNode.Content, canvasNode.Style, canvasNode.CreatedAt, canvasNode.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert canvas node: %w", err)
	}
	touchCanvas(canvasID)
	return canvasNode, nil
}

// UpdateCanvasNode partially updates geometry/content/z-order/style. nil =
// unchanged. A non-nil style of "" clears the styling.
func UpdateCanvasNode(id string, x, y, w, h *float64, zOrder *int, content, style *string) (*models.CanvasNode, error) {
	sets := []string{}
	args := []any{}
	addF := func(col string, v *float64) {
		if v != nil {
			sets = append(sets, col+" = ?")
			args = append(args, *v)
		}
	}
	addF("x", x)
	addF("y", y)
	addF("w", w)
	addF("h", h)
	if zOrder != nil {
		sets = append(sets, "z_order = ?")
		args = append(args, *zOrder)
	}
	if content != nil {
		sets = append(sets, "content = ?")
		args = append(args, *content)
	}
	if style != nil {
		sets = append(sets, "style = ?")
		if *style == "" {
			args = append(args, nil)
		} else {
			args = append(args, *style)
		}
	}
	if len(sets) == 0 {
		return getCanvasNode(id)
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, time.Now().UTC(), id)
	res, err := db.DB.Exec(`UPDATE canvas_nodes SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("update canvas node %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, nil
	}
	node, err := getCanvasNode(id)
	if err == nil && node != nil {
		touchCanvas(node.CanvasID)
	}
	return node, err
}

// DeleteCanvasNode hard-deletes a single node.
func DeleteCanvasNode(id string) error {
	node, _ := getCanvasNode(id)
	if _, err := db.DB.Exec(`DELETE FROM canvas_nodes WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete canvas node %s: %w", id, err)
	}
	if node != nil {
		touchCanvas(node.CanvasID)
	}
	return nil
}

func touchCanvas(id string) {
	_, _ = db.DB.Exec(`UPDATE canvases SET updated_at = ? WHERE id = ?`, time.Now().UTC(), id)
}

func getCanvasNode(id string) (*models.CanvasNode, error) {
	canvasNode := &models.CanvasNode{}
	var style sql.NullString
	err := db.DB.QueryRow(
		`SELECT id, canvas_id, kind, x, y, w, h, z_order, content, style, created_at, updated_at
		 FROM canvas_nodes WHERE id = ?`, id,
	).Scan(&canvasNode.ID, &canvasNode.CanvasID, &canvasNode.Kind, &canvasNode.X, &canvasNode.Y, &canvasNode.W, &canvasNode.H, &canvasNode.ZOrder, &canvasNode.Content, &style, &canvasNode.CreatedAt, &canvasNode.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get canvas node %s: %w", id, err)
	}
	if style.Valid {
		canvasNode.Style = &style.String
	}
	return canvasNode, nil
}

func getNodesForCanvases(canvasIDs []string) (map[string][]models.CanvasNode, error) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(canvasIDs)), ",")
	args := make([]any, len(canvasIDs))
	for i, id := range canvasIDs {
		args[i] = id
	}
	rows, err := db.DB.Query(
		`SELECT id, canvas_id, kind, x, y, w, h, z_order, content, style, created_at, updated_at
		 FROM canvas_nodes WHERE canvas_id IN (`+placeholders+`) ORDER BY z_order ASC`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("get canvas nodes: %w", err)
	}
	defer rows.Close()

	out := map[string][]models.CanvasNode{}
	for rows.Next() {
		var n models.CanvasNode
		var style sql.NullString
		if err := rows.Scan(&n.ID, &n.CanvasID, &n.Kind, &n.X, &n.Y, &n.W, &n.H, &n.ZOrder, &n.Content, &style, &n.CreatedAt, &n.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan canvas node: %w", err)
		}
		if style.Valid {
			n.Style = &style.String
		}
		out[n.CanvasID] = append(out[n.CanvasID], n)
	}
	return out, rows.Err()
}

// --- Canvas edges (connectors) ---

// getEdgesForCanvases returns edges grouped by canvas id.
func getEdgesForCanvases(canvasIDs []string) (map[string][]models.CanvasEdge, error) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(canvasIDs)), ",")
	args := make([]any, len(canvasIDs))
	for i, id := range canvasIDs {
		args[i] = id
	}
	rows, err := db.DB.Query(
		`SELECT id, canvas_id, from_node, to_node, created_at
		 FROM canvas_edges WHERE canvas_id IN (`+placeholders+`) ORDER BY created_at ASC`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("get canvas edges: %w", err)
	}
	defer rows.Close()

	out := map[string][]models.CanvasEdge{}
	for rows.Next() {
		var edge models.CanvasEdge
		if err := rows.Scan(&edge.ID, &edge.CanvasID, &edge.FromNode, &edge.ToNode, &edge.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan canvas edge: %w", err)
		}
		out[edge.CanvasID] = append(out[edge.CanvasID], edge)
	}
	return out, rows.Err()
}

// CreateCanvasEdge connects two nodes. Returns nil if the canvas is gone or
// either endpoint does not belong to it. Duplicate edges (same from/to) are
// collapsed to the existing edge.
func CreateCanvasEdge(canvasID, fromNode, toNode string) (*models.CanvasEdge, error) {
	if fromNode == toNode {
		return nil, nil
	}
	var count int
	if err := db.DB.QueryRow(
		`SELECT COUNT(*) FROM canvas_nodes WHERE canvas_id = ? AND id IN (?, ?)`,
		canvasID, fromNode, toNode,
	).Scan(&count); err != nil {
		return nil, fmt.Errorf("validate edge endpoints: %w", err)
	}
	if count < 2 {
		return nil, nil
	}
	// Collapse duplicates (either direction).
	existing := &models.CanvasEdge{}
	err := db.DB.QueryRow(
		`SELECT id, canvas_id, from_node, to_node, created_at FROM canvas_edges
		 WHERE canvas_id = ? AND ((from_node = ? AND to_node = ?) OR (from_node = ? AND to_node = ?))`,
		canvasID, fromNode, toNode, toNode, fromNode,
	).Scan(&existing.ID, &existing.CanvasID, &existing.FromNode, &existing.ToNode, &existing.CreatedAt)
	if err == nil {
		return existing, nil
	}
	if err != sql.ErrNoRows {
		return nil, fmt.Errorf("check existing edge: %w", err)
	}
	edge := &models.CanvasEdge{
		ID:        uuid.NewString(),
		CanvasID:  canvasID,
		FromNode:  fromNode,
		ToNode:    toNode,
		CreatedAt: time.Now().UTC(),
	}
	if _, err := db.DB.Exec(
		`INSERT INTO canvas_edges (id, canvas_id, from_node, to_node, created_at) VALUES (?, ?, ?, ?, ?)`,
		edge.ID, edge.CanvasID, edge.FromNode, edge.ToNode, edge.CreatedAt,
	); err != nil {
		return nil, fmt.Errorf("insert canvas edge: %w", err)
	}
	touchCanvas(canvasID)
	return edge, nil
}

// DeleteCanvasEdge removes a single edge.
func DeleteCanvasEdge(id string) error {
	var canvasID string
	_ = db.DB.QueryRow(`SELECT canvas_id FROM canvas_edges WHERE id = ?`, id).Scan(&canvasID)
	if _, err := db.DB.Exec(`DELETE FROM canvas_edges WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete canvas edge %s: %w", id, err)
	}
	if canvasID != "" {
		touchCanvas(canvasID)
	}
	return nil
}

-- 0005_canvas_extend.up.sql
-- Canvas module extensions (v2.2): per-node styling and node-to-node
-- connectors (edges). Both are additive to the 0003 canvas tables.

-- Per-node style: a nullable JSON blob, e.g. {"color":"#8899aa","fontSize":14}.
-- Kept separate from `content` so content semantics stay unchanged.
ALTER TABLE canvas_nodes ADD COLUMN style TEXT;

-- Connectors between nodes. Edges cascade-delete with their canvas and with
-- either endpoint node (foreign_keys pragma is enabled, see db.go).
CREATE TABLE canvas_edges (
    id           TEXT PRIMARY KEY,
    canvas_id    TEXT NOT NULL,
    from_node    TEXT NOT NULL,
    to_node      TEXT NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE,
    FOREIGN KEY (from_node) REFERENCES canvas_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_node) REFERENCES canvas_nodes(id) ON DELETE CASCADE
);
CREATE INDEX idx_canvas_edges_canvas ON canvas_edges(canvas_id);

-- 0005_canvas_extend.down.sql
DROP INDEX IF EXISTS idx_canvas_edges_canvas;
DROP TABLE IF EXISTS canvas_edges;
ALTER TABLE canvas_nodes DROP COLUMN style;

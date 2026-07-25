-- 0003_v21_modules.down.sql
DROP TABLE IF EXISTS canvas_nodes;
DROP TABLE IF EXISTS canvases;
DROP TABLE IF EXISTS todo_items;
DROP TABLE IF EXISTS todo_lists;
DROP INDEX IF EXISTS idx_moments_pinned;
ALTER TABLE moments DROP COLUMN pinned;

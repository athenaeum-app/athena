-- 0006_todo_item_fields.down.sql
DROP INDEX IF EXISTS idx_todo_items_due;
DROP INDEX IF EXISTS idx_todo_items_parent;
ALTER TABLE todo_items DROP COLUMN parent_id;
ALTER TABLE todo_items DROP COLUMN recurrence;
ALTER TABLE todo_items DROP COLUMN moment_id;
ALTER TABLE todo_items DROP COLUMN priority;
ALTER TABLE todo_items DROP COLUMN due_at;

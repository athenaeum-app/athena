-- 0006_todo_item_fields.up.sql
-- v2.3 task upgrades (§2): due dates, priority, moment links, recurrence, and
-- one level of subtasks. All columns are nullable / defaulted so ADD COLUMN is
-- valid on the existing table and existing rows keep working unchanged.

ALTER TABLE todo_items ADD COLUMN due_at DATETIME;
ALTER TABLE todo_items ADD COLUMN priority INTEGER NOT NULL DEFAULT 0; -- 0 none, 1 low, 2 med, 3 high
ALTER TABLE todo_items ADD COLUMN moment_id TEXT REFERENCES moments(id) ON DELETE SET NULL;
ALTER TABLE todo_items ADD COLUMN recurrence TEXT NOT NULL DEFAULT ''; -- '' | 'daily' | 'weekly' | 'monthly'
ALTER TABLE todo_items ADD COLUMN parent_id TEXT REFERENCES todo_items(id) ON DELETE CASCADE;

CREATE INDEX idx_todo_items_parent ON todo_items(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_todo_items_due ON todo_items(due_at) WHERE due_at IS NOT NULL;

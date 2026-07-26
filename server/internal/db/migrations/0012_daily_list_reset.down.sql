-- 0012_daily_list_reset.down.sql
-- The cleared recurrence rules and rolled_over flags are not recoverable; only
-- the column comes back.
ALTER TABLE todo_lists DROP COLUMN reset_mode;

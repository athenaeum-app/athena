-- 0012_daily_list_reset.up.sql
-- Daily lists clear themselves now, rather than waiting for someone to press
-- Reset, and "reset" means unchecking rather than deleting.
--
-- reset_mode says when a daily list's ticks clear: 'calendar' at the start of
-- each local day, 'interval' 24 hours after each item was ticked off. Existing
-- lists adopt 'calendar', which is what "daily" is normally taken to mean. The
-- column sits on every list for schema simplicity, but only daily lists
-- consult it.
ALTER TABLE todo_lists ADD COLUMN reset_mode TEXT NOT NULL DEFAULT 'calendar';

-- Per-item Repeat is redundant on a daily list now that the list itself is the
-- cycle, so those controls are gone from daily items. Clear the rules already
-- stored against them: left in place they would keep the server unchecking
-- items on a schedule the UI no longer shows, or lets anyone change. Due dates
-- are deliberately left alone; they are merely hidden on daily items, so
-- nothing is lost if a list is ever switched back.
UPDATE todo_items SET recurrence = ''
 WHERE recurrence != '' AND list_id IN (SELECT id FROM todo_lists WHERE kind = 'daily');

-- A reset no longer parks unfinished items in an "unfinished from yesterday"
-- pile, and the client no longer renders one, so drain the flag rather than
-- leaving rows stranded in a section that can never appear again.
UPDATE todo_items SET rolled_over = 0 WHERE rolled_over = 1;

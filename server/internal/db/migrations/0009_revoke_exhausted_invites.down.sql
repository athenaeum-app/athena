-- 0009_revoke_exhausted_invites.down.sql
-- Nothing to undo.
--
-- The up migration deleted invites that were already exhausted, and what it
-- deleted is not recorded anywhere, so there is nothing to put back. Those
-- rows could not have admitted anyone either way.
SELECT 1;

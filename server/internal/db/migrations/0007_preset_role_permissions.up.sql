-- 0007_preset_role_permissions.up.sql
-- Give the preset roles the permission bundles they were always meant to
-- carry. Migration 0002 created Member, Viewer, Editor and Admin with
-- permissions = 0, so on any server that wasn't seeded with demo data every
-- role granted nothing: a newly invited user held Member, Member granted no
-- VIEW_MOMENTS, and the whole library came back empty for them.
--
-- The literals below mirror the bundles in
-- server/internal/permissions/permissions.go. TestPresetRoleMigrationMatchesConstants
-- fails if the two ever drift.
--
-- Only roles still sitting at 0 are touched, so an operator who has already
-- customised a preset keeps their edits. The Owner row is the exception: it
-- is not editable through the API, so restoring the full mask (including the
-- ADMINISTRATOR wildcard) can never clobber a deliberate change, and doing it
-- unconditionally repairs any server whose owner lost administration.

UPDATE roles SET permissions = 791,      updated_at = CURRENT_TIMESTAMP WHERE id = 'role_member' AND permissions = 0;
UPDATE roles SET permissions = 769,      updated_at = CURRENT_TIMESTAMP WHERE id = 'role_viewer' AND permissions = 0;
UPDATE roles SET permissions = 12247,    updated_at = CURRENT_TIMESTAMP WHERE id = 'role_editor' AND permissions = 0;
UPDATE roles SET permissions = 16187391, updated_at = CURRENT_TIMESTAMP WHERE id = 'role_admin'  AND permissions = 0;
UPDATE roles SET permissions = 16777215, updated_at = CURRENT_TIMESTAMP WHERE id = 'role_owner';

-- The owner must actually hold the Owner role for that mask to reach them.
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT id, 'role_owner' FROM users WHERE is_owner = 1
  AND EXISTS (SELECT 1 FROM roles WHERE id = 'role_owner');

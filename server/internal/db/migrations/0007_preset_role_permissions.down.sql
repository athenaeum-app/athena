-- 0007_preset_role_permissions.down.sql
-- Restore the (broken) all-zero state migration 0002 left the preset roles
-- in. role_owner is left alone: it is created at runtime by the registration
-- flow, not by 0002, so zeroing it here would lock the owner out rather than
-- undo anything this migration did.
UPDATE roles SET permissions = 0 WHERE id IN ('role_member', 'role_viewer', 'role_editor', 'role_admin');

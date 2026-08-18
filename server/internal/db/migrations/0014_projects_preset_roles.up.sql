-- 0014_projects_preset_roles.up.sql
-- Grant MANAGE_PROJECTS (bit 24) to the Admin and Owner preset roles, so the
-- new module is usable by the people every other module trusts. Viewer and
-- Editor are untouched: contributing to projects is granted deliberately,
-- like todos and canvas.
--
-- 16187391 -> 32964607 is AdminPerms gaining bit 24; 16777215 -> 33554431 is
-- OwnerPerms doing the same. The WHERE pins the old value so an operator who
-- customised a preset keeps their edits (same pattern as 0011). The literals
-- mirror server/internal/permissions/permissions.go.
UPDATE roles
SET permissions = 32964607, updated_at = CURRENT_TIMESTAMP
WHERE id = 'role_admin' AND permissions = 16187391;

UPDATE roles
SET permissions = 33554431, updated_at = CURRENT_TIMESTAMP
WHERE id = 'role_owner' AND permissions = 16777215;

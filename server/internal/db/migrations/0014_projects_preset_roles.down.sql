-- 0014_projects_preset_roles.down.sql
UPDATE roles
SET permissions = 16187391, updated_at = CURRENT_TIMESTAMP
WHERE id = 'role_admin' AND permissions = 32964607;

UPDATE roles
SET permissions = 16777215, updated_at = CURRENT_TIMESTAMP
WHERE id = 'role_owner' AND permissions = 33554431;

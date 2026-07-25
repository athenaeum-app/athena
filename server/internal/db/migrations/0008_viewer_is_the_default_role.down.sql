-- 0008_viewer_is_the_default_role.down.sql
-- Put Member back as the default role.
--
-- Who held Member is not recoverable: the up migration folded those users into
-- Viewer, and there is no record of which of them were already there. So this
-- recreates the role, makes it default again, and re-assigns it to every user,
-- which is what being the default meant anyway.
--
-- Viewer is left exactly as it is, because the up migration did not change it.
INSERT OR IGNORE INTO roles (id, name, color, position, is_preset, is_default, permissions)
VALUES ('role_member', 'Member', '#95a5a6', 0, 1, 1, 791);

UPDATE roles SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 'role_member';
UPDATE roles SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE id = 'role_viewer';

INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT id, 'role_member' FROM users;

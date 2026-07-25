-- 0002_preset_roles.up.sql
-- Insert preset roles. The Owner role is created when the first user
-- registers (see auth package); here we create Member, Admin, Editor, Viewer.

-- Member (default role, every user has it)
INSERT INTO roles (id, name, color, position, is_preset, is_default, permissions) VALUES
    ('role_member', 'Member', '#95a5a6', 0, 1, 1, 0);

-- Viewer
INSERT INTO roles (id, name, color, position, is_preset, is_default, permissions) VALUES
    ('role_viewer', 'Viewer', '#3498db', 1, 1, 0, 0);

-- Editor
INSERT INTO roles (id, name, color, position, is_preset, is_default, permissions) VALUES
    ('role_editor', 'Editor', '#2ecc71', 2, 1, 0, 0);

-- Admin
INSERT INTO roles (id, name, color, position, is_preset, is_default, permissions) VALUES
    ('role_admin', 'Admin', '#e74c3c', 3, 1, 0, 0);

-- Default settings
INSERT INTO settings (key, value) VALUES
    ('show_legacy_moment_badges', 'true'),
    ('show_legacy_chat_badges', 'true');

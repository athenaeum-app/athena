DELETE FROM settings WHERE key IN ('show_legacy_moment_badges', 'show_legacy_chat_badges');
DELETE FROM roles WHERE id IN ('role_member', 'role_viewer', 'role_editor', 'role_admin');

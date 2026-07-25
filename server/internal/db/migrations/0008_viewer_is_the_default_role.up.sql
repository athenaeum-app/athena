-- 0008_viewer_is_the_default_role.up.sql
-- Make Viewer the default role, and retire Member.
--
-- Every user holds the default role, so whatever it grants is the floor for
-- the whole library. Member sat at that floor while granting CREATE_MOMENT,
-- EDIT_OWN_MOMENT and DELETE_OWN_MOMENT, so anyone who got in through an
-- invite could immediately write to the library, and the only way to have a
-- genuinely read-only member was to edit the preset. The floor is now Viewer:
-- sees everything, adds nothing to the library, and can still talk in chat.
--
-- That leaves Member with nothing to be: it existed to be the default. Its
-- holders move to Viewer and the role is retired, rather than left behind as a
-- preset that no longer means anything.
--
-- Viewer's own permissions are unchanged (migration 0007 set them). Anyone who
-- was relying on Member to grant *writing* loses it here, which is the intended
-- change but a real one: give those people Editor.

-- Carry Member's holders over first, so nobody is left with no role at all
-- when it goes. INSERT OR IGNORE because most already hold Viewer.
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT user_id, 'role_viewer' FROM user_roles WHERE role_id = 'role_member';

-- Move the default flag. Only these two rows are touched: a server whose
-- operator made some custom role default keeps that as well.
UPDATE roles SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE id = 'role_member';
UPDATE roles SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 'role_viewer';

-- user_roles rows for Member go with it (ON DELETE CASCADE).
DELETE FROM roles WHERE id = 'role_member';

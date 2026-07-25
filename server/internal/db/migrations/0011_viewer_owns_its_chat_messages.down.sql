-- 0011_viewer_owns_its_chat_messages.down.sql
UPDATE roles
SET permissions = 769, updated_at = CURRENT_TIMESTAMP
WHERE id = 'role_viewer' AND permissions = 3841;

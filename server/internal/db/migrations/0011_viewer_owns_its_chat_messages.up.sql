-- 0011_viewer_owns_its_chat_messages.up.sql
-- Grant Viewer EDIT_OWN_CHAT_MESSAGE and DELETE_OWN_CHAT_MESSAGE.
--
-- Viewer is the default role, so this is what everyone arriving by invite
-- holds. It could already post to chat but not fix a typo or retract what it
-- had just said, which is not a coherent floor: the message is theirs either
-- way. Nothing here touches other people's messages, which still needs a
-- wider role.
--
-- 769 is the old bundle (VIEW_MOMENTS | VIEW_CHAT | SEND_CHAT_MESSAGE); 3841
-- adds bits 10 and 11. The WHERE clause pins the old value rather than testing
-- for 0, so an operator who has already customised Viewer keeps their edits
-- instead of having them overwritten. The literal mirrors ViewerPerms in
-- server/internal/permissions/permissions.go.
UPDATE roles
SET permissions = 3841, updated_at = CURRENT_TIMESTAMP
WHERE id = 'role_viewer' AND permissions = 769;

-- 0017_chat_replies.up.sql
-- A chat reply used to be a markdown blockquote: the text of the message being
-- answered, copied into the answer. Nothing tied the two rows together, so the
-- copy went stale when the original was edited, could not be followed back to
-- what it answered, and dropped anything that was not prose on the way in.
--
-- The link is a column instead. NULL is an ordinary message.
--
-- ON DELETE SET NULL rather than CASCADE: a reply is a message in its own
-- right and its own author's, and the row it points at is hard-deleted by the
-- prune worker long after the soft delete. When the original finally goes the
-- reply stays and reads as an ordinary message, which is the same thing the
-- client already draws while the original is only soft-deleted.
--
-- No depth cap, unlike document comment threads. A reply points at exactly one
-- message and is drawn as a single preview line of it, so a reply to a reply is
-- still one line deep on screen (ADR-0015) and there is no tree to bound.

ALTER TABLE chat_messages ADD COLUMN reply_to_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL;

CREATE INDEX idx_chat_messages_reply_to ON chat_messages(reply_to_id) WHERE reply_to_id IS NOT NULL;

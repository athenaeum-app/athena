-- 0017_chat_replies.down.sql
DROP INDEX IF EXISTS idx_chat_messages_reply_to;
ALTER TABLE chat_messages DROP COLUMN reply_to_id;

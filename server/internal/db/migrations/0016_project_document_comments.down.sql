-- 0016_project_document_comments.down.sql
DROP INDEX IF EXISTS idx_project_document_comments_parent;
DROP INDEX IF EXISTS idx_project_document_comments_document;
DROP TABLE IF EXISTS project_document_comments;

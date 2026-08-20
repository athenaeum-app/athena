-- 0015_project_documents.down.sql
DROP INDEX IF EXISTS idx_project_document_versions_document;
DROP TABLE IF EXISTS project_document_versions;
DROP INDEX IF EXISTS idx_project_documents_parent;
DROP INDEX IF EXISTS idx_project_documents_project;
DROP TABLE IF EXISTS project_documents;

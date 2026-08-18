-- 0013_projects.down.sql
DROP INDEX IF EXISTS idx_project_cards_milestone;
DROP INDEX IF EXISTS idx_project_cards_project;
DROP TABLE IF EXISTS project_cards;
DROP INDEX IF EXISTS idx_project_milestones_project;
DROP TABLE IF EXISTS project_milestones;
DROP TABLE IF EXISTS projects;

-- 0004_archive_unique_name.up.sql
-- Archives model hardening: enforce case-insensitive uniqueness on archive
-- names. Moments link to archives by archive_id (a foreign key), so this
-- index constrains names only and never affects moment membership.
CREATE UNIQUE INDEX idx_archives_name_nocase ON archives(name COLLATE NOCASE);

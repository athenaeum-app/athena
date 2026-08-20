-- 0015_project_documents.up.sql
-- Projects module: the Documents tab. A document is project-owned durable
-- reference content (decisions, research, resources) and a folder is the
-- container it sits in. Both are rows in one tree per project, so moving a
-- document into a folder is a single parent_id write, and folders nest
-- without limit (ADR-0020).
--
-- A document is not a moment: it never lands in an archive, the journal feed
-- or its search, is never done, carries no priority and cannot be dismissed.
-- Deletion is hard and recursive through the parent_id cascade, per ADR-0010's
-- rule for structural entities; the delete response hands the removed subtree
-- back so the client's undo stack can restore it with identity intact.
--
-- Positions are REAL for the same reason the milestone and card boards use
-- them: a drop between two siblings is one write (the midpoint), never a
-- renumber.

CREATE TABLE project_documents (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    -- NULL means the row sits at the Documents tab's root.
    parent_id    TEXT,
    kind         TEXT NOT NULL CHECK (kind IN ('folder', 'document')),
    title        TEXT NOT NULL DEFAULT '',
    -- Markdown rendered with the moment pipeline, same as a card body, so a
    -- document embeds todo lists, canvases and moment references. Folders
    -- carry no body and keep this empty.
    body         TEXT NOT NULL DEFAULT '',
    -- Locked refuses title and body edits until it is unlocked; it is the
    -- badge for "this decision is decided".
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final', 'locked')),
    position     REAL NOT NULL DEFAULT 0,
    author_id    TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES project_documents(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_project_documents_project ON project_documents(project_id);
CREATE INDEX idx_project_documents_parent ON project_documents(parent_id) WHERE parent_id IS NOT NULL;

-- Version snapshots stand in for the safety net soft delete gives moments:
-- a document has no tombstone, so its history is what makes an edit reversible.
-- Bodies are stored whole, which is why they are never nested in the project
-- payload and only the single-version endpoint returns one.
CREATE TABLE project_document_versions (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    author_id    TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (document_id) REFERENCES project_documents(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_project_document_versions_document ON project_document_versions(document_id);

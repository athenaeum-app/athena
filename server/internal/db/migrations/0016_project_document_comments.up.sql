-- 0016_project_document_comments.up.sql
-- Comments on a project document (ADR-0020). A comment hangs off a block of
-- the document, never off a character range: a document is edited through the
-- same composer a moment is, the whole body is rewritten on every save, and an
-- offset pair would be stale the moment a word was added above it.
--
-- The anchor is therefore a pair: the index of the block in source order, and
-- a fingerprint of its text. The client resolves the fingerprint first and
-- falls back to the index, so a comment survives edits elsewhere in the
-- document; when neither matches it is shown as orphaned rather than being
-- silently moved onto whatever now sits at that index. Anchors are never
-- rewritten by the server: the pair records where the reader was pointing, and
-- resolving it is the client's job.
--
-- Threads are one level deep, the same cap todo subtasks keep, so a discussion
-- reads as a list rather than a tree. A reply carries a copy of its parent's
-- anchor so every row knows the block it belongs to without a join.
--
-- Resolved is a thread property, held on the first comment of the thread.
-- Deleting is allowed and is hard: a comment has no tombstone, and deleting a
-- thread root takes its replies through the parent_id cascade.

CREATE TABLE project_document_comments (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL,
    -- NULL means the comment starts a thread. Set means it is a reply, and it
    -- always points at a thread root, never at another reply.
    parent_id    TEXT,
    -- Which block of the body, counted in source order from 0.
    anchor_index INTEGER NOT NULL DEFAULT 0,
    -- The block's text, normalized and truncated: enough to recognize the
    -- block again after the document has moved around it.
    anchor_text  TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL,
    resolved     BOOLEAN NOT NULL DEFAULT 0,
    author_id    TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (document_id) REFERENCES project_documents(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES project_document_comments(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_project_document_comments_document ON project_document_comments(document_id);
CREATE INDEX idx_project_document_comments_parent ON project_document_comments(parent_id) WHERE parent_id IS NOT NULL;

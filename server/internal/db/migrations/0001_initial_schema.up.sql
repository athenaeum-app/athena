-- 0001_initial_schema.up.sql
-- Initial schema for athenaeum v2.

-- Identity
CREATE TABLE users (
    id           TEXT PRIMARY KEY,
    username     TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email        TEXT,
    is_owner     BOOLEAN NOT NULL DEFAULT 0,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE roles (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    color        TEXT NOT NULL DEFAULT '#999999',
    position     INTEGER NOT NULL DEFAULT 0,
    is_preset    BOOLEAN NOT NULL DEFAULT 0,
    is_default   BOOLEAN NOT NULL DEFAULT 0,
    permissions  INTEGER NOT NULL DEFAULT 0,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_roles (
    user_id      TEXT NOT NULL,
    role_id      TEXT NOT NULL,
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE invites (
    id              TEXT PRIMARY KEY,
    created_by      TEXT NOT NULL,
    uses_remaining  INTEGER NOT NULL DEFAULT 1,
    expires_at      DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    expires_at   DATETIME,
    ip           TEXT,
    user_agent   TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Content
CREATE TABLE archives (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE moments (
    id           TEXT PRIMARY KEY,
    archive_id   TEXT NOT NULL,
    author_id    TEXT,
    title        TEXT NOT NULL DEFAULT '',
    content      TEXT NOT NULL DEFAULT '',
    timestamp    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_legacy    BOOLEAN NOT NULL DEFAULT 0,
    deleted_at   DATETIME,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (archive_id) REFERENCES archives(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE tags (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    color        TEXT NOT NULL DEFAULT '#cccccc',
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE moment_tags (
    moment_id    TEXT NOT NULL,
    tag_id       TEXT NOT NULL,
    PRIMARY KEY (moment_id, tag_id),
    FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE chat_messages (
    id            TEXT PRIMARY KEY,
    author_id     TEXT,
    display_name  TEXT,
    content       TEXT NOT NULL,
    is_legacy     BOOLEAN NOT NULL DEFAULT 0,
    deleted_at    DATETIME,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Assets
CREATE TABLE assets (
    id            TEXT PRIMARY KEY,
    uploader_id   TEXT NOT NULL,
    file_name     TEXT NOT NULL,
    mime_type     TEXT NOT NULL DEFAULT '',
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    storage_path  TEXT NOT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE link_previews (
    url           TEXT PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    image_url     TEXT NOT NULL DEFAULT '',
    scraped_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Sync & audit
CREATE TABLE events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    library_version  INTEGER NOT NULL,
    type             TEXT NOT NULL,
    target_type      TEXT NOT NULL,
    target_id        TEXT NOT NULL,
    author_id        TEXT,
    payload          TEXT,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id     TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_type  TEXT,
    target_id    TEXT,
    details      TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Settings (key-value, server-managed)
CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

-- Full-text search for moments
CREATE VIRTUAL TABLE moments_fts USING fts5(
    title,
    content,
    content='moments',
    content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER moments_fts_insert AFTER INSERT ON moments BEGIN
    INSERT INTO moments_fts(rowid, title, content)
    VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER moments_fts_update AFTER UPDATE ON moments BEGIN
    INSERT INTO moments_fts(moments_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.title, old.content);
    INSERT INTO moments_fts(rowid, title, content)
    VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER moments_fts_delete AFTER DELETE ON moments BEGIN
    INSERT INTO moments_fts(moments_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.title, old.content);
END;

-- Indexes
CREATE INDEX idx_moments_archive_timestamp ON moments(archive_id, timestamp DESC);
CREATE INDEX idx_moments_deleted_at ON moments(deleted_at);
CREATE INDEX idx_moments_author ON moments(author_id);
CREATE INDEX idx_chat_messages_created ON chat_messages(created_at DESC);
CREATE INDEX idx_chat_messages_deleted ON chat_messages(deleted_at);
CREATE INDEX idx_events_version ON events(library_version);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_user_roles_user ON user_roles(user_id);
CREATE INDEX idx_user_roles_role ON user_roles(role_id);
CREATE INDEX idx_moment_tags_tag ON moment_tags(tag_id);
CREATE INDEX idx_assets_uploader ON assets(uploader_id);

-- Library version counter (singleton row)
CREATE TABLE library_meta (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    library_version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO library_meta (id, library_version) VALUES (1, 0);

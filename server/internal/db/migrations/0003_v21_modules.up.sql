-- 0003_v21_modules.up.sql
-- v2.1 additions: moment pins, todo module, canvas module (ADR-0013).

-- Moment pins (library-shared, 4.7). Pinned moments surface at the top of
-- the feed for everyone.
ALTER TABLE moments ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT 0;
CREATE INDEX idx_moments_pinned ON moments(pinned) WHERE pinned = 1;

-- Todo module (4.9): server-synced, library-shared, last-write-wins.
CREATE TABLE todo_lists (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL DEFAULT 'general', -- 'daily' | 'general'
    title          TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT '',
    author_id      TEXT,
    position       INTEGER NOT NULL DEFAULT 0,
    last_reset_at  DATETIME,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE todo_items (
    id             TEXT PRIMARY KEY,
    list_id        TEXT NOT NULL,
    text           TEXT NOT NULL DEFAULT '',
    done           BOOLEAN NOT NULL DEFAULT 0,
    position       INTEGER NOT NULL DEFAULT 0,
    rolled_over    BOOLEAN NOT NULL DEFAULT 0,
    completed_at   DATETIME,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (list_id) REFERENCES todo_lists(id) ON DELETE CASCADE
);
CREATE INDEX idx_todo_items_list ON todo_items(list_id);

-- Canvas module (4.10): server-synced, library-shared, last-write-wins.
-- Hard delete + audit (ADR-0010): canvases cascade-delete their nodes.
CREATE TABLE canvases (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    author_id    TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE canvas_nodes (
    id           TEXT PRIMARY KEY,
    canvas_id    TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'text', -- 'moment-ref' | 'text' | 'image'
    x            REAL NOT NULL DEFAULT 0,
    y            REAL NOT NULL DEFAULT 0,
    w            REAL NOT NULL DEFAULT 200,
    h            REAL NOT NULL DEFAULT 120,
    z_order      INTEGER NOT NULL DEFAULT 0,
    content      TEXT NOT NULL DEFAULT '',
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE
);
CREATE INDEX idx_canvas_nodes_canvas ON canvas_nodes(canvas_id);

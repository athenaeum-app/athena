-- 0013_projects.up.sql
-- Projects module: a portfolio of long-horizon efforts, each a tabbed hub
-- (overview document, milestone board, graveyard). Milestones are board
-- columns; milestones sharing a track stack vertically and split the column.
-- Cards are dismissed (reversible, the graveyard) rather than deleted in the
-- normal flow; hard delete exists for emptying the graveyard.
--
-- Positions are REAL so a drop between two rows is one write (the midpoint),
-- never a renumber. completed_at is stamped when a card is ticked done, which
-- is what the momentum chart (work per day) reads.

CREATE TABLE projects (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    -- Markdown, rendered with the moment pipeline: ::todo:id:: embeds a live
    -- task list, ::canvas:id:: a board, [[id]] references a moment. This is
    -- how a project attaches its knowledge and its task lists.
    overview     TEXT NOT NULL DEFAULT '',
    -- Per-project identity color (hex) and material symbol, chosen by the user.
    accent       TEXT NOT NULL DEFAULT '#67b8c7',
    icon         TEXT NOT NULL DEFAULT 'space_dashboard',
    author_id    TEXT,
    position     INTEGER NOT NULL DEFAULT 0,
    archived     BOOLEAN NOT NULL DEFAULT 0,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE project_milestones (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    due_at       DATETIME,
    -- Board slot: milestones with equal track stack vertically in one column.
    -- position orders the roadmap globally (and rows within a track).
    track        INTEGER NOT NULL DEFAULT 0,
    position     REAL NOT NULL DEFAULT 0,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_project_milestones_project ON project_milestones(project_id);

CREATE TABLE project_cards (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    milestone_id  TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    -- Markdown document with embeds, same pipeline as the project overview.
    body          TEXT NOT NULL DEFAULT '',
    -- Comma-joined label names; free-form, colored client-side.
    labels        TEXT NOT NULL DEFAULT '',
    -- 0 none · 1 low · 2 med · 3 high, the Tasks module's vocabulary.
    priority      INTEGER NOT NULL DEFAULT 0,
    due_at        DATETIME,
    assignee_id   TEXT,
    done          BOOLEAN NOT NULL DEFAULT 0,
    completed_at  DATETIME,
    dismissed     BOOLEAN NOT NULL DEFAULT 0,
    position      REAL NOT NULL DEFAULT 0,
    author_id     TEXT,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (milestone_id) REFERENCES project_milestones(id) ON DELETE CASCADE,
    FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_project_cards_project ON project_cards(project_id);
CREATE INDEX idx_project_cards_milestone ON project_cards(milestone_id);

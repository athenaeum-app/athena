// API client for the Athena server. All requests use same-origin
// session cookies, no token management needed.

// Capitalize the first character of a message. Server error strings follow the
// Go convention of lowercase, unpunctuated prose (e.g. "insufficient
// permissions"); these surface directly to users via toasts/inline errors, so
// we sentence-case them at the single choke point where every server message is
// constructed. Idempotent for already-capitalized client fallback literals.
function sentenceCase(s: string): string {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

export class APIError extends Error {
    constructor(public status: number, message: string) {
        super(sentenceCase(message))
        this.name = 'APIError'
    }
}

async function request<T>(
    path: string,
    options: RequestInit = {},
): Promise<T> {
    const res = await fetch(path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    })

    if (!res.ok) {
        let msg = 'Request failed'
        try {
            const body = await res.json()
            msg = body.error || msg
        } catch {}
        throw new APIError(res.status, msg)
    }

    if (res.status === 204) {
        return undefined as T
    }

    return res.json()
}

export const api = {
    // Setup status (public)
    getSetup: () =>
        request<{ needs_setup: boolean; user_count: number }>('/api/v1/setup'),

    // Liveness (public). The one endpoint safe to poll from the unreachable
    // screen: no session in the mix, and the service worker denylists /api/ so
    // the answer always comes from the real network, never a stale cache.
    getHealth: () => request<{ status: string; library_version: number }>('/api/v1/health'),

    // Auth
    register: (username: string, password: string, invite_id?: string, stay_logged_in = true) =>
        request<{ id: string; username: string; is_owner: boolean }>('/api/v1/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, password, invite_id, stay_logged_in }),
        }),

    login: (username: string, password: string, stay_logged_in = true) =>
        request<{ id: string; username: string; is_owner: boolean }>('/api/v1/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password, stay_logged_in }),
        }),

    logout: () => request('/api/v1/auth/logout', { method: 'POST' }),

    getMe: () =>
        request<{ id: string; username: string; is_owner: boolean; roles: string[]; permissions: number }>(
            '/api/v1/users/me',
        ),

    // Self-service account changes. Both fields are optional (send only what
    // is changing) but the current password is always required. The server
    // re-checks it rather than trusting the session cookie.
    updateMe: (changes: { username?: string; new_password?: string; current_password: string }) =>
        request<{ id: string; username: string; is_owner: boolean }>('/api/v1/users/me', {
            method: 'PATCH',
            body: JSON.stringify(changes),
        }),

    // Which build of the server is running (Settings → About).
    getServerVersion: () =>
        request<{ version: string; go_version: string; os: string; arch: string; started_at: string }>(
            '/api/v1/version',
        ),

    // Archives
    listArchives: () => request<Archive[]>('/api/v1/archives'),
    createArchive: (name: string) =>
        request<Archive>('/api/v1/archives', { method: 'POST', body: JSON.stringify({ name }) }),
    updateArchive: (id: string, name: string) =>
        request<Archive>(`/api/v1/archives/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    deleteArchive: (id: string) => request(`/api/v1/archives/${id}`, { method: 'DELETE' }),

    // Moments
    listMoments: (
        params: {
            archive?: string
            limit?: number
            cursor_ts?: string
            cursor_id?: string
            q?: string
            // v2.2 feed filters (date range + media/source). `from`/`to` are
            // RFC3339; `media`/`link` are content heuristics (server-side).
            from?: string
            to?: string
            media?: boolean
            link?: boolean
        } = {},
    ) => {
        const searchParams = new URLSearchParams()
        if (params.archive) searchParams.set('archive', params.archive)
        if (params.limit) searchParams.set('limit', String(params.limit))
        if (params.cursor_ts) searchParams.set('cursor_ts', params.cursor_ts)
        if (params.cursor_id) searchParams.set('cursor_id', params.cursor_id)
        if (params.q) searchParams.set('q', params.q)
        if (params.from) searchParams.set('from', params.from)
        if (params.to) searchParams.set('to', params.to)
        if (params.media) searchParams.set('media', '1')
        if (params.link) searchParams.set('link', '1')
        const queryString = searchParams.toString()
        return request<Moment[]>(`/api/v1/moments${queryString ? '?' + queryString : ''}`)
    },

    createMoment: (archive_id: string, title: string, content: string, tag_ids: string[] = []) =>
        request<Moment>('/api/v1/moments', {
            method: 'POST',
            body: JSON.stringify({ archive_id, title, content, tag_ids }),
        }),

    getMoment: (id: string) => request<Moment>(`/api/v1/moments/${id}`),

    updateMoment: (id: string, title: string, content: string, tag_ids: string[], ifMatch?: string) =>
        request<Moment>(`/api/v1/moments/${id}`, {
            method: 'PATCH',
            headers: ifMatch ? { 'If-Match': ifMatch } : {},
            body: JSON.stringify({ title, content, tag_ids }),
        }),

    deleteMoment: (id: string) => request(`/api/v1/moments/${id}`, { method: 'DELETE' }),

    // Moment pins, library-shared
    listPinnedMoments: () => request<Moment[]>('/api/v1/moments/pinned'),
    pinMoment: (id: string, pinned: boolean) =>
        request<Moment>(`/api/v1/moments/${id}/pin`, { method: 'PATCH', body: JSON.stringify({ pinned }) }),

    // Tags
    listTags: () => request<Tag[]>('/api/v1/tags'),

    // Which tags still lead somewhere under the current filter. Tag filtering
    // is AND, so a tag absent from this map would empty the feed if selected;
    // the filter surfaces hide those rather than offer a dead end. Takes the
    // same parameters as listMoments, plus the tags already selected.
    getTagFacets: (
        params: { archive?: string; q?: string; tags?: string[]; from?: string; to?: string; media?: boolean; link?: boolean } = {},
    ) => {
        const searchParams = new URLSearchParams()
        if (params.archive) searchParams.set('archive', params.archive)
        if (params.q) searchParams.set('q', params.q)
        if (params.tags?.length) searchParams.set('tags', params.tags.join(','))
        if (params.from) searchParams.set('from', params.from)
        if (params.to) searchParams.set('to', params.to)
        if (params.media) searchParams.set('media', '1')
        if (params.link) searchParams.set('link', '1')
        const queryString = searchParams.toString()
        return request<{ counts: Record<string, number> }>(`/api/v1/tags/facets${queryString ? '?' + queryString : ''}`)
    },
    // How often each tag is used and how often each pair shares a moment,
    // across the whole library. Deliberately unfiltered: the composer ranks
    // its suggestions from this, and that order must not move with whatever
    // archive or search the reader had open when they started writing.
    getTagGraph: () => request<TagGraph>('/api/v1/tags/graph'),

    createTag: (name: string, color: string) =>
        request<Tag>('/api/v1/tags', { method: 'POST', body: JSON.stringify({ name, color }) }),
    updateTag: (id: string, name?: string, color?: string) =>
        request<Tag>(`/api/v1/tags/${id}`, { method: 'PATCH', body: JSON.stringify({ name, color }) }),
    deleteTag: (id: string) => request(`/api/v1/tags/${id}`, { method: 'DELETE' }),
    // Bulk re-colour every tag from a client-computed map. Library-shared.
    recolorTags: (colors: Record<string, string>) =>
        request<Tag[]>('/api/v1/tags/recolor', { method: 'POST', body: JSON.stringify({ colors }) }),

    // Todos, server-synced and library-shared
    listTodos: () => request<TodoList[]>('/api/v1/todos'),
    // Resolve a single list by id (for live embeds); the server has no
    // per-list GET, so filter the full list client-side.
    getTodoList: async (id: string): Promise<TodoList | undefined> =>
        ((await request<TodoList[]>('/api/v1/todos')) ?? []).find((l) => l.id === id),
    createTodoList: (kind: 'daily' | 'general', title: string) =>
        request<TodoList>('/api/v1/todos', { method: 'POST', body: JSON.stringify({ kind, title }) }),
    updateTodoList: (id: string, body: { title?: string; notes?: string; position?: number; reset_mode?: TodoResetMode }) =>
        request<TodoList>(`/api/v1/todos/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteTodoList: (id: string) => request(`/api/v1/todos/${id}`, { method: 'DELETE' }),
    // Unchecks every ticked item; deletes nothing.
    resetTodoList: (id: string) => request<TodoList>(`/api/v1/todos/${id}/reset`, { method: 'POST' }),
    // Deletes every ticked item, bar a ticked parent that still has open
    // subtasks. Destructive, so callers confirm first.
    cleanupTodoList: (id: string) => request<TodoList>(`/api/v1/todos/${id}/cleanup`, { method: 'POST' }),
    createTodoItem: (listId: string, text: string, parentId?: string) =>
        request<TodoItem>(`/api/v1/todos/${listId}/items`, {
            method: 'POST',
            body: JSON.stringify(parentId ? { text, parent_id: parentId } : { text }),
        }),
    updateTodoItem: (
        id: string,
        body: {
            text?: string
            done?: boolean
            position?: number
            rolled_over?: boolean
            priority?: number
            recurrence?: string
            reset_mode?: TodoResetMode
            // RFC3339 to set, '' to clear, omit to leave unchanged.
            due_at?: string
            // id to link, '' to unlink, omit to leave unchanged.
            moment_id?: string
        },
    ) => request<TodoItem>(`/api/v1/todo-items/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteTodoItem: (id: string) => request(`/api/v1/todo-items/${id}`, { method: 'DELETE' }),

    // Projects, server-synced and library-shared
    listProjects: () => request<Project[]>('/api/v1/projects'),
    getProject: (id: string) => request<Project>(`/api/v1/projects/${id}`),
    createProject: (title: string) => request<Project>('/api/v1/projects', { method: 'POST', body: JSON.stringify({ title }) }),
    updateProject: (id: string, body: { title?: string; overview?: string; accent?: string; icon?: string; position?: number; archived?: boolean }) =>
        request<Project>(`/api/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteProject: (id: string) => request(`/api/v1/projects/${id}`, { method: 'DELETE' }),
    createProjectMilestone: (projectId: string, title: string, dueAt?: string) =>
        request<ProjectMilestone>(`/api/v1/projects/${projectId}/milestones`, {
            method: 'POST',
            body: JSON.stringify(dueAt ? { title, due_at: dueAt } : { title }),
        }),
    updateProjectMilestone: (id: string, body: { title?: string; track?: number; position?: number; due_at?: string }) =>
        request<ProjectMilestone>(`/api/v1/project-milestones/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    // Its cards move to the nearest surviving milestone; deleting structure
    // keeps the work (the last milestone takes its cards with it).
    deleteProjectMilestone: (id: string) => request(`/api/v1/project-milestones/${id}`, { method: 'DELETE' }),
    // One card per title, so a pasted list is one request.
    createProjectCards: (projectId: string, milestoneId: string, titles: string[]) =>
        request<ProjectCard[]>(`/api/v1/projects/${projectId}/cards`, {
            method: 'POST',
            body: JSON.stringify({ milestone_id: milestoneId, titles }),
        }),
    updateProjectCard: (
        id: string,
        body: {
            title?: string
            body?: string
            labels?: string
            priority?: number
            milestone_id?: string
            position?: number
            done?: boolean
            dismissed?: boolean
            // RFC3339 to set, '' to clear, omit to leave unchanged.
            due_at?: string
            // id to assign, '' to unassign, omit to leave unchanged.
            assignee_id?: string
        },
    ) => request<ProjectCard>(`/api/v1/project-cards/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteProjectCard: (id: string) => request(`/api/v1/project-cards/${id}`, { method: 'DELETE' }),

    // Canvas, server-synced and library-shared
    listCanvases: () => request<Canvas[]>('/api/v1/canvases'),
    getCanvas: (id: string) => request<Canvas>(`/api/v1/canvases/${id}`),
    createCanvas: (title: string) =>
        request<Canvas>('/api/v1/canvases', { method: 'POST', body: JSON.stringify({ title }) }),
    updateCanvas: (id: string, title: string) =>
        request<Canvas>(`/api/v1/canvases/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
    deleteCanvas: (id: string) => request(`/api/v1/canvases/${id}`, { method: 'DELETE' }),
    createCanvasNode: (canvasId: string, body: Partial<CanvasNode> & { kind: string }) =>
        request<CanvasNode>(`/api/v1/canvases/${canvasId}/nodes`, { method: 'POST', body: JSON.stringify(body) }),
    updateCanvasNode: (
        id: string,
        body: Partial<Pick<CanvasNode, 'x' | 'y' | 'w' | 'h' | 'z_order' | 'content' | 'style'>>,
    ) => request<CanvasNode>(`/api/v1/canvas-nodes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteCanvasNode: (id: string) => request(`/api/v1/canvas-nodes/${id}`, { method: 'DELETE' }),
    createCanvasEdge: (canvasId: string, fromNode: string, toNode: string) =>
        request<CanvasEdge>(`/api/v1/canvases/${canvasId}/edges`, {
            method: 'POST',
            body: JSON.stringify({ from_node: fromNode, to_node: toNode }),
        }),
    deleteCanvasEdge: (id: string) => request(`/api/v1/canvas-edges/${id}`, { method: 'DELETE' }),

    // Server stats
    getStats: () => request<ServerStats>('/api/v1/stats'),

    // Backups
    listBackups: () => request<Backup[]>('/api/v1/backups'),
    createBackup: () => request<Backup>('/api/v1/backups', { method: 'POST' }),
    restoreBackup: (name: string) =>
        request<{ status: string }>(`/api/v1/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' }),
    backupDownloadUrl: (name: string) => `/api/v1/backups/${encodeURIComponent(name)}/download`,
    getBackupSettings: () => request<BackupSettings>('/api/v1/backups/settings'),
    updateBackupSettings: (settings: BackupSettings) =>
        request<BackupSettings>('/api/v1/backups/settings', { method: 'PUT', body: JSON.stringify(settings) }),

    // Chat
    listChat: (params: { limit?: number; cursor_ts?: string; cursor_id?: string } = {}) => {
        const searchParams = new URLSearchParams()
        if (params.limit) searchParams.set('limit', String(params.limit))
        if (params.cursor_ts) searchParams.set('cursor_ts', params.cursor_ts)
        if (params.cursor_id) searchParams.set('cursor_id', params.cursor_id)
        const queryString = searchParams.toString()
        return request<ChatMessage[]>(`/api/v1/chat${queryString ? '?' + queryString : ''}`)
    },

    sendChat: (content: string) =>
        request<ChatMessage>('/api/v1/chat', { method: 'POST', body: JSON.stringify({ content }) }),
    updateChat: (id: string, content: string) =>
        request<ChatMessage>(`/api/v1/chat/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) }),
    deleteChat: (id: string) => request(`/api/v1/chat/${id}`, { method: 'DELETE' }),

    // Events (delta sync)
    getEvents: (since: number, limit = 100) =>
        request<{ events: Event[]; current_version: number }>(`/api/v1/events?since=${since}&limit=${limit}`),

    // Settings
    getSettings: () => request<Record<string, string>>('/api/v1/settings'),
    updateSettings: (settings: Record<string, string>) =>
        request('/api/v1/settings', { method: 'PATCH', body: JSON.stringify({ settings }) }),

    // Assets
    uploadAsset: async (file: File) => {
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch('/api/v1/assets', { method: 'POST', body: formData })
        if (!res.ok) throw new APIError(res.status, 'Upload failed')
        return res.json()
    },
    getAssetMeta: (id: string) => request<AssetMeta>(`/api/v1/assets/${id}/meta`),

    // Link previews
    getPreview: (url: string) =>
        request<{ url: string; title: string; description: string; image_url: string; scraped_at: string }>(`/api/v1/previews?url=${encodeURIComponent(url)}`),

    // Member-visible user directory (id + username only), for resolving
    // author/actor IDs to names in chat, the audit log, and canvas.
    listUsers: () => request<PublicUser[]>('/api/v1/users'),

    // Users (admin), full records, gated by ManageUsers.
    listAllUsers: () => request<User[]>('/api/v1/users/all'),
    assignUserRoles: (userId: string, roleIds: string[]) =>
        request(`/api/v1/users/${userId}/roles`, { method: 'PATCH', body: JSON.stringify({ role_ids: roleIds }) }),

    // Roles (admin)
    listRoles: () => request<Role[]>('/api/v1/roles'),
    createRole: (name: string, color: string, position: number, permissions: number) =>
        request<Role>('/api/v1/roles', { method: 'POST', body: JSON.stringify({ name, color, position, permissions }) }),
    updateRole: (id: string, body: { name?: string; color?: string; position?: number; permissions?: number }) =>
        request(`/api/v1/roles/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteRole: (id: string) => request(`/api/v1/roles/${id}`, { method: 'DELETE' }),

    // Invites (admin)
    listInvites: () => request<Invite[]>('/api/v1/invites'),
    createInvite: (uses: number, expiresAt?: string) =>
        request<Invite>('/api/v1/invites', { method: 'POST', body: JSON.stringify({ uses, expires_at: expiresAt }) }),
    revokeInvite: (id: string) => request(`/api/v1/invites/${id}`, { method: 'DELETE' }),

    // Audit log (admin)
    getAuditLog: (params: { cursor_id?: number; limit?: number } = {}) => {
        const searchParams = new URLSearchParams()
        if (params.cursor_id) searchParams.set('cursor_id', String(params.cursor_id))
        if (params.limit) searchParams.set('limit', String(params.limit))
        const queryString = searchParams.toString()
        return request<AuditEntry[]>(`/api/v1/audit-log${queryString ? '?' + queryString : ''}`)
    },
}

// Types: these should eventually be generated from the OpenAPI spec
export interface Archive {
    id: string
    name: string
    created_at: string
    updated_at: string
}

export interface Moment {
    id: string
    archive_id: string
    author_id?: string
    title: string
    content: string
    timestamp: string
    is_legacy: boolean
    pinned?: boolean
    deleted_at?: string
    created_at: string
    updated_at: string
    tag_ids?: string[]
}

// --- v2.1 modules (ADR-0013) ---

export interface AssetMeta {
    id: string
    uploader_id: string
    file_name: string
    mime_type: string
    size_bytes: number
    created_at: string
}

export interface TodoItem {
    id: string
    list_id: string
    text: string
    done: boolean
    position: number
    rolled_over: boolean
    completed_at?: string
    // Task fields.
    due_at?: string // RFC3339
    priority: number // 0 none, 1 low, 2 med, 3 high
    moment_id?: string
    recurrence: string // '' | daily | weekly | monthly
    reset_mode: TodoResetMode
    parent_id?: string // subtask parent
    created_at: string
    updated_at: string
}

// When a repeating item, or a daily list, comes back: at the start of the next
// period, or a whole period after it was completed. Mirrors domain.ResetMode*
// on the server.
export type TodoResetMode = 'calendar' | 'interval'

export interface TodoList {
    id: string
    kind: 'daily' | 'general'
    title: string
    notes: string
    author_id?: string
    position: number
    last_reset_at?: string
    // Daily lists only: 'calendar' clears every item at midnight, 'interval'
    // clears each item 24 hours after it was ticked.
    reset_mode: TodoResetMode
    created_at: string
    updated_at: string
    items: TodoItem[]
}

export interface Project {
    id: string
    title: string
    // Markdown rendered with the moment pipeline, so it can embed todo lists,
    // canvases and moment references.
    overview: string
    // Per-project identity: a hex color and a material symbol name.
    accent: string
    icon: string
    author_id?: string
    position: number
    archived: boolean
    created_at: string
    updated_at: string
    milestones: ProjectMilestone[]
    cards: ProjectCard[]
}

// One board column and one roadmap node. Milestones sharing a track stack
// vertically and split that column; position orders the roadmap globally.
export interface ProjectMilestone {
    id: string
    project_id: string
    title: string
    due_at?: string
    track: number
    position: number
    created_at: string
    updated_at: string
}

export interface ProjectCard {
    id: string
    project_id: string
    milestone_id: string
    title: string
    // Markdown document with embeds, same pipeline as the project overview.
    body: string
    // Comma-joined free-form label names, colored client-side.
    labels: string
    // 0 none · 1 low · 2 med · 3 high, the Tasks module's vocabulary.
    priority: number
    due_at?: string
    assignee_id?: string
    done: boolean
    completed_at?: string
    dismissed: boolean
    position: number
    author_id?: string
    created_at: string
    updated_at: string
}

export type CanvasNodeKind = 'moment-ref' | 'text' | 'image' | 'sticky' | 'shape' | 'link' | 'todo-ref'

export interface CanvasNode {
    id: string
    canvas_id: string
    kind: CanvasNodeKind
    x: number
    y: number
    w: number
    h: number
    z_order: number
    content: string
    // Optional JSON blob for presentation only, e.g. {"color":"#..","fontSize":14}.
    style?: string
    created_at: string
    updated_at: string
}

export interface CanvasEdge {
    id: string
    canvas_id: string
    from_node: string
    to_node: string
    created_at: string
}

export interface Canvas {
    id: string
    title: string
    author_id?: string
    created_at: string
    updated_at: string
    nodes: CanvasNode[]
    edges: CanvasEdge[]
}

export interface ServerStats {
    stats: {
        moments_count: number
        tags_count: number
        archives_count: number
        users_count: number
        chat_count: number
        todo_lists_count: number
        canvases_count: number
        assets_count: number
        db_size_bytes: number
        uploads_size_bytes: number
    }
    library_version: number
    uptime_seconds: number
    backup_count: number
    last_backup: Backup | null
    max_upload_mb: number
}

export interface Backup {
    name: string
    size_bytes: number
    created_at: string
}

export interface Tag {
    id: string
    name: string
    color: string
    created_at: string
    updated_at: string
}

// Whole-library tag usage. `pairs` is symmetric: pairs[a][b] and pairs[b][a]
// both hold the number of moments carrying both tags, so a lookup by either
// half works. A pair that never occurs is absent, not zero.
// `archive_totals` is the same usage count sliced by archive, so the composer
// can rank for the archive it is filing into. An archive with no tagged
// moments is absent rather than an empty map.
export interface TagGraph {
    totals: Record<string, number>
    pairs: Record<string, Record<string, number>>
    archive_totals: Record<string, Record<string, number>>
}

export interface ChatMessage {
    id: string
    author_id?: string
    display_name?: string
    content: string
    is_legacy: boolean
    deleted_at?: string
    created_at: string
    updated_at: string
}

export interface Event {
    id: number
    library_version: number
    type: string
    target_type: string
    target_id: string
    author_id?: string
    payload?: string
    created_at: string
}

export interface User {
    id: string
    username: string
    is_owner: boolean
    created_at: string
}

// Minimal, member-visible directory record (GET /api/v1/users). Used to
// resolve author/actor IDs to usernames without exposing admin-only fields.
export interface PublicUser {
    id: string
    username: string
    online: boolean
}

export interface BackupSettings {
    enabled: boolean
    interval_hours: number
    retention: number
}

export interface Role {
    id: string
    name: string
    color: string
    position: number
    is_preset: boolean
    is_default: boolean
    permissions: number
    created_at: string
    updated_at: string
}

export interface Invite {
    id: string
    created_by: string
    uses_remaining: number
    expires_at?: string
    created_at: string
}

export interface AuditEntry {
    id: number
    actor_id: string
    action: string
    target_type?: string
    target_id?: string
    details?: string
    created_at: string
}

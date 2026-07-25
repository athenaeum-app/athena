// Permission flag definitions for the role editor UI. These mirror the
// flags in server/internal/permissions/permissions.go. The Administrator
// flag is a wildcard that grants every other flag.
export interface PermissionDef {
    bit: number
    name: string
    label: string
    group: string
}

export const PERMISSIONS: PermissionDef[] = [
    // Content: Moments
    { bit: 0, name: 'VIEW_MOMENTS', label: 'View Moments', group: 'Moments' },
    { bit: 1, name: 'CREATE_MOMENT', label: 'Create Moment', group: 'Moments' },
    { bit: 2, name: 'EDIT_OWN_MOMENT', label: 'Edit Own Moment', group: 'Moments' },
    { bit: 3, name: 'EDIT_ANY_MOMENT', label: 'Edit Any Moment', group: 'Moments' },
    { bit: 4, name: 'DELETE_OWN_MOMENT', label: 'Delete Own Moment', group: 'Moments' },
    { bit: 5, name: 'DELETE_ANY_MOMENT', label: 'Delete Any Moment', group: 'Moments' },

    // Content: Archives & Tags
    { bit: 6, name: 'MANAGE_ARCHIVES', label: 'Manage Archives', group: 'Archives & Tags' },
    { bit: 7, name: 'MANAGE_TAGS', label: 'Manage Tags', group: 'Archives & Tags' },

    // Chat
    { bit: 8, name: 'VIEW_CHAT', label: 'View Chat', group: 'Chat' },
    { bit: 9, name: 'SEND_CHAT_MESSAGE', label: 'Send Chat Message', group: 'Chat' },
    { bit: 10, name: 'EDIT_OWN_CHAT_MESSAGE', label: 'Edit Own Chat Message', group: 'Chat' },
    { bit: 11, name: 'DELETE_OWN_CHAT_MESSAGE', label: 'Delete Own Chat Message', group: 'Chat' },
    { bit: 12, name: 'DELETE_ANY_CHAT_MESSAGE', label: 'Delete Any Chat Message', group: 'Chat' },

    // Assets
    { bit: 13, name: 'UPLOAD_ASSET', label: 'Upload Asset', group: 'Assets' },
    { bit: 14, name: 'DELETE_ASSET', label: 'Delete Asset', group: 'Assets' },

    // Administration
    { bit: 15, name: 'MANAGE_USERS', label: 'Manage Users', group: 'Administration' },
    { bit: 16, name: 'MANAGE_ROLES', label: 'Manage Roles', group: 'Administration' },
    { bit: 17, name: 'MANAGE_SERVER', label: 'Manage Server', group: 'Administration' },
    { bit: 18, name: 'VIEW_AUDIT_LOG', label: 'View Audit Log', group: 'Administration' },
    { bit: 19, name: 'ADMINISTRATOR', label: 'Administrator (wildcard)', group: 'Administration' },

    // v2.1 additions (ADR-0013)
    { bit: 20, name: 'PIN_MOMENT', label: 'Pin Moments', group: 'Moments' },
    { bit: 21, name: 'MANAGE_TODOS', label: 'Manage Todos', group: 'Modules' },
    { bit: 22, name: 'MANAGE_CANVAS', label: 'Manage Canvases', group: 'Modules' },
    { bit: 23, name: 'MANAGE_BACKUPS', label: 'Manage Backups', group: 'Administration' },
]

// Named bit constants for gating UI (mirror the server flags).
export const PERM = {
    PIN_MOMENT: 20,
    MANAGE_TODOS: 21,
    MANAGE_CANVAS: 22,
    MANAGE_BACKUPS: 23,
    MANAGE_SERVER: 17,
    MANAGE_TAGS: 7,
} as const

export const PERMISSION_GROUPS = [...new Set(PERMISSIONS.map((p) => p.group))]

export function hasPermission(perms: number, bit: number): boolean {
    // Administrator wildcard (bit 19) grants everything.
    if (perms & (1 << 19)) return true
    return (perms & (1 << bit)) !== 0
}

export function togglePermission(perms: number, bit: number): number {
    return perms ^ (1 << bit)
}

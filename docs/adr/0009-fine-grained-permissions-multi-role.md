# Fine-grained permission flags with multi-role union

Permissions are 19 individual boolean flags (e.g., `CREATE_MOMENT`, `EDIT_OWN_MOMENT`, `DELETE_ANY_MOMENT`, `MANAGE_USERS`). Roles bundle flags as a bitmask. Users hold zero or more roles; their effective permissions are the bitwise OR of all their roles' flags. A `Member` default role is automatically held by every user and is owner-editable to control the baseline capabilities of new users.

This was chosen over fixed binary roles (admin/viewer, as in v1) because the operator requested Discord-style fine-grained permissions. The own/any split on moments and chat (e.g., `EDIT_OWN_MOMENT` vs `EDIT_ANY_MOMENT`) is meaningful because moments and chat now have `author_id` (ADR-0005 introduced accounts), so "own" is well-defined.

Permissions are stored as a bitmask integer per role rather than a role-permission join table because 19 flags fit in a 32-bit int and the only query needed is "does this user's union of roles grant this flag?" That's a bitwise OR, no join. The cost is losing "which roles grant flag X" queries, which are never needed.

Preset roles (Owner, Admin, Editor, Viewer) ship with every server and are editable except Owner, which is always `ADMINISTRATOR` and always held by exactly one user. Custom roles can be created by users with `MANAGE_ROLES`.

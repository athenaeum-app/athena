import { createSignal, For, Show, createResource, onMount, type Component } from 'solid-js'
import { Modal } from './Modal'
import { api, type User, type Role, type Invite, type AuditEntry } from '../api'
import { PERMISSIONS, PERMISSION_GROUPS, hasPermission, togglePermission } from '../permissions'
import { useUI } from '../ui'
import { useAuth } from '../auth'
import { loadUsers, userName } from '../users'
import { formatDateTime } from '../format'

interface AdminModalProps {
    onClose: () => void
    // The current user's permissions bitmask, used to gate which tabs are
    // visible. Tabs requiring permissions the user lacks are hidden.
    myPermissions: number
}

type Tab = 'audit' | 'users' | 'roles'

const MANAGE_USERS = 1 << 15
const MANAGE_ROLES = 1 << 16
const VIEW_AUDIT_LOG = 1 << 18
const ADMINISTRATOR = 1 << 19

function can(perms: number, bit: number): boolean {
    if (perms & ADMINISTRATOR) return true
    return (perms & bit) !== 0
}

export const AdminModal: Component<AdminModalProps> = (props) => {
    const [tab, setTab] = createSignal<Tab>('audit')

    onMount(() => {
        // Pick the first tab the user is allowed to see.
        if (can(props.myPermissions, VIEW_AUDIT_LOG)) setTab('audit')
        else if (can(props.myPermissions, MANAGE_USERS)) setTab('users')
        else if (can(props.myPermissions, MANAGE_ROLES)) setTab('roles')
    })

    return (
        <Modal onClose={props.onClose} class="animate-fade-in">
            <div class="bg-element-matte border-element-accent flex h-[85vh] w-full max-w-5xl flex-col rounded-2xl border-4 shadow-2xl overflow-hidden">
                {/* Header */}
                <div class="bg-element border-element-accent flex items-center justify-between rounded-t-2xl border-b p-4">
                    <div class="flex items-center gap-2">
                        <span class="material-symbols-outlined text-highlight text-xl">admin_panel_settings</span>
                        <h2 class="text-main text-lg font-bold tracking-widest">ADMIN</h2>
                    </div>
                    <button
                        onClick={props.onClose}
                        class="text-sub hover:text-plain transition-colors"
                    >
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>

                {/* Tabs */}
                <div class="bg-element border-element-accent flex gap-1 border-b p-2">
                    <Show when={can(props.myPermissions, VIEW_AUDIT_LOG)}>
                        <TabButton active={tab() === 'audit'} onClick={() => setTab('audit')}>
                            Audit Log
                        </TabButton>
                    </Show>
                    <Show when={can(props.myPermissions, MANAGE_USERS)}>
                        <TabButton active={tab() === 'users'} onClick={() => setTab('users')}>
                            Users & Invites
                        </TabButton>
                    </Show>
                    <Show when={can(props.myPermissions, MANAGE_ROLES)}>
                        <TabButton active={tab() === 'roles'} onClick={() => setTab('roles')}>
                            Roles
                        </TabButton>
                    </Show>
                </div>

                {/* Body */}
                <div class="flex-1 overflow-y-auto p-6">
                    <Show when={tab() === 'audit'}>
                        <AuditLogView />
                    </Show>
                    <Show when={tab() === 'users'}>
                        <UsersView />
                    </Show>
                    <Show when={tab() === 'roles'}>
                        <RolesView />
                    </Show>
                </div>
            </div>
        </Modal>
    )
}

const TabButton: Component<{ active: boolean; onClick: () => void; children: any }> = (props) => (
    <button
        onClick={props.onClick}
        class={`rounded-lg px-4 py-2 text-sm font-bold transition-all ${
            props.active
                ? 'bg-highlight-strongest text-white'
                : 'text-sub hover:bg-element-accent hover:text-main'
        }`}
    >
        {props.children}
    </button>
)

// --- Audit Log ---

// humanizeAction turns an event constant like "MOMENT_CREATED" or an audit
// action like "moment.create" into a readable "Moment created" for the
// default (non-advanced) view.
const humanizeAction = (action: string): string => {
    const words = action.toLowerCase().replace(/[_.]/g, ' ').trim()
    return words.charAt(0).toUpperCase() + words.slice(1)
}

// A small set of actions map to an icon for quick scanning.
const actionIcon = (action: string): string => {
    const normalized = action.toLowerCase()
    if (normalized.includes('delete')) return 'delete'
    if (normalized.includes('create')) return 'add_circle'
    if (normalized.includes('update') || normalized.includes('edit')) return 'edit'
    if (normalized.includes('login') || normalized.includes('auth')) return 'login'
    if (normalized.includes('role') || normalized.includes('permission')) return 'shield'
    return 'history'
}

const AuditLogView: Component = () => {
    const [entries, setEntries] = createSignal<AuditEntry[]>([])
    const [loading, setLoading] = createSignal(true)
    const [cursor, setCursor] = createSignal<number | undefined>(undefined)
    const [hasMore, setHasMore] = createSignal(false)
    // Advanced mode surfaces the raw fields (full action constant, actor/target
    // IDs, details JSON). Default mode is the readable, resolved view.
    const [advanced, setAdvanced] = createSignal(false)

    const load = async (reset = false) => {
        setLoading(true)
        try {
            const result = await api.getAuditLog({
                limit: 50,
                cursor_id: reset ? undefined : cursor(),
            })
            if (reset) {
                setEntries(result)
            } else {
                setEntries((prev) => [...prev, ...result])
            }
            if (result.length > 0) {
                setCursor(result[result.length - 1].id)
            }
            setHasMore(result.length === 50)
        } catch (err) {
            console.error('Failed to load audit log:', err)
        } finally {
            setLoading(false)
        }
    }

    onMount(() => {
        loadUsers()
        load(true)
    })

    // A target label: resolve to a username when the target is a user,
    // otherwise show "type #shortid".
    const targetLabel = (entry: AuditEntry): string => {
        if (!entry.target_type) return ''
        if (entry.target_type === 'user' && entry.target_id) return userName(entry.target_id)
        return `${entry.target_type}${entry.target_id ? ` #${entry.target_id.slice(0, 8)}` : ''}`
    }

    return (
        <div class="space-y-2">
            <div class="mb-2 flex items-center justify-between">
                <h3 class="text-main font-serif text-sm tracking-wide">Audit Log</h3>
                <label class="text-sub flex cursor-pointer items-center gap-1.5 text-xs">
                    <input
                        type="checkbox"
                        checked={advanced()}
                        onChange={(e) => setAdvanced(e.currentTarget.checked)}
                        class="h-3.5 w-3.5"
                    />
                    Advanced
                </label>
            </div>
            <Show when={!loading() && entries().length === 0}>
                <p class="text-sub text-sm italic">No audit entries yet.</p>
            </Show>
            <For each={entries()}>
                {(entry) => (
                    <div class="bg-element border-element-accent rounded-md border p-3">
                        <Show
                            when={!advanced()}
                            fallback={
                                <div class="space-y-1">
                                    <div class="flex items-center justify-between gap-2">
                                        <span class="text-highlight-strong font-mono text-xs font-bold">{entry.action}</span>
                                        <span class="text-sub text-xs">{formatDateTime(entry.created_at)}</span>
                                    </div>
                                    <div class="text-sub text-xs">
                                        <span class="opacity-70">Actor:</span>{' '}
                                        <span class="font-mono">{entry.actor_id}</span>
                                        <Show when={entry.target_type}>
                                            <span class="ml-2 opacity-70">Target:</span>{' '}
                                            <span class="font-mono">
                                                {entry.target_type}:{entry.target_id}
                                            </span>
                                        </Show>
                                    </div>
                                    <Show when={entry.details}>
                                        <pre class="text-sub bg-element-matte mt-1 max-h-32 overflow-x-auto rounded p-2 text-xs">{entry.details}</pre>
                                    </Show>
                                </div>
                            }
                        >
                            <div class="flex items-start gap-2.5">
                                <span class="material-symbols-outlined text-highlight mt-0.5 text-base">
                                    {actionIcon(entry.action)}
                                </span>
                                <div class="min-w-0 flex-1">
                                    <div class="flex items-baseline justify-between gap-2">
                                        <span class="text-main text-sm font-semibold">{humanizeAction(entry.action)}</span>
                                        <span class="text-sub shrink-0 text-xs">{formatDateTime(entry.created_at)}</span>
                                    </div>
                                    <div class="text-sub text-xs">
                                        <span class="text-highlight-strong">{userName(entry.actor_id)}</span>
                                        <Show when={entry.target_type}>
                                            {' '}
                                            <span class="opacity-70">→</span> {targetLabel(entry)}
                                        </Show>
                                    </div>
                                </div>
                            </div>
                        </Show>
                    </div>
                )}
            </For>
            <Show when={loading()}>
                <p class="text-sub py-4 text-center text-sm">Loading…</p>
            </Show>
            <Show when={hasMore() && !loading()}>
                <button
                    onClick={() => load(false)}
                    class="text-highlight-strongest text-sm font-bold hover:underline"
                >
                    Load more…
                </button>
            </Show>
        </div>
    )
}

// --- Users & Invites ---

const UsersView: Component = () => {
    const ui = useUI()
    const auth = useAuth()
    const [users, setUsers] = createSignal<User[]>([])
    const [roles, setRoles] = createSignal<Role[]>([])
    const [invites, setInvites] = createSignal<Invite[]>([])
    const [loading, setLoading] = createSignal(true)
    const [editingUser, setEditingUser] = createSignal<User | null>(null)
    const [selectedRoleIds, setSelectedRoleIds] = createSignal<string[]>([])
    const [saving, setSaving] = createSignal(false)
    const [newInviteUses, setNewInviteUses] = createSignal(1)
    const [newInviteDays, setNewInviteDays] = createSignal(0) // 0 = never expires

    const inviteLink = (id: string) => `${window.location.origin}/register?invite=${id}`
    const copy = (text: string, what: string) =>
        navigator.clipboard
            .writeText(text)
            .then(() => ui.toast(`${what} copied.`, 'success'))
            .catch(() => ui.toast('Could not copy to clipboard.', 'error'))

    const refresh = async () => {
        const [u, r, i] = await Promise.all([
            api.listAllUsers(),
            api.listRoles(),
            api.listInvites(),
        ])
        setUsers(u)
        setRoles(r)
        setInvites(i)
    }

    onMount(async () => {
        try {
            await refresh()
        } catch (err) {
            console.error('Failed to load admin data:', err)
        } finally {
            setLoading(false)
        }
    })

    const startEditUser = (user: User) => {
        setEditingUser(user)
        // Pre-select the user's current roles. We don't know role IDs from
        // the User model (it only has is_owner), so we start empty and let
        // the admin pick. The Member role is always added by the server.
        setSelectedRoleIds([])
    }

    const toggleRole = (id: string) => {
        setSelectedRoleIds((prev) =>
            prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id],
        )
    }

    const saveUserRoles = async () => {
        const user = editingUser()
        if (!user) return
        setSaving(true)
        try {
            await api.assignUserRoles(user.id, selectedRoleIds())
            setEditingUser(null)
            await refresh()
            // Editing your own roles changes your own gates; don't make the
            // event poll be the thing that tells you that.
            if (user.id === auth.user()?.id) await auth.refresh()
            ui.toast('Roles updated.', 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Failed to update roles', 'error')
        } finally {
            setSaving(false)
        }
    }

    const createInvite = async () => {
        try {
            const expiresAt = newInviteDays() > 0 ? new Date(Date.now() + newInviteDays() * 86400000).toISOString() : undefined
            await api.createInvite(newInviteUses(), expiresAt)
            setNewInviteUses(1)
            setNewInviteDays(0)
            await refresh()
            ui.toast('Invite created.', 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Failed to create invite', 'error')
        }
    }

    const revokeInvite = async (id: string) => {
        const ok = await ui.confirm({
            title: 'Revoke invite?',
            message: 'This invite link will stop working immediately.',
            confirmLabel: 'Revoke',
            danger: true,
        })
        if (!ok) return
        try {
            await api.revokeInvite(id)
            await refresh()
            ui.toast('Invite revoked.', 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Failed to revoke invite', 'error')
        }
    }

    const formatDate = (ts: string) =>
        new Intl.DateTimeFormat(navigator.language, {
            year: 'numeric', month: 'short', day: 'numeric',
        }).format(new Date(ts))

    return (
        <div class="space-y-6">
            {/* Users */}
            <section>
                <h3 class="text-main text-sm font-bold tracking-widest uppercase mb-2">Users</h3>
                <Show when={loading()}>
                    <p class="text-sub text-sm">Loading...</p>
                </Show>
                <div class="space-y-2">
                    <For each={users()}>
                        {(user) => (
                            <div class="bg-element border-element-accent flex items-center justify-between rounded-lg border p-3">
                                <div class="flex items-center gap-2">
                                    <span class="text-main font-bold">{user.username}</span>
                                    <Show when={user.is_owner}>
                                        <span class="text-highlight-strongest text-xs font-bold">★ Owner</span>
                                    </Show>
                                </div>
                                <div class="flex items-center gap-3">
                                    <span class="text-sub text-xs">{formatDate(user.created_at)}</span>
                                    <button
                                        onClick={() => startEditUser(user)}
                                        class="text-sub hover:text-highlight text-xs font-bold"
                                    >
                                        Edit Roles
                                    </button>
                                </div>
                            </div>
                        )}
                    </For>
                </div>
            </section>

            {/* User role editor */}
            <Show when={editingUser()}>
                <div class="bg-element-matte border-highlight rounded-xl border-2 p-4 space-y-3">
                    <div class="flex items-center justify-between">
                        <h4 class="text-main font-bold">
                            Roles for {editingUser()!.username}
                        </h4>
                        <button
                            onClick={() => setEditingUser(null)}
                            class="text-sub hover:text-plain text-sm"
                        >
                            Cancel
                        </button>
                    </div>
                    <p class="text-sub text-xs">
                        The Member role is always included automatically. The Owner role
                        cannot be removed from the owner.
                    </p>
                    <div class="flex flex-wrap gap-2">
                        <For each={roles()}>
                            {(role) => (
                                <button
                                    onClick={() => toggleRole(role.id)}
                                    disabled={role.is_default || (role.id === 'role_owner' && editingUser()!.is_owner)}
                                    class={`rounded-xl px-3 py-1 text-xs font-bold transition-all ${
                                        selectedRoleIds().includes(role.id)
                                            ? 'border-2 border-highlight'
                                            : 'border-2 border-transparent'
                                    } ${role.is_default || (role.id === 'role_owner' && editingUser()!.is_owner) ? 'opacity-50 cursor-not-allowed' : 'hover:cursor-pointer'}`}
                                    style={{
                                        'background-color': role.color + '33',
                                        'border-color': selectedRoleIds().includes(role.id) ? role.color : 'transparent',
                                        color: role.color,
                                    }}
                                >
                                    {role.name}
                                    <Show when={role.is_default}> (always)</Show>
                                </button>
                            )}
                        </For>
                    </div>
                    <button
                        onClick={saveUserRoles}
                        disabled={saving()}
                        class="bg-highlight-strongest text-white rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
                    >
                        {saving() ? 'Saving...' : 'Save Roles'}
                    </button>
                </div>
            </Show>

            {/* Invites */}
            <section>
                <h3 class="text-main text-sm font-bold tracking-widest uppercase mb-2">Invites</h3>
                <div class="flex flex-wrap items-end gap-3 mb-3">
                    <label class="flex flex-col gap-1">
                        <span class="text-sub text-[10px] font-bold uppercase tracking-wide">Uses</span>
                        <input
                            type="number"
                            min="1"
                            value={newInviteUses()}
                            onInput={(e) => setNewInviteUses(parseInt(e.currentTarget.value) || 1)}
                            class="bg-element text-main border-element-accent w-20 rounded-lg border px-3 py-2 text-sm"
                        />
                    </label>
                    <label class="flex flex-col gap-1">
                        <span class="text-sub text-[10px] font-bold uppercase tracking-wide">Expires</span>
                        <select
                            value={newInviteDays()}
                            onChange={(e) => setNewInviteDays(parseInt(e.currentTarget.value))}
                            class="bg-element text-main border-element-accent rounded-lg border px-3 py-2 text-sm"
                        >
                            <option value="0">Never</option>
                            <option value="1">1 day</option>
                            <option value="7">7 days</option>
                            <option value="30">30 days</option>
                        </select>
                    </label>
                    <button
                        onClick={createInvite}
                        class="bg-highlight-strongest text-white rounded-lg px-4 py-2 text-sm font-bold hover:opacity-90"
                    >
                        Create Invite
                    </button>
                </div>
                <div class="space-y-2">
                    <For each={invites()}>
                        {(invite) => (
                            <div class="bg-element border-element-accent flex flex-col gap-2 rounded-lg border p-3">
                                <div class="flex items-center justify-between gap-2">
                                    <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                        <span class="text-main font-mono text-xs">{invite.id}</span>
                                        <span class="text-sub text-xs">· {invite.uses_remaining} use(s) left</span>
                                        <Show when={invite.expires_at}>
                                            <span class="text-sub text-xs">· expires {new Date(invite.expires_at!).toLocaleDateString()}</span>
                                        </Show>
                                    </div>
                                    <button onClick={() => revokeInvite(invite.id)} class="text-sub hover:text-danger shrink-0 text-xs font-bold">
                                        Revoke
                                    </button>
                                </div>
                                <div class="flex items-center gap-2">
                                    <input
                                        readonly
                                        value={inviteLink(invite.id)}
                                        onFocus={(e) => e.currentTarget.select()}
                                        class="bg-element-matte text-sub border-element-accent min-w-0 flex-1 rounded-md border px-2 py-1 text-xs font-mono"
                                    />
                                    <button
                                        onClick={() => copy(inviteLink(invite.id), 'Invite link')}
                                        title="Copy shareable link"
                                        class="bg-element-accent text-sub hover:text-main flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold shrink-0"
                                    >
                                        <span class="material-symbols-outlined text-sm">link</span>
                                        Link
                                    </button>
                                    <button
                                        onClick={() => copy(invite.id, 'Invite code')}
                                        title="Copy raw code"
                                        class="bg-element-accent text-sub hover:text-main flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold shrink-0"
                                    >
                                        <span class="material-symbols-outlined text-sm">content_copy</span>
                                        Code
                                    </button>
                                </div>
                            </div>
                        )}
                    </For>
                    <Show when={invites().length === 0}>
                        <p class="text-sub text-sm italic">No active invites.</p>
                    </Show>
                </div>
            </section>
        </div>
    )
}

// --- Roles ---

const RolesView: Component = () => {
    const ui = useUI()
    const auth = useAuth()
    const [roles, setRoles] = createSignal<Role[]>([])
    const [loading, setLoading] = createSignal(true)
    const [editing, setEditing] = createSignal<Role | null>(null)
    const [isNew, setIsNew] = createSignal(false)
    const [name, setName] = createSignal('')
    const [color, setColor] = createSignal('#999999')
    const [position, setPosition] = createSignal(0)
    const [perms, setPerms] = createSignal(0)
    const [saving, setSaving] = createSignal(false)

    const refresh = async () => setRoles(await api.listRoles())

    onMount(async () => {
        try {
            await refresh()
        } finally {
            setLoading(false)
        }
    })

    const startNew = () => {
        setIsNew(true)
        setEditing(null)
        setName('New Role')
        setColor('#999999')
        setPosition((roles().length))
        setPerms(0)
    }

    const startEdit = (role: Role) => {
        setIsNew(false)
        setEditing(role)
        setName(role.name)
        setColor(role.color)
        setPosition(role.position)
        setPerms(role.permissions)
    }

    const cancel = () => {
        setEditing(null)
        setIsNew(false)
    }

    const save = async () => {
        setSaving(true)
        try {
            if (isNew()) {
                await api.createRole(name(), color(), position(), perms())
            } else if (editing()) {
                await api.updateRole(editing()!.id, {
                    name: name(),
                    color: color(),
                    position: position(),
                    permissions: perms(),
                })
            }
            await refresh()
            cancel()
            // Editing a role you hold (Member, which everyone holds, most of
            // all) changes your own permissions.
            await auth.refresh()
            ui.toast('Role saved.', 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Failed to save role', 'error')
        } finally {
            setSaving(false)
        }
    }

    const remove = async (id: string) => {
        const ok = await ui.confirm({
            title: 'Delete role?',
            message: 'Users assigned to it will lose its permissions. This cannot be undone.',
            confirmLabel: 'Delete',
            danger: true,
        })
        if (!ok) return
        try {
            await api.deleteRole(id)
            await refresh()
            await auth.refresh()
            ui.toast('Role deleted.', 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Failed to delete role', 'error')
        }
    }

    return (
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <h3 class="text-main text-sm font-bold tracking-widest uppercase">Roles</h3>
                <button
                    onClick={startNew}
                    class="bg-highlight-strongest text-white rounded-lg px-3 py-1 text-xs font-bold hover:opacity-90"
                >
                    + New Role
                </button>
            </div>

            <Show when={loading()}>
                <p class="text-sub text-sm">Loading...</p>
            </Show>

            {/* Role list */}
            <div class="space-y-2">
                <For each={roles()}>
                    {(role) => (
                        <div class="bg-element border-element-accent rounded-lg border p-3">
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-2">
                                    <span
                                        class="h-4 w-4 rounded-full"
                                        style={{ 'background-color': role.color }}
                                    />
                                    <span class="text-main font-bold">{role.name}</span>
                                    <Show when={role.is_preset}>
                                        <span class="text-sub text-xs">(preset)</span>
                                    </Show>
                                    <Show when={role.is_default}>
                                        <span class="text-sub text-xs">(default)</span>
                                    </Show>
                                </div>
                                <div class="flex gap-2">
                                    <Show when={!role.is_default || role.id !== 'role_owner'}>
                                        <button
                                            onClick={() => startEdit(role)}
                                            disabled={role.id === 'role_owner'}
                                            class="text-sub hover:text-highlight text-xs font-bold disabled:opacity-30"
                                        >
                                            Edit
                                        </button>
                                    </Show>
                                    <Show when={!role.is_preset && role.id !== 'role_owner'}>
                                        <button
                                            onClick={() => remove(role.id)}
                                            class="text-sub hover:text-danger text-xs font-bold"
                                        >
                                            Delete
                                        </button>
                                    </Show>
                                </div>
                            </div>
                            <div class="text-sub text-xs mt-1">
                                {PERMISSIONS.filter((p) => hasPermission(role.permissions, p.bit)).map((p) => p.label).join(', ') || 'No permissions'}
                            </div>
                        </div>
                    )}
                </For>
            </div>

            {/* Role editor */}
            <Show when={isNew() || editing()}>
                <div class="bg-element-matte border-highlight rounded-xl border-2 p-4 space-y-4">
                    <div class="flex items-center justify-between">
                        <h4 class="text-main font-bold">
                            {isNew() ? 'New Role' : `Edit ${editing()!.name}`}
                        </h4>
                        <button onClick={cancel} class="text-sub hover:text-plain text-sm">Cancel</button>
                    </div>

                    <div class="grid grid-cols-2 gap-3">
                        <label class="flex flex-col gap-1">
                            <span class="text-sub text-xs font-bold uppercase">Name</span>
                            <input
                                type="text"
                                value={name()}
                                onInput={(e) => setName(e.currentTarget.value)}
                                class="bg-element text-main border-element-accent rounded-lg border px-3 py-2 text-sm"
                            />
                        </label>
                        <label class="flex flex-col gap-1">
                            <span class="text-sub text-xs font-bold uppercase">Color</span>
                            <input
                                type="color"
                                value={color()}
                                onInput={(e) => setColor(e.currentTarget.value)}
                                class="h-10 w-full cursor-pointer rounded border-0 bg-transparent p-0"
                            />
                        </label>
                        <label class="flex flex-col gap-1">
                            <span class="text-sub text-xs font-bold uppercase">Position</span>
                            <input
                                type="number"
                                value={position()}
                                onInput={(e) => setPosition(parseInt(e.currentTarget.value) || 0)}
                                class="bg-element text-main border-element-accent rounded-lg border px-3 py-2 text-sm"
                            />
                        </label>
                    </div>

                    {/* Permission grid */}
                    <div>
                        <span class="text-sub text-xs font-bold uppercase block mb-2">Permissions</span>
                        <div class="space-y-3">
                            <For each={PERMISSION_GROUPS}>
                                {(group) => (
                                    <div>
                                        <div class="text-highlight text-xs font-bold mb-1">{group}</div>
                                        <div class="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                                            <For each={PERMISSIONS.filter((p) => p.group === group)}>
                                                {(perm) => (
                                                    <label class="flex items-center gap-2 bg-element hover:bg-element-accent rounded p-2 text-xs transition-colors cursor-pointer">
                                                        <input
                                                            type="checkbox"
                                                            checked={hasPermission(perms(), perm.bit)}
                                                            onChange={() => setPerms(togglePermission(perms(), perm.bit))}
                                                        />
                                                        <span class="text-sub">{perm.label}</span>
                                                    </label>
                                                )}
                                            </For>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                    </div>

                    <button
                        onClick={save}
                        disabled={saving()}
                        class="bg-highlight-strongest text-white rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
                    >
                        {saving() ? 'Saving...' : 'Save Role'}
                    </button>
                </div>
            </Show>
        </div>
    )
}

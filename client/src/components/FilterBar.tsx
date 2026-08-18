import { Show, type Component } from 'solid-js'

interface FilterBarProps {
    onOpenChat: () => void
    onOpenSettings: () => void
    onOpenAdmin: () => void
    onOpenTodos: () => void
    onOpenProjects: () => void
    onOpenCanvas: () => void
    username: string
    isOwner: boolean
    canManageUsers: boolean
    canManageRoles: boolean
    canViewAuditLog: boolean
}

export const FilterBar: Component<FilterBarProps> = (props) => {
    return (
        <div class="bg-element flex flex-col gap-4 rounded-xl p-4 transition-all duration-100">
            <span class="text-sub text-lg font-bold tracking-widest">
                Menu
            </span>

            {/* Chat button */}
            <button
                onClick={props.onOpenChat}
                class="bg-element border-element-accent hover:border-highlight group flex w-full flex-col gap-3 rounded-xl border p-3 text-left transition-all duration-100 hover:scale-[1.02] hover:cursor-pointer"
            >
                <div class="flex w-full items-center justify-between">
                    <div class="flex items-center gap-2">
                        <span class="material-symbols-outlined text-highlight text-xl">
                            message
                        </span>
                        <span class="text-sub text-sm font-bold tracking-widest">
                            CHAT
                        </span>
                    </div>
                </div>
            </button>

            {/* Modules: Todos + Canvas (4.9 / 4.10) */}
            <div class="flex gap-2">
                <button
                    onClick={props.onOpenTodos}
                    class="bg-element hover:border-highlight border-element-accent flex flex-1 items-center justify-center gap-2 rounded-xl border p-3 text-center font-bold transition-all duration-100 hover:scale-[1.02] hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-xl">checklist</span>
                    <span class="text-sub text-sm">Todos</span>
                </button>
                <button
                    onClick={props.onOpenProjects}
                    class="bg-element hover:border-highlight border-element-accent flex flex-1 items-center justify-center gap-2 rounded-xl border p-3 text-center font-bold transition-all duration-100 hover:scale-[1.02] hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-xl">space_dashboard</span>
                    <span class="text-sub text-sm">Projects</span>
                </button>
                <button
                    onClick={props.onOpenCanvas}
                    class="bg-element hover:border-highlight border-element-accent flex flex-1 items-center justify-center gap-2 rounded-xl border p-3 text-center font-bold transition-all duration-100 hover:scale-[1.02] hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-xl">dashboard</span>
                    <span class="text-sub text-sm">Canvas</span>
                </button>
            </div>

            {/* Settings button */}
            <button
                onClick={props.onOpenSettings}
                class="bg-element hover:border-highlight border-element-accent flex items-center justify-center gap-2 rounded-xl border p-3 text-center font-bold transition-all duration-100 hover:scale-[1.02] hover:cursor-pointer"
            >
                <span class="material-symbols-outlined text-xl">
                    settings
                </span>
                <span class="text-sub">Settings</span>
            </button>

            {/* Admin button: only shown if the user has any admin permission */}
            <Show when={props.canManageUsers || props.canManageRoles || props.canViewAuditLog}>
                <button
                    onClick={props.onOpenAdmin}
                    class="bg-element hover:border-highlight border-element-accent flex items-center justify-center gap-2 rounded-xl border p-3 text-center font-bold transition-all duration-100 hover:scale-[1.02] hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-xl">
                        admin_panel_settings
                    </span>
                    <span class="text-sub">Admin</span>
                </button>
            </Show>

            {/* User info. Logout lives in a fixed viewport element (see App),
                independent of this panel. */}
            <div class="bg-element-matte rounded-lg p-3 shadow-inner">
                <div class="flex items-center gap-2">
                    <span class="material-symbols-outlined text-highlight text-xl">
                        person
                    </span>
                    <span class="text-main text-sm font-bold">
                        {props.username}
                    </span>
                    {props.isOwner && (
                        <span class="text-highlight-strongest text-xs font-bold">
                            ★ Owner
                        </span>
                    )}
                </div>
            </div>
        </div>
    )
}

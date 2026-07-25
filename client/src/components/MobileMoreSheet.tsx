import { Show, type Component } from 'solid-js'

// The "More" sheet's body: everything the desktop right-hand menu held that
// isn't already a bottom-nav slot: modules, settings, admin, identity, logout.
export const MobileMoreSheet: Component<{
    username: string
    isOwner: boolean
    canAdmin: boolean
    onTodos: () => void
    onCanvas: () => void
    onSettings: () => void
    onAdmin: () => void
    onLogout: () => void
}> = (props) => {
    const Row = (p: { icon: string; label: string; onClick: () => void; danger?: boolean }) => (
        <button
            onClick={p.onClick}
            class="border-element-accent flex w-full items-center gap-3 border-b py-3.5 text-left last:border-b-0"
        >
            <span class="material-symbols-outlined text-xl" classList={{ 'text-danger': p.danger, 'text-sub': !p.danger }}>{p.icon}</span>
            <span class="flex-1 text-[15px] font-bold" classList={{ 'text-danger': p.danger, 'text-main': !p.danger }}>{p.label}</span>
            <Show when={!p.danger}>
                <span class="material-symbols-outlined text-lg text-white/20">chevron_right</span>
            </Show>
        </button>
    )

    return (
        <div class="flex flex-col">
            <Row icon="checklist" label="Todos" onClick={props.onTodos} />
            <Row icon="dashboard" label="Canvas" onClick={props.onCanvas} />
            <Row icon="settings" label="Settings" onClick={props.onSettings} />
            <Show when={props.canAdmin}>
                <Row icon="admin_panel_settings" label="Admin" onClick={props.onAdmin} />
            </Show>

            <div class="bg-element-accent mt-3 flex items-center gap-2 rounded-xl p-3">
                <span class="material-symbols-outlined text-highlight text-xl">person</span>
                <span class="text-main text-sm font-bold">{props.username}</span>
                <Show when={props.isOwner}>
                    <span class="text-highlight-strongest text-xs font-bold">★ Owner</span>
                </Show>
            </div>

            <button onClick={props.onLogout} class="text-danger mt-2 flex w-full items-center gap-3 py-3.5 text-left">
                <span class="material-symbols-outlined text-danger text-xl">logout</span>
                <span class="flex-1 text-[15px] font-bold">Log out</span>
            </button>
        </div>
    )
}

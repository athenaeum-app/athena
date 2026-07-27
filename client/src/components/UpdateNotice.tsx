import { For, type Component } from 'solid-js'

// Shown once, after the client has replaced itself with a newer build.
//
// Deliberately not the shared toast() from ui.tsx: that clears itself after
// four seconds, and a message whose entire job is explaining a refresh the
// reader did not ask for is the one message that has to still be there when
// they look back at the screen.
export const UpdateNotice: Component<{
    version: string
    notes: string[]
    onDismiss: () => void
}> = (props) => (
    <div
        role="status"
        data-testid="update-notice"
        class="bg-element-matte border-element-accent mx-3 mt-3 flex shrink-0 items-start gap-3 rounded-xl border p-3"
    >
        <span class="material-symbols-outlined text-highlight-strongest text-xl">rocket_launch</span>
        <div class="min-w-0 flex-1">
            <p class="text-main text-sm font-bold">Updated to v{props.version}</p>
            <ul class="text-sub mt-1 list-disc space-y-0.5 pl-4 text-sm">
                <For each={props.notes}>{(note) => <li>{note}</li>}</For>
            </ul>
        </div>
        <button
            type="button"
            onClick={props.onDismiss}
            aria-label="Dismiss update notice"
            class="text-sub hover:text-main shrink-0 transition-colors hover:cursor-pointer"
        >
            <span class="material-symbols-outlined text-base">close</span>
        </button>
    </div>
)

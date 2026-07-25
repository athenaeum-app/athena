import { createSignal, For, Show, onMount, type Component } from 'solid-js'
import { desktop, shellRailOpen, type DesktopLibrary } from '../desktop'
import { prefs } from '../prefs'

// Libraries switcher. A library == a server (ADR-0004); switching only
// works in the desktop shell, which exposes the profile list over the content
// bridge. In a browser / single-server context there is nothing to switch
// between, so this renders nothing.
//
// Two variants, chosen by the librariesPlacement pref:
//  - 'panel': a labelled card that stacks above/below the Archives column
//    (the 'inline-above' / 'inline-below' modes).
//  - 'rail' : a full-height column on the far left (the 'left-rail' mode),
//    the shelf described below.
//
// The rail is a port of the native shell's sidebar, not a new design. That
// sidebar is the elegant one and the one people recognise, and an earlier pass
// replaced it in-app with a narrow strip of initials squeezed beside Archives,
// which read as a third, worse switcher rather than the same one in a new home.
// So the shelf comes across intact: each library is a book standing on it, its
// spine a pair of coloured edges (deterministic per library, so the shelf reads
// as a run of different books), its name set in the brand serif like lettering
// on a spine, with a small status light. The active book eases out.
//
// prefs.librariesCompact (default on) sizes the rail's shelf to its contents,
// ending just below the last library, rather than stretching to the column's
// full height, which otherwise reads as a mostly-empty box for anyone with
// only a couple of libraries. Off pins it to the full column height, capped
// and internally scrolling either way once there are enough libraries to fill
// it. Only applies to the 'rail' variant; the panel sizes to its contents.
//
// Adding, renaming, removing and reordering servers is still native-only, so
// the footer hands off to the shell for that (desktop().openRail()) rather than
// reimplementing the modals here. Opening it stands this switcher down (see
// shellRailOpen in ../desktop) so there is only ever one on screen.
//
// librariesSwitcherVisible() is exported for the App, which reserves a column
// for the 'rail' variant and must drop that column too rather than leave an
// empty gutter.

const initials = (name: string) => (name.trim().slice(0, 2).toUpperCase() || '?')

// Whether the in-PWA switcher renders at all: only in a desktop shell new
// enough to expose the profile list, and only while the native rail is down.
export const librariesSwitcherVisible = () => !!desktop()?.listLibraries && !shellRailOpen()

// Muted book-spine colours, desaturated so a shelf of them stays quiet. Ported
// verbatim from the shell's SPINES so a library keeps the same colours whether
// you are looking at the native sidebar or this one.
const SPINES = ['#9c6b6b', '#6b83a0', '#7f9068', '#a08a63', '#836b9c', '#5f9089', '#a07a5f']

function spineColors(id: string): [string, string] {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
    const a = h % SPINES.length
    // A distinct second colour for the shorter book.
    const b = (a + 1 + ((h >>> 3) % (SPINES.length - 1))) % SPINES.length
    return [SPINES[a], SPINES[b]]
}

export const LibrariesPanel: Component<{ variant?: 'panel' | 'rail' }> = (props) => {
    const [libs, setLibs] = createSignal<DesktopLibrary[]>([])
    const [activeId, setActiveId] = createSignal<string | null>(null)
    const [available, setAvailable] = createSignal(false)

    onMount(async () => {
        const bridge = desktop()
        if (!bridge?.listLibraries) return
        setAvailable(true)
        try {
            setLibs((await bridge.listLibraries()) ?? [])
            if (bridge.activeLibraryId) setActiveId((await bridge.activeLibraryId()) ?? null)
        } catch {
            /* best-effort; leave empty so only the manage action renders */
        }
    })

    const switchTo = (id: string) => {
        if (id !== activeId()) desktop()?.switchServer(id)
    }

    const manage = () => desktop()?.openRail()

    // Rail: the shelf. Sized to the App's rail column; compact by default
    // (see prefs.librariesCompact above).
    const rail = () => (
        <div
            class="bg-element flex min-h-0 flex-col rounded-xl py-3"
            classList={{ 'h-full': !prefs().librariesCompact, 'max-h-full': prefs().librariesCompact }}
        >
            <p class="text-sub px-4 pb-2 text-[0.62rem] font-bold uppercase tracking-[0.12em]">Libraries</p>

            <div class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
                <For each={libs()}>
                    {(lib) => {
                        const [tall, short] = spineColors(lib.id)
                        const active = () => activeId() === lib.id
                        return (
                            <button
                                type="button"
                                onClick={() => switchTo(lib.id)}
                                title={`${lib.name} (${lib.url})`}
                                class="group flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:cursor-pointer"
                                classList={{
                                    'bg-element-accent': active(),
                                    'hover:bg-element-lighter': !active(),
                                }}
                            >
                                {/* Two books standing on the shelf line: a taller
                                    volume and a shorter one beside it. */}
                                <span
                                    class="ml-2 flex h-[30px] shrink-0 items-end gap-[2px] transition-opacity"
                                    classList={{ 'opacity-100': active(), 'opacity-70 group-hover:opacity-100': !active() }}
                                >
                                    <span
                                        class="w-[3px] rounded-t-[1px] transition-all"
                                        style={{ height: active() ? '28px' : '24px', 'background-color': tall }}
                                    />
                                    <span
                                        class="w-[3px] rounded-t-[1px] transition-all"
                                        style={{ height: active() ? '20px' : '17px', 'background-color': short }}
                                    />
                                </span>

                                <span
                                    class="min-w-0 flex-1 truncate font-serif text-[0.94rem] font-medium"
                                    classList={{ 'text-plain': active(), 'text-main': !active() }}
                                >
                                    {lib.name}
                                </span>

                                {/* Quiet by default; coloured once the shell has
                                    a health result for this library. */}
                                <span
                                    class="h-[7px] w-[7px] shrink-0 rounded-full transition-colors"
                                    classList={{
                                        'bg-green-500 shadow-[0_0_6px] shadow-green-500': lib.status === 'online',
                                        'bg-danger opacity-90': lib.status === 'offline',
                                        'bg-sub opacity-60': !lib.status,
                                    }}
                                    title={lib.status ?? 'status unknown'}
                                />
                            </button>
                        )
                    }}
                </For>
            </div>

            <div class="border-element-accent mt-2 border-t px-2 pt-2">
                <button
                    type="button"
                    onClick={manage}
                    title="Add, rename, remove or reorder libraries"
                    class="border-element-accent text-sub hover:border-highlight hover:text-main flex w-full items-center justify-center gap-1.5 rounded border border-dashed px-2 py-2 text-xs font-bold transition-colors hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-base">tune</span>
                    Manage
                </button>
            </div>
        </div>
    )

    const panel = () => (
        <div class="bg-element rounded-xl p-3">
            <div class="mb-2 flex items-center justify-between gap-2">
                <p class="text-sub text-[11px] font-bold uppercase tracking-widest">Libraries</p>
                <button
                    onClick={manage}
                    title="Manage libraries"
                    aria-label="Manage libraries"
                    class="text-sub hover:text-highlight-strongest hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-base align-middle">tune</span>
                </button>
            </div>
            <Show
                when={libs().length > 1}
                fallback={<p class="text-sub/60 text-xs italic">Add another library to switch between them here.</p>}
            >
                <div class="flex flex-col gap-1">
                    <For each={libs()}>
                        {(lib) => (
                            <button
                                onClick={() => switchTo(lib.id)}
                                title={lib.url}
                                class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-bold transition-colors hover:cursor-pointer"
                                classList={{
                                    'bg-highlight-strongest text-white': activeId() === lib.id,
                                    'text-sub hover:bg-element-accent hover:text-main': activeId() !== lib.id,
                                }}
                            >
                                <span class="bg-element-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-black">{initials(lib.name)}</span>
                                <span class="truncate">{lib.name}</span>
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    )

    return <Show when={available() && !shellRailOpen()}>{props.variant === 'rail' ? rail() : panel()}</Show>
}

import {
    type Accessor,
    type Component,
    type JSX,
    createContext,
    createEffect,
    createSignal,
    For,
    onCleanup,
    onMount,
    useContext,
} from 'solid-js'

// A table of contents for the settings panel, built from the sections
// themselves rather than from a list somebody has to remember to update.
//
// Appearance alone is a dozen sections tall, and scrolled halfway down it
// there was nothing on screen saying which one you were in. Each section
// registers itself here; the nav lists them in document order and follows the
// scroll position.

export interface SettingsSectionEntry {
    id: string
    title: string
    el: HTMLElement
}

interface Registry {
    register: (entry: SettingsSectionEntry) => void
    unregister: (id: string) => void
}

const RegistryContext = createContext<Registry>()

// Document order, not registration order: a section inside a <Show> that flips
// on later would otherwise land at the end of the list wherever it sits on the
// page.
function inDocumentOrder(entries: SettingsSectionEntry[]): SettingsSectionEntry[] {
    return [...entries].sort((a, b) =>
        a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
}

export function createSettingsSections(): {
    sections: Accessor<SettingsSectionEntry[]>
    Provider: Component<{ children: JSX.Element }>
} {
    const [entries, setEntries] = createSignal<SettingsSectionEntry[]>([])
    const registry: Registry = {
        register: (entry) => setEntries((prev) => [...prev.filter((e) => e.id !== entry.id), entry]),
        unregister: (id) => setEntries((prev) => prev.filter((e) => e.id !== id)),
    }
    return {
        sections: () => inDocumentOrder(entries()),
        Provider: (props) => (
            <RegistryContext.Provider value={registry}>{props.children}</RegistryContext.Provider>
        ),
    }
}

const slug = (title: string) =>
    title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')

// Every heading in a settings tab goes through this, so the nav sees all of
// them and they cannot drift apart in size or spacing.
export const SettingsSection: Component<{ title: string; children: JSX.Element }> = (props) => {
    const registry = useContext(RegistryContext)
    let el!: HTMLElement

    onMount(() => {
        const id = slug(props.title)
        registry?.register({ id, title: props.title, el })
        onCleanup(() => registry?.unregister(id))
    })

    return (
        <section ref={el} data-settings-section={slug(props.title)}>
            <h3 class="text-main font-serif text-base font-semibold mb-3">{props.title}</h3>
            {props.children}
        </section>
    )
}

// How far below the top of the scroll box a section has to sit before the one
// above it stops counting as the one you are reading.
const ACTIVE_LINE = 24

export const SettingsSectionNav: Component<{
    sections: Accessor<SettingsSectionEntry[]>
    scroller: Accessor<HTMLElement | undefined>
}> = (props) => {
    const [activeId, setActiveId] = createSignal('')
    const [marker, setMarker] = createSignal({ top: 0, height: 0 })
    const buttons = new Map<string, HTMLButtonElement>()

    const sync = () => {
        const root = props.scroller()
        const list = props.sections()
        if (!root || list.length === 0) return
        const rootTop = root.getBoundingClientRect().top
        let current = list[0]
        for (const entry of list) {
            if (entry.el.getBoundingClientRect().top - rootTop <= ACTIVE_LINE) current = entry
        }
        // A last section too short to ever reach the line would otherwise never
        // be reachable, so being scrolled to the end claims it. Both guards
        // matter: a tab that does not scroll at all is *always* at its end, and
        // without them it sat pinned to its final section forever.
        const maxScroll = root.scrollHeight - root.clientHeight
        const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 2
        const last = list[list.length - 1]
        const lastHeadingOffset = last.el.getBoundingClientRect().top - rootTop + root.scrollTop
        if (maxScroll > 0 && atBottom && lastHeadingOffset - ACTIVE_LINE > maxScroll) current = last
        setActiveId(current.id)
    }

    onMount(() => {
        const root = props.scroller()
        if (!root) return
        root.addEventListener('scroll', sync, { passive: true })
        onCleanup(() => root.removeEventListener('scroll', sync))

        // Sections arrive after their controls have laid out, and a control
        // opening (the theme editor, a revealed sub-setting) moves every
        // section below it.
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(sync)
            observer.observe(root)
            onCleanup(() => observer.disconnect())
        }
    })

    // Re-run when the section list changes, which covers switching tabs.
    createEffect(() => {
        props.sections()
        queueMicrotask(sync)
    })

    createEffect(() => {
        const button = buttons.get(activeId())
        if (button) setMarker({ top: button.offsetTop, height: button.offsetHeight })
    })

    const goTo = (entry: SettingsSectionEntry) => {
        const root = props.scroller()
        if (!root) return
        const delta = entry.el.getBoundingClientRect().top - root.getBoundingClientRect().top
        root.scrollTo({ top: root.scrollTop + delta - 8, behavior: 'smooth' })
    }

    return (
        <nav
            data-testid="settings-section-nav"
            aria-label="Sections"
            class="border-element-accent hidden w-52 shrink-0 overflow-y-auto border-r py-6 pl-4 pr-2 lg:block"
        >
            <div class="relative">
                {/* The rail, and the segment of it that marks where you are. */}
                <div class="bg-element-accent absolute left-0 top-0 bottom-0 w-px" />
                <div
                    class="bg-highlight-strongest absolute left-0 w-0.5 rounded-full transition-all duration-200"
                    style={{ top: `${marker().top}px`, height: `${marker().height}px` }}
                />
                <For each={props.sections()}>
                    {(entry) => (
                        <button
                            ref={(el) => buttons.set(entry.id, el)}
                            type="button"
                            onClick={() => goTo(entry)}
                            aria-current={activeId() === entry.id ? 'true' : undefined}
                            class="block w-full rounded-r-md py-1.5 pl-3 pr-2 text-left text-sm transition-colors hover:cursor-pointer"
                            classList={{
                                'text-main font-semibold': activeId() === entry.id,
                                'text-sub hover:text-main': activeId() !== entry.id,
                            }}
                        >
                            {entry.title}
                        </button>
                    )}
                </For>
            </div>
        </nav>
    )
}

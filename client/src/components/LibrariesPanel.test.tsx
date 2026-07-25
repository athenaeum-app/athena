import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@solidjs/testing-library'
import type { AthenaDesktop } from '../desktop'

// The Libraries switcher and the desktop shell's native sidebar are the same
// control, so only one of them is ever on screen. These cover the PWA half of
// that: which side is showing is pushed over the bridge by the main process
// (electron/src/main.js), and this component stands down when told the native
// sidebar is up.
//
// desktop.ts subscribes at module scope, so each case installs its own stub
// bridge on window and then imports the modules fresh.

const LIBS = [
    { id: 'a', name: 'Personal', url: 'http://one.local' },
    { id: 'b', name: 'Shared', url: 'http://two.local' },
]

// A stub shell bridge, plus a handle to fire visibility changes at it the way
// main.js would.
function installBridge(
    opts: {
        railVisible?: boolean
        supportsRailVisibility?: boolean
        // Reachability the shell has gathered, keyed by library id.
        statuses?: Record<string, string>
    } = {},
) {
    const { railVisible = false, supportsRailVisibility = true, statuses } = opts
    let listener: ((visible: boolean) => void) | undefined
    const bridge: Partial<AthenaDesktop> = {
        listLibraries: vi
            .fn()
            .mockResolvedValue(statuses ? LIBS.map((l) => ({ ...l, status: statuses[l.id] })) : LIBS),
        activeLibraryId: vi.fn().mockResolvedValue('a'),
        switchServer: vi.fn().mockResolvedValue(true),
        openRail: vi.fn().mockResolvedValue(true),
    }
    if (supportsRailVisibility) {
        bridge.railVisible = vi.fn().mockResolvedValue(railVisible)
        bridge.onRailVisibility = (cb) => {
            listener = cb
            return () => (listener = undefined)
        }
    }
    window.athenaDesktop = bridge as AthenaDesktop
    return { setRailVisible: (v: boolean) => listener?.(v) }
}

async function loadPanel() {
    vi.resetModules()
    return await import('./LibrariesPanel')
}

beforeEach(() => {
    vi.resetModules()
})

afterEach(() => {
    delete window.athenaDesktop
    // setPref persists to localStorage independently of vi.resetModules(), so
    // a pref changed in one test (e.g. librariesCompact) would otherwise leak
    // into the next test's fresh module instance.
    localStorage.clear()
})

describe('LibrariesPanel', () => {
    it('lists the libraries when the shell sidebar is hidden', async () => {
        installBridge({ railVisible: false })
        const { LibrariesPanel } = await loadPanel()
        render(() => <LibrariesPanel />)

        await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())
        expect(screen.getByText('Shared')).toBeInTheDocument()
    })

    it('renders nothing when the shell sidebar is already open on load', async () => {
        installBridge({ railVisible: true })
        const { LibrariesPanel, librariesSwitcherVisible } = await loadPanel()
        render(() => <LibrariesPanel />)

        await waitFor(() => expect(librariesSwitcherVisible()).toBe(false))
        expect(screen.queryByText('Personal')).not.toBeInTheDocument()
    })

    it('stands down and comes back as the shell sidebar opens and closes', async () => {
        const { setRailVisible } = installBridge({ railVisible: false })
        const { LibrariesPanel, librariesSwitcherVisible } = await loadPanel()
        render(() => <LibrariesPanel />)

        await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())

        setRailVisible(true)
        await waitFor(() => expect(screen.queryByText('Personal')).not.toBeInTheDocument())
        // The App gates the reserved left-rail column on this, so it has to
        // agree with what the component rendered.
        expect(librariesSwitcherVisible()).toBe(false)

        setRailVisible(false)
        await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())
        expect(librariesSwitcherVisible()).toBe(true)
    })

    it('keeps showing on an older shell that cannot report sidebar visibility', async () => {
        installBridge({ supportsRailVisibility: false })
        const { LibrariesPanel, librariesSwitcherVisible } = await loadPanel()
        render(() => <LibrariesPanel />)

        await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())
        expect(librariesSwitcherVisible()).toBe(true)
    })

    // The rail is a port of the native shell's shelf, so it carries the things
    // that made it recognisable: names in full (not initials), a per-library
    // spine colour, and a reachability light.
    describe('rail variant', () => {
        it('shows every library by name, with the active one marked', async () => {
            installBridge()
            const { LibrariesPanel } = await loadPanel()
            render(() => <LibrariesPanel variant="rail" />)

            await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())
            expect(screen.getByText('Shared')).toBeInTheDocument()

            const active = screen.getByText('Personal').closest('button')!
            const inactive = screen.getByText('Shared').closest('button')!
            expect(active.className).toContain('bg-element-accent')
            expect(inactive.className).not.toContain('bg-element-accent')
        })

        it('gives each library its own spine colours, stable across renders', async () => {
            installBridge()
            const { LibrariesPanel } = await loadPanel()
            const { unmount } = render(() => <LibrariesPanel variant="rail" />)
            await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())

            const spinesOf = (name: string) =>
                Array.from(screen.getByText(name).closest('button')!.querySelectorAll('span[style*="background-color"]'))
                    .map((el) => (el as HTMLElement).style.backgroundColor)

            const personal = spinesOf('Personal')
            const shared = spinesOf('Shared')
            expect(personal).toHaveLength(2)
            expect(personal).not.toEqual(shared)

            unmount()
            render(() => <LibrariesPanel variant="rail" />)
            await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())
            expect(spinesOf('Personal')).toEqual(personal)
        })

        it('reports reachability when the shell knows it', async () => {
            installBridge({ statuses: { a: 'online', b: 'offline' } })
            const { LibrariesPanel } = await loadPanel()
            render(() => <LibrariesPanel variant="rail" />)

            await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())
            expect(screen.getByTitle('online')).toBeInTheDocument()
            expect(screen.getByTitle('offline')).toBeInTheDocument()
        })

        it('hands off to the shell for adding and removing libraries', async () => {
            installBridge()
            const { LibrariesPanel } = await loadPanel()
            render(() => <LibrariesPanel variant="rail" />)

            await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())
            const manage = screen.getByRole('button', { name: /Manage/ })
            manage.click()
            expect(window.athenaDesktop!.openRail).toHaveBeenCalled()
        })
    })

    // The panel variant (inline-above/inline-below) is a lighter switcher:
    // initials instead of full spines, and it hides itself entirely with a
    // single library rather than rendering a one-item list.
    describe('panel variant', () => {
        it('shows a placeholder instead of a list with only one library', async () => {
            installBridge()
            window.athenaDesktop!.listLibraries = vi.fn().mockResolvedValue([LIBS[0]])
            const { LibrariesPanel } = await loadPanel()
            render(() => <LibrariesPanel variant="panel" />)

            await waitFor(() => expect(screen.getByText('Libraries')).toBeInTheDocument())
            expect(screen.queryByText('Personal')).not.toBeInTheDocument()
            expect(screen.getByText(/Add another library/)).toBeInTheDocument()
        })

        it('lists libraries by initials once there is more than one', async () => {
            installBridge()
            const { LibrariesPanel } = await loadPanel()
            render(() => <LibrariesPanel variant="panel" />)

            await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())
            expect(screen.getByText('PE')).toBeInTheDocument()
            expect(screen.getByText('SH')).toBeInTheDocument()
        })
    })

    it('renders nothing in a browser, where there is no shell bridge', async () => {
        const { LibrariesPanel, librariesSwitcherVisible } = await loadPanel()
        render(() => <LibrariesPanel />)

        expect(librariesSwitcherVisible()).toBe(false)
        expect(screen.queryByText('Personal')).not.toBeInTheDocument()
    })

    // prefs.librariesCompact (default on) sizes the rail's shelf to its
    // contents; switching it off pins the shelf to the column's full height.
    // Only meaningful for the 'rail' variant.
    describe('compact sizing', () => {
        it('sizes to contents by default', async () => {
            installBridge()
            const { LibrariesPanel } = await loadPanel()
            const { container } = render(() => <LibrariesPanel variant="rail" />)
            await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())

            const shelf = container.querySelector('.bg-element')!
            expect(shelf.className).toContain('max-h-full')
            expect(shelf.className).not.toMatch(/(?<!max-)h-full/)
        })

        it('stretches to the full column height when turned off', async () => {
            installBridge()
            const { LibrariesPanel } = await loadPanel()
            const { setPref } = await import('../prefs')
            setPref('librariesCompact', false)
            const { container } = render(() => <LibrariesPanel variant="rail" />)
            await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument())

            const shelf = container.querySelector('.bg-element')!
            expect(shelf.className).toMatch(/(?<!max-)h-full/)
            expect(shelf.className).not.toContain('max-h-full')
        })
    })
})

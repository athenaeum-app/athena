import { createSignal, For, Show, onMount, onCleanup, type Component } from 'solid-js'
import { backdropDismiss } from '../dismiss'
import {
    PRESET_THEMES,
    type ThemeColors,
    type UserTheme,
    loadUserThemes,
    createUserTheme,
    updateUserTheme,
    deleteUserTheme,
    getActiveTheme,
    setActiveTheme,
    encodeTheme,
    decodeTheme,
    importTheme,
    defaultColors,
    type ScopedColors,
    getArchiveTheme,
    setArchiveTheme,
} from '../themes'
import { prefs, setPref, resetPrefs, DEFAULT_PREFS, MENU_WIDGET_META, ROW_LIMITS, type MenuWidget } from '../prefs'
import {
    PRESET_LOOKS,
    type LookVars,
    type UserLook,
    DEFAULT_LOOK_VARS,
    getActiveLook,
    setActiveLook,
    loadUserLooks,
    createUserLook,
    deleteUserLook,
    LOOK_FONTS,
} from '../looks'
import { TAG_COLOR_PRESETS, randomTagColor, type TagColorPreset } from '../tagColors'
import { api, type ServerStats, type Backup, type BackupSettings } from '../api'
import { formatDateTime } from '../format'
import { hasPermission, PERM } from '../permissions'
import {
    KEYBIND_DEFS,
    keybinds,
    setKeybind,
    resetKeybinds,
    eventToCombo,
    displayCombo,
} from '../keybinds'
import { isElectron } from '../electron'
import { isDesktop, desktop } from '../desktop'
import { scope, setScope, overriddenKeys, resetOverride, appearanceIsGlobal, OVERRIDE_BUCKETS } from '../appearance'
import { useUI } from '../ui'
import { useAuth } from '../auth'
import { currentNotes, releaseHistory } from '../releaseNotes'
import { viewportWidth } from '../viewport'
import { FormField } from './FormField'

interface SettingsModalProps {
    onClose: () => void
    myPermissions: number
    // Archives for the per-archive theme assignment UI.
    archives: { id: string; name: string }[]
}

type SettingsTab = 'account' | 'general' | 'appearance' | 'tags' | 'keybinds' | 'server' | 'backups' | 'about'

// The panel used to be a flat max-w-3xl, and a user with both admin tabs ends
// up with eight tabs, which is wider than 768px. That turned the tab row into a
// horizontal scroller, hiding whole tabs behind a drag. The panel is sized from
// the row instead, with 3xl left as a floor.
//
// There is no fixed ceiling. Every tab is laid out in rem, so the row's width
// moves with the UI Scale pref and with the desktop app's interface font, and
// any number chosen here would be too small for somebody. The window is the
// only honest limit, and the panel never asks for more than the tabs need.
const PANEL_MIN_WIDTH = 768

// Keeps the panel off the window edges once it is wider than the floor.
const PANEL_GUTTER = 32

// The panel's own border, inside its width. Tailwind's border is a fixed 1px,
// so unlike the tab strip's padding this one does not move with the UI scale.
const PANEL_BORDER = 2

const ROW_COUNTS = Array.from({ length: ROW_LIMITS.max - ROW_LIMITS.min + 1 }, (_, i) => ROW_LIMITS.min + i)

// The row-count strip, shared by every "how many sit side by side" pref.
//
// It sits on its own line and right-aligned: the description above it is inline
// text, and an inline-flex group flows onto the end of that text rather than
// breaking, which had it crowding the sentence it belongs to. `noun` names what
// is being counted, because a button labelled "2" says nothing on its own.
const RowCountPicker: Component<{ value: number; noun: string; testid: string; onPick: (n: number) => void }> = (
    props,
) => (
    <div class="mt-2 flex justify-end">
        <div class="border-element-accent inline-flex overflow-hidden rounded-md border" data-testid={props.testid}>
            <For each={ROW_COUNTS}>
                {(n, i) => (
                    <button
                        onClick={() => props.onPick(n)}
                        aria-label={`${n} ${props.noun} per row`}
                        class={`px-3 py-1.5 text-xs transition-colors hover:cursor-pointer ${i() > 0 ? 'border-element-accent border-l' : ''} ${
                            props.value === n
                                ? 'bg-highlight-strongest text-white font-semibold'
                                : 'text-sub hover:bg-element-accent hover:text-main'
                        }`}
                    >
                        {n}
                    </button>
                )}
            </For>
        </div>
    </div>
)

const BASE_TABS: { id: SettingsTab; label: string; icon: string }[] = [
    // General stays first so Settings still opens where it always did, rather
    // than greeting everyone with a password form.
    { id: 'general', label: 'General', icon: 'tune' },
    { id: 'account', label: 'Account', icon: 'person' },
    { id: 'appearance', label: 'Appearance', icon: 'palette' },
    { id: 'tags', label: 'Tags', icon: 'sell' },
    { id: 'keybinds', label: 'Keybinds', icon: 'keyboard' },
]

export const SettingsModal: Component<SettingsModalProps> = (props) => {
    const [tab, setTab] = createSignal<SettingsTab>('general')

    // Admin tabs are shown only to users with the relevant permission.
    const tabs = () => {
        const tabs = [...BASE_TABS]
        if (hasPermission(props.myPermissions, PERM.MANAGE_SERVER))
            tabs.push({ id: 'server', label: 'Server', icon: 'monitoring' })
        if (hasPermission(props.myPermissions, PERM.MANAGE_BACKUPS))
            tabs.push({ id: 'backups', label: 'Backups', icon: 'backup' })
        tabs.push({ id: 'about', label: 'About', icon: 'info' })
        return tabs
    }

    let tabRow: HTMLDivElement | undefined
    const [neededWidth, setNeededWidth] = createSignal(PANEL_MIN_WIDTH)

    onMount(() => {
        if (!tabRow || typeof ResizeObserver === 'undefined') return
        // The row is w-max, so its box is the width the tabs want rather than
        // the width the panel currently gives them. Observed rather than
        // measured once, because the icon font arrives after first paint, the
        // admin tabs appear only once permissions are known, and the UI Scale
        // pref resizes every tab under it while the panel is open. The strip's
        // padding is read each time for that last reason: it is rem, so it
        // scales too.
        const measure = () => {
            const strip = getComputedStyle(tabRow!.parentElement!)
            const padding = parseFloat(strip.paddingLeft) + parseFloat(strip.paddingRight)
            setNeededWidth(Math.ceil(tabRow!.getBoundingClientRect().width + padding) + PANEL_BORDER)
        }
        const observer = new ResizeObserver(measure)
        observer.observe(tabRow)
        onCleanup(() => observer.disconnect())
    })

    const panelWidth = () =>
        Math.max(PANEL_MIN_WIDTH, Math.min(neededWidth(), viewportWidth() - PANEL_GUTTER))

    return (
        <div
            class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in"
            {...backdropDismiss(props.onClose)}
        >
            <div
                class="bg-element-matte border-element-accent flex h-[85vh] w-full flex-col rounded-lg border shadow-2xl overflow-hidden"
                style={{ 'max-width': `${panelWidth()}px` }}
            >
                {/* Header */}
                <div class="bg-element border-element-accent flex items-center justify-between rounded-t-lg border-b p-4">
                    <div class="flex items-center gap-2">
                        <span class="material-symbols-outlined text-highlight text-xl">settings</span>
                        <h2 class="text-main font-serif text-lg font-semibold">Settings</h2>
                    </div>
                    <button onClick={props.onClose} class="text-sub hover:text-plain transition-colors">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>

                {/* Tabs */}
                <div class="bg-element border-element-accent border-b p-2 overflow-x-auto" data-testid="settings-tabs">
                    <div ref={tabRow} class="flex w-max gap-1">
                        <For each={tabs()}>
                            {(t) => (
                                <button
                                    onClick={() => setTab(t.id)}
                                    class={`flex items-center gap-1.5 rounded-md px-3 py-2 font-serif text-sm transition-colors ${
                                        tab() === t.id
                                            ? 'bg-highlight-strongest text-white'
                                            : 'text-sub hover:bg-element-accent hover:text-main'
                                    }`}
                                >
                                    <span class="material-symbols-outlined text-base">{t.icon}</span>
                                    {t.label}
                                </button>
                            )}
                        </For>
                    </div>
                </div>

                {/* Body */}
                <div class="flex-1 overflow-y-auto p-6">
                    <Show when={tab() === 'account'}>
                        <AccountTab />
                    </Show>
                    <Show when={tab() === 'general'}>
                        <GeneralTab />
                    </Show>
                    <Show when={tab() === 'appearance'}>
                        <AppearanceTab archives={props.archives} />
                    </Show>
                    <Show when={tab() === 'tags'}>
                        <TagsTab canManageTags={hasPermission(props.myPermissions, PERM.MANAGE_TAGS)} />
                    </Show>
                    <Show when={tab() === 'keybinds'}>
                        <KeybindsTab />
                    </Show>
                    <Show when={tab() === 'server'}>
                        <ServerTab />
                    </Show>
                    <Show when={tab() === 'backups'}>
                        <BackupsTab />
                    </Show>
                    <Show when={tab() === 'about'}>
                        <AboutTab />
                    </Show>
                </div>
            </div>
        </div>
    )
}

// --- Account tab: your own username and password ---
//
// The only settings tab that writes to the server rather than localStorage.
// Username and password share one form because they share one gate: the
// server re-checks your current password for either change, so splitting them
// into two forms would just mean typing it twice.
//
// The two fields are independent: fill in either, or both. That is also why
// the request sends only the fields that changed: an empty "new password" box
// means "leave it alone", not "set it to empty".

const AccountTab: Component = () => {
    const auth = useAuth()
    const ui = useUI()

    const [username, setUsername] = createSignal(auth.user()?.username ?? '')
    const [currentPassword, setCurrentPassword] = createSignal('')
    const [newPassword, setNewPassword] = createSignal('')
    const [confirmPassword, setConfirmPassword] = createSignal('')
    const [saving, setSaving] = createSignal(false)
    const [error, setError] = createSignal('')

    const nameChanged = () => username().trim() !== (auth.user()?.username ?? '')
    const wantsNewPassword = () => newPassword() !== ''
    const hasChanges = () => nameChanged() || wantsNewPassword()

    const clearPasswords = () => {
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
    }

    const save = async (e: Event) => {
        e.preventDefault()
        setError('')
        if (!hasChanges()) return
        if (wantsNewPassword() && newPassword() !== confirmPassword()) {
            setError('The new passwords do not match.')
            return
        }
        if (wantsNewPassword() && newPassword().length < 6) {
            setError('Your new password must be at least 6 characters.')
            return
        }
        if (!currentPassword()) {
            setError('Enter your current password to confirm the change.')
            return
        }

        setSaving(true)
        try {
            await api.updateMe({
                ...(nameChanged() ? { username: username().trim() } : {}),
                ...(wantsNewPassword() ? { new_password: newPassword() } : {}),
                current_password: currentPassword(),
            })
            // Re-read rather than patching the local user: the server is the
            // authority on what the username ended up as (it trims).
            await auth.refresh()
            setUsername(auth.user()?.username ?? username().trim())
            clearPasswords()
            ui.toast(
                wantsNewPassword()
                    ? 'Account updated. Other devices have been signed out.'
                    : 'Account updated.',
                'success',
            )
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save your changes.')
        } finally {
            setSaving(false)
        }
    }

    return (
        <form onSubmit={save} class="space-y-6">
            <section>
                <h3 class="text-main font-serif text-base font-semibold mb-2">Your account</h3>
                <p class="text-sub text-xs mb-3">
                    Your username is what you sign in with and what other members see on your moments and messages.
                </p>
                <div class="bg-element border-element-accent space-y-4 rounded-lg border p-4">
                    <FormField label="Username" type="text" value={username()} onInput={setUsername} />

                    <div class="border-element-accent border-t pt-4">
                        <p class="text-main mb-1 text-sm font-bold">Change password</p>
                        <p class="text-sub mb-3 text-xs">
                            Leave these blank to keep your current password. Changing it signs you out everywhere
                            else.
                        </p>
                        <div class="space-y-3">
                            <FormField
                                label="New password"
                                type="password"
                                value={newPassword()}
                                onInput={setNewPassword}
                                placeholder="At least 6 characters"
                            />
                            <FormField
                                label="Confirm new password"
                                type="password"
                                value={confirmPassword()}
                                onInput={setConfirmPassword}
                            />
                        </div>
                    </div>

                    <div class="border-element-accent border-t pt-4">
                        <FormField
                            label="Current password"
                            type="password"
                            value={currentPassword()}
                            onInput={setCurrentPassword}
                            hint="required to save either change"
                        />
                    </div>

                    <Show when={error()}>
                        <p class="text-danger text-xs">{error()}</p>
                    </Show>

                    <div class="flex items-center gap-3">
                        <button
                            type="submit"
                            disabled={!hasChanges() || saving()}
                            class="bg-highlight-strongest rounded-lg px-4 py-2 text-sm font-bold text-white transition-all hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {saving() ? 'Saving…' : 'Save changes'}
                        </button>
                        <Show when={hasChanges()}>
                            <button
                                type="button"
                                onClick={() => {
                                    setUsername(auth.user()?.username ?? '')
                                    clearPasswords()
                                    setError('')
                                }}
                                class="text-sub hover:text-main text-sm transition-colors hover:cursor-pointer"
                            >
                                Discard
                            </button>
                        </Show>
                    </div>
                </div>
            </section>
        </form>
    )
}

// --- General tab: client-local prefs ---

const GeneralTab: Component = () => {
    const ui = useUI()

    const resetAll = async () => {
        const ok = await ui.confirm({
            title: 'Reset all settings?',
            message:
                'This clears UI scale, font, animation, keybinds and tag-highlight preferences back to their defaults. Your custom themes are kept.',
            confirmLabel: 'Reset',
            danger: true,
        })
        if (!ok) return
        resetPrefs()
        resetKeybinds()
        ui.toast('Settings reset to defaults.', 'success')
    }

    return (
        <div class="space-y-6">
            <section>
                <h3 class="text-main font-serif text-base font-semibold mb-3">Interface</h3>
                <div class="space-y-4">
                    {/* UI scale */}
                    <div class="bg-element border-element-accent rounded-lg border p-4">
                        <div class="flex items-center justify-between mb-2">
                            <span class="text-main text-sm font-bold">UI Scale</span>
                            <span class="text-sub text-sm font-mono">{Math.round(prefs().uiScale * 100)}%</span>
                        </div>
                        <input
                            type="range"
                            min="0.8"
                            max="1.4"
                            step="0.05"
                            value={prefs().uiScale}
                            onInput={(e) => setPref('uiScale', parseFloat(e.currentTarget.value))}
                            class="accent-highlight-strongest w-full cursor-pointer"
                        />
                        <p class="text-sub text-xs mt-1">Scales the whole interface. Applied instantly.</p>
                    </div>

                    {/* Highlight selected tags */}
                    <label class="bg-element border-element-accent flex items-center justify-between gap-3 rounded-lg border p-4 cursor-pointer">
                        <div>
                            <span class="text-main text-sm font-bold block">Highlight Selected Tags in Moments</span>
                            <span class="text-sub text-xs">Emphasise filtered tags where they appear on moment cards.</span>
                        </div>
                        <input
                            type="checkbox"
                            checked={prefs().highlightSelectedTags}
                            onChange={(e) => setPref('highlightSelectedTags', e.currentTarget.checked)}
                            class="accent-highlight-strongest h-5 w-5 cursor-pointer"
                        />
                    </label>

                    {/* Inline link previews. The row-width control only means
                        anything once the toggle is on, so it stays hidden until
                        then rather than sitting there inert. */}
                    <div class="bg-element border-element-accent rounded-lg border p-4">
                        <label class="flex items-center justify-between gap-3 cursor-pointer">
                            <div>
                                <span class="text-main text-sm font-bold block">Inline Link Previews</span>
                                <span class="text-sub text-xs">
                                    Show a link's preview card where the link is, instead of stacking every card at
                                    the end of the moment.
                                </span>
                            </div>
                            <input
                                type="checkbox"
                                checked={prefs().inlineLinkPreviews}
                                onChange={(e) => setPref('inlineLinkPreviews', e.currentTarget.checked)}
                                class="accent-highlight-strongest h-5 w-5 cursor-pointer"
                            />
                        </label>
                        <Show when={prefs().inlineLinkPreviews}>
                            <div class="border-element-accent mt-3 border-t pt-3">
                                <span class="text-main text-sm font-bold block">Cards Per Row</span>
                                <span class="text-sub text-xs">
                                    How many previews sit side by side when links are written back to back.
                                </span>
                                <RowCountPicker
                                    value={prefs().inlineLinkPreviewsPerRow}
                                    noun="cards"
                                    testid="link-previews-per-row"
                                    onPick={(n) => setPref('inlineLinkPreviewsPerRow', n)}
                                />
                            </div>
                        </Show>
                    </div>

                    {/* Videos per row. No toggle above it: 1 is the full-width
                        player this has always been, so the control is its own
                        off switch. */}
                    <div class="bg-element border-element-accent rounded-lg border p-4">
                        <span class="text-main text-sm font-bold block">Videos Per Row</span>
                        <span class="text-sub text-xs">
                            How many uploaded videos sit side by side when they are attached back to back. One gives
                            each its own full-width player.
                        </span>
                        <RowCountPicker
                            value={prefs().videosPerRow}
                            noun="videos"
                            testid="videos-per-row"
                            onPick={(n) => setPref('videosPerRow', n)}
                        />
                    </div>

                    {/* Time format: pins the clock used for every rendered time. */}
                    <div class="bg-element border-element-accent rounded-lg border p-4">
                        <div class="mb-2">
                            <span class="text-main text-sm font-bold block">Time Format</span>
                            <span class="text-sub text-xs">How times are shown across chat, the audit log and moment timestamps.</span>
                        </div>
                        <div class="border-element-accent inline-flex overflow-hidden rounded-md border">
                            <For
                                each={[
                                    { id: '12h' as const, label: '12-hour' },
                                    { id: '24h' as const, label: '24-hour' },
                                    { id: 'system' as const, label: 'Follow system' },
                                ]}
                            >
                                {(opt, i) => (
                                    <button
                                        onClick={() => setPref('timeFormat', opt.id)}
                                        class={`px-3 py-1.5 text-xs transition-colors hover:cursor-pointer ${i() > 0 ? 'border-element-accent border-l' : ''} ${
                                            prefs().timeFormat === opt.id
                                                ? 'bg-highlight-strongest text-white font-semibold'
                                                : 'text-sub hover:bg-element-accent hover:text-main'
                                        }`}
                                    >
                                        {opt.label}
                                    </button>
                                )}
                            </For>
                        </div>
                    </div>
                </div>
            </section>

            {/* Desktop-only settings. In the Electron shell these render the real
                controls (over the reserved prefs plumbing); in a browser they
                collapse to a hint so the client split stays discoverable. */}
            <Show
                when={isDesktop}
                fallback={
                    <Show when={!isElectron}>
                        <section>
                            <h3 class="text-main font-serif text-base font-semibold mb-2">Desktop Client</h3>
                            <p class="text-sub text-xs leading-relaxed">
                                Font selection, animation controls, multi-server and update checks live in the Athena
                                desktop app. The web client keeps the essentials.
                            </p>
                        </section>
                    </Show>
                }
            >
                <DesktopSettings />
            </Show>

            <section>
                <h3 class="text-main font-serif text-base font-semibold mb-2">Reset</h3>
                <button
                    onClick={resetAll}
                    class="border-danger text-danger hover:bg-danger flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-bold transition-colors hover:text-white hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-base">restart_alt</span>
                    Reset All Settings
                </button>
                <p class="text-sub text-xs mt-1">Custom themes are preserved.</p>
            </section>
        </div>
    )
}

// --- Desktop client settings (Electron only, over prefs.ts plumbing) ---
// Animation + update check. Font selection lives in the Appearance tab (see
// FontSection below). Depends on the shell's read-only bridge
// (window.athenaDesktop); rendered only when isDesktop.

const DesktopSettings: Component = () => {
    const ui = useUI()
    const [version, setVersion] = createSignal('')
    const [checking, setChecking] = createSignal(false)
    const [reloading, setReloading] = createSignal(false)

    onMount(async () => {
        const bridge = desktop()
        if (!bridge) return
        try {
            setVersion(await bridge.appVersion())
        } catch {
            /* version is best-effort */
        }
    })

    const checkForUpdates = async () => {
        const bridge = desktop()
        if (!bridge) return
        setChecking(true)
        try {
            // The bridge now resolves only once the updater reaches a verdict,
            // so this toast reports the result rather than the fact a check
            // started. The button stays disabled for the duration.
            const res = await bridge.checkForUpdates()
            ui.toast(res.message || 'Update check finished with no result.', res.status === 'error' ? 'error' : 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Update check failed', 'error')
        } finally {
            setChecking(false)
        }
    }

    // Distinct from checkForUpdates above: that updates the Electron app
    // itself, this refreshes the *current library's* cached content (for
    // when a new server build hasn't propagated to this session yet).
    const reloadContent = async () => {
        const bridge = desktop()
        if (!bridge?.reloadContent) return
        setReloading(true)
        try {
            // On success this navigates the content view away (reloading the
            // very page this modal is rendered in), so there's nothing left
            // to show a success toast in. Only the failure path needs one.
            await bridge.reloadContent()
        } catch (err: any) {
            ui.toast(err.message || 'Reload failed', 'error')
        } finally {
            setReloading(false)
        }
    }

    return (
        <section>
            <h3 class="text-main font-serif text-base font-semibold mb-3">Desktop Client</h3>
            <div class="space-y-4">
                {/* Animations on/off */}
                <label class="bg-element border-element-accent flex items-center justify-between gap-3 rounded-lg border p-4 cursor-pointer">
                    <div>
                        <span class="text-main text-sm font-bold block">Animations</span>
                        <span class="text-sub text-xs">Enable interface motion and transitions.</span>
                    </div>
                    <input
                        type="checkbox"
                        checked={prefs().animationsEnabled}
                        onChange={(e) => setPref('animationsEnabled', e.currentTarget.checked)}
                        class="accent-highlight-strongest h-5 w-5 cursor-pointer"
                    />
                </label>

                {/* Animation speed */}
                <div
                    class="bg-element border-element-accent rounded-lg border p-4"
                    classList={{ 'opacity-50': !prefs().animationsEnabled }}
                >
                    <div class="flex items-center justify-between mb-2">
                        <span class="text-main text-sm font-bold">Animation Speed</span>
                        <span class="text-sub text-sm font-mono">{prefs().animationSpeed.toFixed(1)}×</span>
                    </div>
                    <input
                        type="range"
                        min="0.5"
                        max="2"
                        step="0.1"
                        value={prefs().animationSpeed}
                        disabled={!prefs().animationsEnabled}
                        onInput={(e) => setPref('animationSpeed', parseFloat(e.currentTarget.value))}
                        class="accent-highlight-strongest w-full cursor-pointer"
                    />
                    <div class="text-sub flex justify-between text-xs mt-1">
                        <span>Faster</span>
                        <span>Slower</span>
                    </div>
                </div>

                {/* Update check */}
                <div class="bg-element border-element-accent flex items-center justify-between gap-3 rounded-lg border p-4">
                    <div>
                        <span class="text-main text-sm font-bold block">Updates</span>
                        <span class="text-sub text-xs">
                            {version() ? `Athena desktop v${version()}` : 'Athena desktop'}
                        </span>
                    </div>
                    <button
                        onClick={checkForUpdates}
                        disabled={checking()}
                        class="bg-highlight-strongest flex items-center gap-1 rounded-lg px-3 py-2 text-xs font-bold text-white transition-[filter] hover:brightness-110 disabled:opacity-50 hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined text-sm">system_update_alt</span>
                        {checking() ? 'Checking…' : 'Check for updates'}
                    </button>
                </div>

                {/* Reload the active library's content, distinct from the app
                    update above; this refreshes cached PWA content instead of
                    the desktop app binary. */}
                <div class="bg-element border-element-accent flex items-center justify-between gap-3 rounded-lg border p-4">
                    <div>
                        <span class="text-main text-sm font-bold block">Library content</span>
                        <span class="text-sub text-xs">Force-refresh this library if it seems out of date.</span>
                    </div>
                    <button
                        onClick={reloadContent}
                        disabled={reloading()}
                        class="border-element-accent text-sub hover:border-highlight hover:text-main flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-bold transition-colors disabled:opacity-50 hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined text-sm">refresh</span>
                        {reloading() ? 'Reloading…' : 'Reload'}
                    </button>
                </div>
            </div>
        </section>
    )
}

// --- Appearance tab: looks ---
//
// A "look" is a visual language (surface/typography/border treatment) layered
// on top of the colour theme. Five presets ship; users can build their own,
// stored in localStorage like custom themes.

const LooksSection: Component = () => {
    const [active, setActive] = createSignal(getActiveLook())
    const [userLooks, setUserLooks] = createSignal<UserLook[]>(loadUserLooks())
    const [editing, setEditing] = createSignal(false)
    const [name, setName] = createSignal('My look')
    const [vars, setVars] = createSignal<LookVars>({ ...DEFAULT_LOOK_VARS })

    const refresh = () => setUserLooks(loadUserLooks())
    const select = (id: string) => {
        setActiveLook(id)
        setActive(id)
    }
    const patch = <K extends keyof LookVars>(k: K, v: LookVars[K]) => setVars((prev) => ({ ...prev, [k]: v }))

    const saveNew = () => {
        const look = createUserLook(name().trim() || 'My look', vars())
        refresh()
        setEditing(false)
        select(look.id)
    }
    const remove = (id: string) => {
        deleteUserLook(id)
        refresh()
        setActive(getActiveLook())
    }

    return (
        <section>
            <h3 class="text-main font-serif text-base font-semibold mb-2">Look</h3>
            <p class="text-sub text-xs mb-3">A visual language layered on top of the colour theme. Composes with every theme.</p>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <For each={PRESET_LOOKS}>
                    {(look) => (
                        <button
                            onClick={() => select(look.id)}
                            class={`rounded-xl border-2 p-3 text-left transition-all hover:cursor-pointer ${
                                active() === look.id ? 'border-highlight bg-element-accent' : 'border-element-accent hover:border-highlight'
                            }`}
                        >
                            <span class="text-main block text-xs font-black">{look.name}</span>
                            <span class="text-sub block text-[10px] leading-tight mt-0.5">{look.blurb}</span>
                        </button>
                    )}
                </For>
                <For each={userLooks()}>
                    {(look) => (
                        <div class="relative">
                            <button
                                onClick={() => select(look.id)}
                                class={`w-full rounded-xl border-2 p-3 text-left transition-all hover:cursor-pointer ${
                                    active() === look.id ? 'border-highlight bg-element-accent' : 'border-element-accent hover:border-highlight'
                                }`}
                            >
                                <span class="text-main block truncate text-xs font-black">{look.name}</span>
                                <span class="text-sub block text-[10px]">Custom look</span>
                            </button>
                            <button onClick={() => remove(look.id)} title="Delete" class="text-sub hover:text-danger absolute right-1 top-1">
                                <span class="material-symbols-outlined text-sm">delete</span>
                            </button>
                        </div>
                    )}
                </For>
            </div>

            <Show
                when={editing()}
                fallback={
                    <button
                        onClick={() => {
                            setVars({ ...DEFAULT_LOOK_VARS })
                            setName('My look')
                            setEditing(true)
                        }}
                        class="border-element-accent text-sub hover:border-highlight hover:text-highlight-strongest mt-3 flex items-center gap-1 rounded-xl border-2 border-dashed px-3 py-2 text-xs font-bold uppercase tracking-wide transition-all"
                    >
                        <span class="material-symbols-outlined text-sm">add</span>
                        New look
                    </button>
                }
            >
                <div class="border-element-accent mt-3 flex flex-col gap-3 rounded-xl border p-4">
                    <input
                        value={name()}
                        onInput={(e) => setName(e.currentTarget.value)}
                        placeholder="Look name"
                        class="bg-element text-main border-element-accent focus:border-highlight rounded-md border px-3 py-2 text-sm focus:outline-none"
                    />
                    <label class="text-sub flex items-center justify-between gap-2 text-xs">
                        Corner radius
                        <input type="range" min="0" max="24" value={parseFloat(vars().radius) * 16} onInput={(e) => patch('radius', `${Number(e.currentTarget.value) / 16}rem`)} />
                    </label>
                    <label class="text-sub flex items-center justify-between gap-2 text-xs">
                        Surface opacity
                        <input type="range" min="40" max="100" value={vars().surfaceOpacity * 100} onInput={(e) => patch('surfaceOpacity', Number(e.currentTarget.value) / 100)} />
                    </label>
                    <label class="text-sub flex items-center justify-between gap-2 text-xs">
                        Backdrop blur
                        <input type="range" min="0" max="24" value={parseFloat(vars().blur)} onInput={(e) => patch('blur', `${e.currentTarget.value}px`)} />
                    </label>
                    <label class="text-sub flex items-center justify-between gap-2 text-xs">
                        Body font
                        <select value={vars().bodyFont} onChange={(e) => patch('bodyFont', e.currentTarget.value as LookVars['bodyFont'])} class="bg-element text-main border-element-accent rounded border px-2 py-1">
                            <option value="sans">Sans</option>
                            <option value="serif">Serif</option>
                            <option value="mono">Mono</option>
                        </select>
                    </label>
                    <label class="text-sub flex items-center justify-between gap-2 text-xs">
                        Shadow
                        <select value={vars().shadow} onChange={(e) => patch('shadow', e.currentTarget.value as LookVars['shadow'])} class="bg-element text-main border-element-accent rounded border px-2 py-1">
                            <option value="none">None</option>
                            <option value="soft">Soft</option>
                            <option value="strong">Strong</option>
                        </select>
                    </label>
                    <label class="text-sub flex items-center justify-between gap-2 text-xs">
                        Borders
                        <select value={vars().borderWidth} onChange={(e) => patch('borderWidth', e.currentTarget.value)} class="bg-element text-main border-element-accent rounded border px-2 py-1">
                            <option value="1px">On</option>
                            <option value="0px">Off</option>
                        </select>
                    </label>
                    <div class="flex justify-end gap-2">
                        <button onClick={() => setEditing(false)} class="text-sub hover:text-main px-2 text-xs font-bold">Cancel</button>
                        <button onClick={saveNew} class="bg-highlight-strongest rounded-md px-4 py-1.5 text-xs font-bold text-white">Save look</button>
                    </div>
                </div>
            </Show>
        </section>
    )
}

// --- Appearance tab: layout ---

const LayoutSection: Component = () => {
    const options: { id: 'standard' | 'focus'; label: string; blurb: string; icon: string }[] = [
        { id: 'standard', label: 'Standard', blurb: 'Archives · Feed · Menu, three columns', icon: 'view_column' },
        { id: 'focus', label: 'Focus', blurb: 'One centred writing column; panels in drawers', icon: 'crop_portrait' },
    ]
    return (
        <section>
            <h3 class="text-main font-serif text-base font-semibold mb-2">Layout</h3>
            <p class="text-sub text-xs mb-3">How the main screen is arranged. The list/grid feed toggle works in either.</p>
            <div class="grid grid-cols-2 gap-2">
                <For each={options}>
                    {(o) => (
                        <button
                            onClick={() => setPref('layout', o.id)}
                            class={`flex items-start gap-2 rounded-xl border-2 p-3 text-left transition-all hover:cursor-pointer ${
                                prefs().layout === o.id ? 'border-highlight bg-element-accent' : 'border-element-accent hover:border-highlight'
                            }`}
                        >
                            <span class="material-symbols-outlined text-highlight">{o.icon}</span>
                            <span>
                                <span class="text-main block text-xs font-black">{o.label}</span>
                                <span class="text-sub block text-[10px] leading-tight mt-0.5">{o.blurb}</span>
                            </span>
                        </button>
                    )}
                </For>
            </div>

            {/* Moments column width (Standard layout), also draggable via the divider. */}
            <Show when={prefs().layout === 'standard'}>
                <div class="mt-3 flex items-center justify-between gap-3 text-xs">
                    <span class="text-sub font-bold">Moments column width: {prefs().feedWidth}px</span>
                    <div class="flex items-center gap-2">
                        <input
                            type="range"
                            min="560"
                            max="1440"
                            step="16"
                            value={prefs().feedWidth}
                            onInput={(e) => setPref('feedWidth', Number(e.currentTarget.value))}
                            class="w-40"
                        />
                        <button
                            onClick={() => setPref('feedWidth', DEFAULT_PREFS.feedWidth)}
                            disabled={prefs().feedWidth === DEFAULT_PREFS.feedWidth}
                            title="Reset to the default width"
                            class="border-element-accent text-sub hover:text-main rounded-md border px-2 py-1 transition-colors hover:cursor-pointer disabled:opacity-40 disabled:hover:cursor-default"
                        >
                            Reset
                        </button>
                    </div>
                </div>
            </Show>
        </section>
    )
}

// --- Appearance tab: Libraries placement (desktop only) ---

const LibrariesSection: Component = () => {
    const options: { id: 'inline-above' | 'inline-below' | 'left-rail'; label: string; blurb: string }[] = [
        { id: 'inline-above', label: 'Inline · above', blurb: 'A panel above Archives' },
        { id: 'inline-below', label: 'Inline · below', blurb: 'A panel below Archives' },
        { id: 'left-rail', label: 'Shelf', blurb: 'The full-height shelf on the far left' },
    ]
    return (
        <section>
            <h3 class="text-main font-serif text-base font-semibold mb-2">Libraries</h3>
            <p class="text-sub text-xs mb-3">Where the in-app library (server) switcher appears. Only shown when you have more than one library. Opening the desktop window's own library sidebar (from the switcher's manage button, or Ctrl/Cmd+Shift+S) replaces this switcher while it's up, so you never see both at once.</p>
            <div class="grid grid-cols-3 gap-2">
                <For each={options}>
                    {(o) => (
                        <button
                            onClick={() => setPref('librariesPlacement', o.id)}
                            class={`rounded-xl border-2 p-3 text-left transition-all hover:cursor-pointer ${
                                prefs().librariesPlacement === o.id ? 'border-highlight bg-element-accent' : 'border-element-accent hover:border-highlight'
                            }`}
                        >
                            <span class="text-main block text-xs font-black">{o.label}</span>
                            <span class="text-sub block text-[10px] leading-tight mt-0.5">{o.blurb}</span>
                        </button>
                    )}
                </For>
            </div>
            <Show when={prefs().librariesPlacement === 'left-rail'}>
                <label class="bg-element border-element-accent mt-3 flex items-center justify-between gap-3 rounded-lg border p-4 cursor-pointer">
                    <div>
                        <span class="text-main text-sm font-bold block">Compact shelf</span>
                        <span class="text-sub text-xs">Size the libraries shelf to fit your libraries instead of always stretching to fill the column.</span>
                    </div>
                    <input
                        type="checkbox"
                        checked={prefs().librariesCompact}
                        onChange={(e) => setPref('librariesCompact', e.currentTarget.checked)}
                        class="accent-highlight-strongest h-5 w-5 cursor-pointer"
                    />
                </label>
            </Show>
        </section>
    )
}

// --- Appearance tab: top bar ---

const TopbarSection: Component = () => (
    <section>
        <h3 class="text-main font-serif text-base font-semibold mb-2">Top bar</h3>
        <label class="bg-element border-element-accent flex items-center justify-between gap-3 rounded-lg border p-4 cursor-pointer">
            <div>
                <span class="text-main text-sm font-bold block">Show logo in title bar</span>
                <span class="text-sub text-xs">The bold “Athena v{__APP_VERSION__}” title always shows; this toggles the icon beside it.</span>
            </div>
            <input
                type="checkbox"
                checked={prefs().showTopbarLogo}
                onChange={(e) => setPref('showTopbarLogo', e.currentTarget.checked)}
                class="accent-highlight-strongest h-5 w-5 cursor-pointer"
            />
        </label>
    </section>
)

// --- Appearance tab: font ---
//
// Two sources, and they answer different questions. The look fonts are the
// typography each preset look ships with, offered on their own so a look's
// face can be used without its look. Legacy's Inter on Editorial, which is
// otherwise not expressible: choosing a look took its font with it.
//
// The installed-font list needs the OS, which only the desktop shell can
// reach, so in a browser that group is simply absent. The section itself is
// not desktop-only any more: the look fonts work everywhere.

const FontSection: Component = () => {
    const [systemFonts, setSystemFonts] = createSignal<string[]>([])

    onMount(async () => {
        const bridge = desktop()
        if (!bridge) return
        try {
            setSystemFonts(await bridge.listSystemFonts())
        } catch {
            /* font enumeration is best-effort */
        }
    })

    return (
        <section>
            <h3 class="text-main font-serif text-base font-semibold mb-2">Font</h3>
            <div class="bg-element border-element-accent rounded-lg border p-4">
                <label for="settings-interface-font" class="text-main text-sm font-bold block mb-2">
                    Interface Font
                </label>
                <select
                    id="settings-interface-font"
                    value={prefs().font}
                    onChange={(e) => setPref('font', e.currentTarget.value)}
                    class="bg-element-matte text-main border-element-accent w-full rounded-md border px-3 py-2 text-sm focus:border-highlight focus:outline-none"
                >
                    <option value="">Follow the look</option>
                    <optgroup label="Look fonts">
                        <For each={LOOK_FONTS}>{(f) => <option value={f.stack}>{f.label}</option>}</For>
                    </optgroup>
                    <Show when={systemFonts().length > 0}>
                        <optgroup label="Installed fonts">
                            <For each={systemFonts()}>{(f) => <option value={f}>{f}</option>}</For>
                        </optgroup>
                    </Show>
                </select>
                <p class="text-sub text-xs mt-1">
                    Applies to interface and body text; the serif brand headings are unchanged. A look font can be
                    used with any look. Pick Legacy's face on Editorial, say.
                    <Show when={systemFonts().length === 0}>
                        {' '}
                        Installed system fonts are listed in the desktop app.
                    </Show>
                </p>
                {/* Live sample, since a font list you can't see is a guess. */}
                <p
                    class="text-main border-element-accent mt-3 rounded-md border p-3 text-sm"
                    style={{ 'font-family': prefs().font || 'var(--look-body-font)' }}
                >
                    The quick brown fox jumps over the lazy dog. 0123456789
                </p>
            </div>
        </section>
    )
}

// --- Appearance tab: Menu column (§ Menu revamp, desktop only) ---

const MenuSection: Component = () => {
    const layouts: { id: 'rich' | 'minimal'; label: string; blurb: string }[] = [
        { id: 'rich', label: 'Rich', blurb: 'Nav hub + docked chat, members, and widgets' },
        { id: 'minimal', label: 'Minimal', blurb: 'The compact card of buttons + identity' },
    ]

    // Reorder a widget by one step; persists the whole list.
    const move = (index: number, delta: number) => {
        const list = prefs().menuWidgets.slice()
        const target = index + delta
        if (target < 0 || target >= list.length) return
        ;[list[index], list[target]] = [list[target], list[index]]
        setPref('menuWidgets', list)
    }
    const toggle = (id: MenuWidget['id'], enabled: boolean) => {
        setPref(
            'menuWidgets',
            prefs().menuWidgets.map((w) => (w.id === id ? { ...w, enabled } : w)),
        )
    }
    const labelOf = (id: MenuWidget['id']) => MENU_WIDGET_META.find((m) => m.id === id)
    const blurbOf = (id: MenuWidget['id']) => labelOf(id)?.blurb ?? ''

    return (
        <section>
            <h3 class="text-main font-serif text-base font-semibold mb-2">Menu column</h3>
            <p class="text-sub text-xs mb-3">The right-hand column on the Standard desktop layout.</p>
            <div class="grid grid-cols-2 gap-2">
                <For each={layouts}>
                    {(o) => (
                        <button
                            onClick={() => setPref('menuLayout', o.id)}
                            class={`rounded-xl border-2 p-3 text-left transition-all hover:cursor-pointer ${
                                prefs().menuLayout === o.id ? 'border-highlight bg-element-accent' : 'border-element-accent hover:border-highlight'
                            }`}
                        >
                            <span class="text-main block text-xs font-black">{o.label}</span>
                            <span class="text-sub block text-[10px] leading-tight mt-0.5">{o.blurb}</span>
                        </button>
                    )}
                </For>
            </div>

            {/* Widgets: enable + reorder. Only meaningful for the rich layout. */}
            <Show when={prefs().menuLayout === 'rich'}>
                <p class="text-sub text-xs mt-4 mb-2 font-bold uppercase tracking-widest">Widgets</p>
                <p class="text-sub/80 text-[11px] mb-2">Choose what shows in the menu, and set priority with the arrows (top = highest).</p>
                <div class="flex flex-col gap-1.5">
                    <For each={prefs().menuWidgets}>
                        {(w, i) => (
                            <div class="bg-element border-element-accent flex items-center gap-2 rounded-lg border p-2.5">
                                <div class="flex flex-col">
                                    <button
                                        onClick={() => move(i(), -1)}
                                        disabled={i() === 0}
                                        title="Move up"
                                        class="text-sub hover:text-main leading-none transition-colors hover:cursor-pointer disabled:opacity-30 disabled:hover:cursor-default"
                                    >
                                        <span class="material-symbols-outlined text-base">keyboard_arrow_up</span>
                                    </button>
                                    <button
                                        onClick={() => move(i(), 1)}
                                        disabled={i() === prefs().menuWidgets.length - 1}
                                        title="Move down"
                                        class="text-sub hover:text-main leading-none transition-colors hover:cursor-pointer disabled:opacity-30 disabled:hover:cursor-default"
                                    >
                                        <span class="material-symbols-outlined text-base">keyboard_arrow_down</span>
                                    </button>
                                </div>
                                <div class="min-w-0 flex-1">
                                    <span class="text-main block text-xs font-bold">{labelOf(w.id)?.label ?? w.id}</span>
                                    <span class="text-sub block text-[10px] leading-tight">{blurbOf(w.id)}</span>
                                </div>
                                <input
                                    type="checkbox"
                                    checked={w.enabled}
                                    onChange={(e) => toggle(w.id, e.currentTarget.checked)}
                                    class="accent-highlight-strongest h-5 w-5 cursor-pointer"
                                    aria-label={`Enable ${labelOf(w.id)?.label ?? w.id}`}
                                />
                            </div>
                        )}
                    </For>
                </div>

                {/* Chat widget mode: only meaningful when the chat widget is on. */}
                <label class="bg-element border-element-accent mt-3 flex items-center justify-between gap-3 rounded-lg border p-3 cursor-pointer">
                    <div>
                        <span class="text-main text-sm font-bold block">Full chat widget</span>
                        <span class="text-sub text-xs">Dock the full chat with composer so you can send messages directly. Off shows a preview only; click it to open the full chat and reply.</span>
                    </div>
                    <input
                        type="checkbox"
                        checked={prefs().chatWidgetFull}
                        onChange={(e) => setPref('chatWidgetFull', e.currentTarget.checked)}
                        class="accent-highlight-strongest h-5 w-5 shrink-0 cursor-pointer"
                    />
                </label>
            </Show>
        </section>
    )
}

// --- Appearance tab: themes ---

type EditorState = { mode: 'list' } | { mode: 'edit'; theme: UserTheme; isNew: boolean }

// --- Appearance tab: global-vs-per-server scope (ADR-0016, desktop only) ---
//
// Appearance is global across servers by default; this control routes edits to
// either the global default or an override for the active server. Shown only in
// the desktop shell that understands the appearance bridge.
// A divider label above a run of related sections. The Appearance tab is long
// enough that a flat stack of eleven headings gave no sense of what belongs
// with what: the colour theme and the look that composes with it sat five
// sections apart, with layout and font settings between them.
const GroupLabel: Component<{ title: string; blurb: string }> = (props) => (
    <div class="border-element-accent border-b pb-1 pt-2 first:pt-0">
        <h2 class="text-highlight-strong text-[11px] font-bold uppercase tracking-widest">{props.title}</h2>
        <p class="text-sub/70 text-xs">{props.blurb}</p>
    </div>
)

const AppearanceScopeSection: Component = () => {
    const buckets = () => OVERRIDE_BUCKETS.filter((b) => overriddenKeys().includes(b.key))
    return (
        <Show when={appearanceIsGlobal()}>
            <section>
                <h3 class="text-main font-serif text-base font-semibold mb-2">Appearance scope</h3>
                <p class="text-sub text-xs mb-3">
                    Appearance is shared across all your libraries. Edits below apply to the{' '}
                    <b>global default</b>; switch to <b>This library</b> to override just this one.
                </p>
                <div class="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={() => setScope('global')}
                        class="rounded-md border px-3 py-2 text-left text-sm transition-colors"
                        classList={{
                            'border-highlight-strongest bg-highlight-strongest/10 text-main': scope() === 'global',
                            'border-element-accent text-sub hover:border-highlight': scope() !== 'global',
                        }}
                    >
                        <span class="font-bold">Global default</span>
                        <span class="text-sub block text-xs">Applies to every library</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => setScope('server')}
                        class="rounded-md border px-3 py-2 text-left text-sm transition-colors"
                        classList={{
                            'border-highlight-strongest bg-highlight-strongest/10 text-main': scope() === 'server',
                            'border-element-accent text-sub hover:border-highlight': scope() !== 'server',
                        }}
                    >
                        <span class="font-bold">This library</span>
                        <span class="text-sub block text-xs">Override for the active server</span>
                    </button>
                </div>
                <Show when={buckets().length > 0}>
                    <div class="border-element-accent mt-3 rounded-md border p-3">
                        <p class="text-sub mb-2 text-xs font-bold uppercase tracking-widest">Overridden on this library</p>
                        <div class="flex flex-col gap-1.5">
                            <For each={buckets()}>
                                {(b) => (
                                    <div class="flex items-center justify-between gap-2 text-sm">
                                        <span class="text-main">{b.label}</span>
                                        <button
                                            type="button"
                                            onClick={() => void resetOverride(b.key)}
                                            class="text-highlight hover:text-highlight-strongest inline-flex items-center gap-1 text-xs font-bold"
                                        >
                                            <span class="material-symbols-outlined text-sm">undo</span>
                                            Reset to global
                                        </button>
                                    </div>
                                )}
                            </For>
                        </div>
                    </div>
                </Show>
            </section>
        </Show>
    )
}

const AppearanceTab: Component<{ archives: { id: string; name: string }[] }> = (props) => {
    const ui = useUI()
    const [activeTheme, setActive] = createSignal(getActiveTheme())
    const [userThemes, setUserThemes] = createSignal<UserTheme[]>([])
    const [editor, setEditor] = createSignal<EditorState>({ mode: 'list' })
    const [importText, setImportText] = createSignal('')
    // Per-archive theme assignments (advanced). archiveId -> user theme id.
    const [archiveThemes, setArchiveThemes] = createSignal<Record<string, string>>({})
    const refreshArchiveThemes = () => {
        const map: Record<string, string> = {}
        for (const a of props.archives) {
            const archiveTheme = getArchiveTheme(a.id)
            if (archiveTheme) map[a.id] = archiveTheme
        }
        setArchiveThemes(map)
    }
    onMount(refreshArchiveThemes)

    const assignArchiveTheme = (archiveId: string, themeId: string) => {
        setArchiveTheme(archiveId, themeId || null)
        refreshArchiveThemes()
    }

    onMount(() => setUserThemes(loadUserThemes()))
    const refresh = () => setUserThemes(loadUserThemes())

    const selectTheme = (id: string) => {
        setActiveTheme(id)
        setActive(id)
    }

    const startNewTheme = () => {
        const theme: UserTheme = { id: `user-${Date.now()}`, name: 'My Theme', colors: defaultColors() }
        setEditor({ mode: 'edit', theme, isNew: true })
    }

    const saveEdit = () => {
        const state = editor()
        if (state.mode !== 'edit') return
        const { theme, isNew } = state
        if (isNew) createUserTheme(theme.name, theme.colors, theme.scoped)
        else updateUserTheme(theme.id, theme.name, theme.colors, theme.scoped)
        refresh()
        setEditor({ mode: 'list' })
        if (activeTheme() === theme.id) setActiveTheme(theme.id)
    }

    const removeUserTheme = async (id: string) => {
        const ok = await ui.confirm({
            title: 'Delete theme?',
            message: 'This custom theme will be removed from this browser.',
            confirmLabel: 'Delete',
            danger: true,
        })
        if (!ok) return
        deleteUserTheme(id)
        refresh()
        setActive(getActiveTheme())
        ui.toast('Theme deleted.', 'success')
    }

    const doExport = (theme: UserTheme) => {
        const str = encodeTheme(theme)
        navigator.clipboard
            .writeText(str)
            .then(() => ui.toast('Theme copied to clipboard.', 'success'))
            .catch(() => ui.toast('Could not copy. Theme string logged to console.', 'error'))
    }

    const doImport = () => {
        const text = importText().trim()
        if (!text) {
            ui.toast('Paste a theme string first.', 'error')
            return
        }
        const decoded = decodeTheme(text)
        if (!decoded) {
            ui.toast('Invalid theme string.', 'error')
            return
        }
        const added = importTheme(decoded)
        refresh()
        setImportText('')
        ui.toast(`Imported "${added.name}".`, 'success')
    }

    return (
        <Show
            when={editor().mode === 'edit' ? (editor() as Extract<EditorState, { mode: 'edit' }>) : null}
            fallback={
                <div class="space-y-6">
                    <GroupLabel title="Style" blurb="The colour theme, the look layered over it, and the type they are set in." />
                    <section>
                        <h3 class="text-main font-serif text-base font-semibold mb-2">Theme</h3>
                        <p class="text-sub text-xs mb-3">Click a theme to apply it. Custom themes are stored in your browser.</p>
                        <div class="grid grid-cols-3 sm:grid-cols-4 gap-2">
                            <For each={PRESET_THEMES}>
                                {(id) => (
                                    // data-theme scopes the --theme-* CSS vars to just this button (see
                                    // index.css [data-theme='...'] blocks), so the swatch shows that
                                    // preset's own bg/text colours without duplicating them in JS,
                                    // and since every preset already tunes text-main for contrast
                                    // against bg (index.css "Contrast ladder"), it's legible for free.
                                    <button
                                        onClick={() => selectTheme(id)}
                                        data-theme={id}
                                        class={`rounded-xl border-2 p-3 text-xs font-black capitalize transition-all hover:cursor-pointer ${
                                            activeTheme() === id
                                                ? 'border-highlight-strongest ring-2 ring-highlight-strongest'
                                                : 'border-transparent hover:border-highlight-strongest'
                                        }`}
                                        style={{ 'background-color': 'var(--theme-bg)', color: 'var(--theme-text-main)' }}
                                    >
                                        {id}
                                    </button>
                                )}
                            </For>
                            <For each={userThemes()}>
                                {(theme) => (
                                    <div class="relative">
                                        <button
                                            onClick={() => selectTheme(theme.id)}
                                            class={`w-full rounded-xl border-2 p-3 text-xs font-black transition-all hover:cursor-pointer ${
                                                activeTheme() === theme.id
                                                    ? 'border-highlight-strongest ring-2 ring-highlight-strongest'
                                                    : 'border-transparent hover:border-highlight-strongest'
                                            }`}
                                            style={{ 'background-color': theme.colors.bg, color: theme.colors['text-main'] }}
                                        >
                                            <span class="block truncate">{theme.name}</span>
                                        </button>
                                        {/* Swatch bg is theme-defined and unpredictable, so give the
                                            overlaid icons their own opaque chip rather than relying on
                                            text-sub (tuned for the app's active theme) for contrast. */}
                                        <div class="bg-element-matte/90 absolute top-1 right-1 flex gap-0.5 rounded-md px-1 py-0.5 backdrop-blur">
                                            <button onClick={(e) => { e.stopPropagation(); setEditor({ mode: 'edit', theme, isNew: false }) }} title="Edit" class="text-sub hover:text-highlight text-xs">
                                                <span class="material-symbols-outlined text-sm">edit</span>
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); doExport(theme) }} title="Export" class="text-sub hover:text-highlight text-xs">
                                                <span class="material-symbols-outlined text-sm">content_copy</span>
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); removeUserTheme(theme.id) }} title="Delete" class="text-sub hover:text-danger text-xs">
                                                <span class="material-symbols-outlined text-sm">delete</span>
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                        <button
                            onClick={startNewTheme}
                            class="border-element-accent text-sub hover:border-highlight hover:text-highlight-strongest mt-3 flex items-center gap-1 rounded-xl border-2 border-dashed px-3 py-2 text-xs font-bold uppercase tracking-wide transition-all"
                        >
                            <span class="material-symbols-outlined text-sm">add</span>
                            New Theme
                        </button>
                    </section>

                    <section>
                        <h3 class="text-main font-serif text-base font-semibold mb-2">Import Theme</h3>
                        <p class="text-sub text-xs mb-2">Paste a shared theme string to add it to your themes.</p>
                        <div class="flex gap-2">
                            <input
                                type="text"
                                value={importText()}
                                onInput={(e) => setImportText(e.currentTarget.value)}
                                placeholder="athena-theme:..."
                                class="bg-element text-main border-element-accent flex-1 rounded-lg border px-3 py-2 text-xs font-mono focus:outline-none focus:border-highlight"
                            />
                            <button onClick={doImport} class="bg-highlight-strongest text-white rounded-md px-4 py-2 text-xs font-bold transition-[filter] hover:brightness-110">
                                Import
                            </button>
                        </div>
                    </section>

                    {/* Per-archive theme (advanced, 4.6). Client-local; only user
                        themes can be assigned since presets have no colour map. */}
                    <Show when={props.archives.length > 0 && userThemes().length > 0}>
                        <section>
                            <h3 class="text-main font-serif text-base font-semibold mb-2">Per-Archive Theme</h3>
                            <p class="text-sub text-xs mb-3">
                                Give a specific archive its own look. Applies only to the feed while that archive is
                                selected. Stored locally in this browser.
                            </p>
                            <div class="space-y-2">
                                <For each={props.archives}>
                                    {(a) => (
                                        <div class="bg-element border-element-accent flex items-center justify-between gap-2 rounded-lg border p-2">
                                            <span class="text-main truncate text-sm font-bold">{a.name}</span>
                                            <select
                                                value={archiveThemes()[a.id] || ''}
                                                onChange={(e) => assignArchiveTheme(a.id, e.currentTarget.value)}
                                                class="bg-element-matte text-sub border-element-accent rounded-md border px-2 py-1 text-xs focus:outline-none"
                                            >
                                                <option value="">Default</option>
                                                <For each={userThemes()}>
                                                    {(t) => <option value={t.id}>{t.name}</option>}
                                                </For>
                                            </select>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </section>
                    </Show>

                    {/* Look and Font sit directly under Theme: a look composes
                        with whatever theme is active, so choosing one is the
                        same decision continued. */}
                    <LooksSection />
                    <FontSection />

                    <GroupLabel title="Layout" blurb="How the screen is arranged and which panels are on it." />
                    <LayoutSection />
                    <TopbarSection />
                    <Show when={isDesktop}>
                        <MenuSection />
                        <LibrariesSection />
                    </Show>

                    {/* Gated on the same condition as the section itself, so a
                        browser (where there is only one library and no shell to
                        share settings through) doesn't get a heading with
                        nothing under it. */}
                    <Show when={appearanceIsGlobal()}>
                        <GroupLabel title="Where this applies" blurb="Whether these choices follow you across libraries or stay with this one." />
                        <AppearanceScopeSection />
                    </Show>
                </div>
            }
        >
            {(ed) => (
                <ThemeEditor
                    theme={ed().theme}
                    isNew={ed().isNew}
                    onChange={(t) => setEditor({ mode: 'edit', theme: t, isNew: ed().isNew })}
                    onSave={saveEdit}
                    onCancel={() => setEditor({ mode: 'list' })}
                />
            )}
        </Show>
    )
}

// --- Tags tab: colour generator preset ---

const TagsTab: Component<{ canManageTags: boolean }> = (props) => {
    const ui = useUI()
    const sampleSet = (p: TagColorPreset) => Array.from({ length: 6 }, () => randomTagColor(p))
    const [samples, setSamples] = createSignal(sampleSet(prefs().tagColorPreset))
    const [recoloring, setRecoloring] = createSignal(false)

    const pick = (p: TagColorPreset) => {
        setPref('tagColorPreset', p)
        setSamples(sampleSet(p))
    }

    // Bulk server-side re-colour. Library-shared, so it goes behind a
    // plain danger confirm modal. Colours are computed client-side from the
    // active preset and sent as a { tagId: color } map.
    const recolorAll = async () => {
        const preset = prefs().tagColorPreset
        const ok = await ui.confirm({
            title: 'Recolour every tag?',
            message:
                `This regenerates the colour of every tag in the library from the "${preset}" palette. ` +
                'Tags are shared, so this changes them for everyone. This cannot be undone.',
            confirmLabel: 'Recolour all',
            danger: true,
        })
        if (!ok) return
        setRecoloring(true)
        try {
            const tags = (await api.listTags()) ?? []
            const colors: Record<string, string> = {}
            for (const t of tags) colors[t.id] = randomTagColor(preset)
            await api.recolorTags(colors)
            ui.toast(`Recoloured ${tags.length} tag(s).`, 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Failed to recolour tags', 'error')
        } finally {
            setRecoloring(false)
        }
    }

    return (
        <div class="space-y-6">
            <section>
                <h3 class="text-main font-serif text-base font-semibold mb-2">Tag Colour Generator</h3>
                <p class="text-sub text-xs mb-3">
                    Choose the palette used when suggesting a colour for a new tag. Applies to the "suggest colour"
                    button in the tag creator.
                </p>
                <div class="flex flex-wrap items-center gap-2">
                    <For each={TAG_COLOR_PRESETS}>
                        {(preset) => (
                            <button
                                onClick={() => pick(preset.id)}
                                class={`rounded-md border px-4 py-2 text-sm transition-colors hover:cursor-pointer ${
                                    prefs().tagColorPreset === preset.id
                                        ? 'border-highlight bg-element-accent text-main font-semibold'
                                        : 'border-element-accent text-sub hover:border-highlight hover:text-main'
                                }`}
                            >
                                {preset.label}
                            </button>
                        )}
                    </For>
                </div>
                <div class="mt-4 flex items-center gap-3">
                    <span class="text-sub text-xs">Sample:</span>
                    <For each={samples()}>
                        {(c) => <span class="h-8 w-8 rounded-lg" style={{ 'background-color': c }} />}
                    </For>
                    <button
                        onClick={() => setSamples(sampleSet(prefs().tagColorPreset))}
                        title="Reroll samples"
                        class="text-sub hover:text-highlight-strongest ml-1 flex items-center gap-1 text-xs font-bold hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined text-sm">refresh</span>
                        Reroll
                    </button>
                </div>
            </section>

            <section>
                <h3 class="text-main font-serif text-base font-semibold mb-2">Bulk Re-colour</h3>
                <p class="text-sub text-xs mb-3 leading-relaxed">
                    Regenerate the colour of every tag from the selected palette. Tags are shared library-wide,
                    so this changes them for everyone.
                </p>
                <Show
                    when={props.canManageTags}
                    fallback={<p class="text-sub text-xs italic">Requires the Manage Tags permission.</p>}
                >
                    <button
                        onClick={recolorAll}
                        disabled={recoloring()}
                        class="border-danger text-danger hover:bg-danger flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold transition-colors hover:text-white disabled:opacity-50 hover:cursor-pointer"
                    >
                        <span class="material-symbols-outlined text-base">format_color_fill</span>
                        {recoloring() ? 'Recolouring…' : `Recolour all tags (${prefs().tagColorPreset})`}
                    </button>
                </Show>
            </section>
        </div>
    )
}

// --- Keybinds tab: rebinding UI ---

const KeybindsTab: Component = () => {
    const ui = useUI()
    const [capturing, setCapturing] = createSignal<string | null>(null)

    onMount(() => {
        const handler = (e: KeyboardEvent) => {
            const action = capturing()
            if (!action) return
            e.preventDefault()
            e.stopPropagation()
            if (e.key === 'Escape') {
                setCapturing(null)
                return
            }
            const combo = eventToCombo(e)
            if (!combo) return // bare modifier, keep waiting
            setKeybind(action as any, combo)
            setCapturing(null)
        }
        window.addEventListener('keydown', handler, true)
        onCleanup(() => window.removeEventListener('keydown', handler, true))
    })

    const doReset = () => {
        resetKeybinds()
        ui.toast('Keybinds reset to defaults.', 'success')
    }

    return (
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <h3 class="text-main font-serif text-base font-semibold">Keyboard Shortcuts</h3>
                <button onClick={doReset} class="text-sub hover:text-highlight-strongest text-xs font-bold hover:cursor-pointer">
                    Reset to defaults
                </button>
            </div>
            <p class="text-sub text-xs leading-relaxed">
                Click a shortcut to rebind it, then press the new key combination. Bindings may show an explicit
                "Ctrl" (like the default Ctrl+F search) or the portable "Mod". Both mean Ctrl (⌘ on macOS).
            </p>
            <div class="space-y-2">
                <For each={KEYBIND_DEFS}>
                    {(def) => (
                        <div class="bg-element border-element-accent flex items-center justify-between rounded-lg border p-3">
                            <span class="text-main text-sm font-bold">{def.label}</span>
                            <button
                                onClick={() => setCapturing(capturing() === def.action ? null : def.action)}
                                class={`min-w-[7rem] rounded-lg border px-3 py-1.5 text-xs font-mono font-bold transition-all hover:cursor-pointer ${
                                    capturing() === def.action
                                        ? 'border-highlight text-highlight-strongest animate-pulse'
                                        : 'border-element-accent text-sub hover:border-highlight'
                                }`}
                            >
                                {capturing() === def.action ? 'Press keys…' : displayCombo(keybinds()[def.action])}
                            </button>
                        </div>
                    )}
                </For>
            </div>
        </div>
    )
}

// --- Server tab: stats ---

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let v = n / 1024
    let i = 0
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i++
    }
    return `${v.toFixed(1)} ${units[i]}`
}

function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (d > 0) return `${d}d ${h}h ${m}m`
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
}

const ServerTab: Component = () => {
    const ui = useUI()
    const [stats, setStats] = createSignal<ServerStats | null>(null)
    const [loading, setLoading] = createSignal(true)

    const refresh = async () => {
        setLoading(true)
        try {
            setStats(await api.getStats())
        } catch (err: any) {
            ui.toast(err.message || 'Failed to load stats', 'error')
        } finally {
            setLoading(false)
        }
    }
    onMount(refresh)

    return (
        <div class="space-y-6">
            <div class="flex items-center justify-between">
                <h3 class="text-main font-serif text-base font-semibold">Server Statistics</h3>
                <button onClick={refresh} class="text-sub hover:text-highlight-strongest text-xs font-bold hover:cursor-pointer">
                    <span class="material-symbols-outlined text-sm align-middle">refresh</span> Refresh
                </button>
            </div>
            <Show when={!loading()} fallback={<p class="text-sub text-sm">Loading…</p>}>
                <Show when={stats()}>
                    {(s) => (
                        <>
                            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                <Stat label="Moments" value={String(s().stats.moments_count)} />
                                <Stat label="Tags" value={String(s().stats.tags_count)} />
                                <Stat label="Archives" value={String(s().stats.archives_count)} />
                                <Stat label="Users" value={String(s().stats.users_count)} />
                                <Stat label="Chat messages" value={String(s().stats.chat_count)} />
                                <Stat label="Assets" value={String(s().stats.assets_count)} />
                                <Stat label="Todo lists" value={String(s().stats.todo_lists_count)} />
                                <Stat label="Canvases" value={String(s().stats.canvases_count)} />
                                <Stat label="Library version" value={String(s().library_version)} />
                                <Stat label="Database size" value={formatBytes(s().stats.db_size_bytes)} />
                                <Stat label="Uploads size" value={formatBytes(s().stats.uploads_size_bytes)} />
                                <Stat label="Uptime" value={formatUptime(s().uptime_seconds)} />
                                <Stat label="Backups" value={String(s().backup_count)} />
                                <Stat label="Max upload" value={`${s().max_upload_mb} MB`} />
                            </div>
                            <Show when={s().last_backup}>
                                {(b) => (
                                    <p class="text-sub text-xs">
                                        Last backup: <span class="font-mono">{b().name}</span> ({formatBytes(b().size_bytes)}),{' '}
                                        {new Date(b().created_at).toLocaleString()}
                                    </p>
                                )}
                            </Show>
                        </>
                    )}
                </Show>
            </Show>
        </div>
    )
}

const Stat: Component<{ label: string; value: string }> = (props) => (
    <div class="bg-element border-element-accent rounded-lg border p-3">
        <div class="text-sub text-xs uppercase tracking-wide">{props.label}</div>
        <div class="text-main text-lg font-black">{props.value}</div>
    </div>
)

// --- Backups tab ---

const BackupsTab: Component = () => {
    const ui = useUI()
    const [backups, setBackups] = createSignal<Backup[]>([])
    const [loading, setLoading] = createSignal(true)
    const [busy, setBusy] = createSignal(false)
    // Automatic-backup settings (server-generated config, live-applied).
    const [settings, setSettings] = createSignal<BackupSettings | null>(null)
    const [savingSettings, setSavingSettings] = createSignal(false)

    const refresh = async () => {
        setLoading(true)
        try {
            setBackups((await api.listBackups()) ?? [])
        } catch (err: any) {
            ui.toast(err.message || 'Failed to list backups', 'error')
        } finally {
            setLoading(false)
        }
    }

    const loadSettings = async () => {
        try {
            setSettings(await api.getBackupSettings())
        } catch (err: any) {
            /* settings are best-effort; the manual controls still work */
        }
    }

    onMount(() => {
        refresh()
        loadSettings()
    })

    const patchSettings = (patch: Partial<BackupSettings>) => {
        const cur = settings()
        if (cur) setSettings({ ...cur, ...patch })
    }

    const saveSettings = async () => {
        const serverSettings = settings()
        if (!serverSettings) return
        setSavingSettings(true)
        try {
            setSettings(await api.updateBackupSettings(serverSettings))
            ui.toast('Backup schedule saved.', 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Failed to save backup schedule', 'error')
        } finally {
            setSavingSettings(false)
        }
    }

    const create = async () => {
        setBusy(true)
        try {
            await api.createBackup()
            ui.toast('Backup created.', 'success')
            await refresh()
        } catch (err: any) {
            ui.toast(err.message || 'Failed to create backup', 'error')
        } finally {
            setBusy(false)
        }
    }

    const restore = async (b: Backup) => {
        const ok = await ui.confirm({
            title: 'Restore this backup?',
            message:
                `Restoring "${b.name}" REPLACES the entire live database. All changes since that backup will be lost. ` +
                'The restore is applied when the server next restarts.',
            confirmLabel: 'Restore',
            danger: true,
            confirmText: 'restore',
        })
        if (!ok) return
        try {
            const res = await api.restoreBackup(b.name)
            ui.toast(res.status || 'Restore staged; restart the server to apply.', 'success')
        } catch (err: any) {
            ui.toast(err.message || 'Failed to stage restore', 'error')
        }
    }

    return (
        <div class="space-y-4">
            {/* Automatic backups: server-generated config, applied live. */}
            <Show when={settings()}>
                {(s) => (
                    <div class="bg-element border-element-accent space-y-3 rounded-lg border p-4">
                        <div class="flex items-center justify-between">
                            <h3 class="text-main font-serif text-base font-semibold">Automatic backups</h3>
                            <label class="text-sub flex cursor-pointer items-center gap-2 text-xs">
                                <input
                                    type="checkbox"
                                    checked={s().enabled}
                                    onChange={(e) => patchSettings({ enabled: e.currentTarget.checked })}
                                    class="h-4 w-4"
                                />
                                {s().enabled ? 'Enabled' : 'Disabled'}
                            </label>
                        </div>
                        <p class="text-sub text-xs">
                            The server writes these to its config file and applies them without a restart.
                        </p>
                        <div class="flex flex-wrap gap-4">
                            <label class="flex flex-col gap-1 text-xs">
                                <span class="text-sub">Every (hours)</span>
                                <input
                                    type="number"
                                    min="1"
                                    value={s().interval_hours}
                                    disabled={!s().enabled}
                                    onInput={(e) => patchSettings({ interval_hours: Math.max(1, Number(e.currentTarget.value) || 1) })}
                                    class="bg-element-matte text-main border-element-accent focus:border-highlight w-24 rounded-md border px-2 py-1 focus:outline-none disabled:opacity-50"
                                />
                            </label>
                            <label class="flex flex-col gap-1 text-xs">
                                <span class="text-sub">Keep (most recent)</span>
                                <input
                                    type="number"
                                    min="1"
                                    value={s().retention}
                                    onInput={(e) => patchSettings({ retention: Math.max(1, Number(e.currentTarget.value) || 1) })}
                                    class="bg-element-matte text-main border-element-accent focus:border-highlight w-24 rounded-md border px-2 py-1 focus:outline-none"
                                />
                            </label>
                        </div>
                        <button
                            onClick={saveSettings}
                            disabled={savingSettings()}
                            class="bg-highlight-strongest rounded-md px-3 py-1.5 text-xs font-bold text-white transition-[filter] hover:cursor-pointer hover:brightness-110 disabled:opacity-50"
                        >
                            {savingSettings() ? 'Saving…' : 'Save schedule'}
                        </button>
                    </div>
                )}
            </Show>

            <div class="flex items-center justify-between">
                <h3 class="text-main font-serif text-base font-semibold">Backups</h3>
                <button
                    onClick={create}
                    disabled={busy()}
                    class="bg-highlight-strongest flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-white transition-[filter] hover:brightness-110 disabled:opacity-50 hover:cursor-pointer"
                >
                    <span class="material-symbols-outlined text-sm">add</span>
                    {busy() ? 'Creating…' : 'Create backup'}
                </button>
            </div>
            <p class="text-sub text-xs">
                Restore is destructive and takes effect on the next server restart.
            </p>
            <Show when={!loading()} fallback={<p class="text-sub text-sm">Loading…</p>}>
                <Show when={backups().length > 0} fallback={<p class="text-sub text-sm italic">No backups yet.</p>}>
                    <div class="space-y-2">
                        <For each={backups()}>
                            {(b) => (
                                <div class="bg-element border-element-accent flex items-center justify-between gap-2 rounded-lg border p-3">
                                    <div class="min-w-0">
                                        <div class="text-main truncate font-mono text-xs font-bold">{b.name}</div>
                                        <div class="text-sub text-xs">
                                            {formatBytes(b.size_bytes)} · {formatDateTime(b.created_at)}
                                        </div>
                                    </div>
                                    <div class="flex shrink-0 items-center gap-2">
                                        <a
                                            href={api.backupDownloadUrl(b.name)}
                                            download={b.name}
                                            class="text-sub hover:text-highlight-strongest text-xs font-bold hover:cursor-pointer"
                                            title="Download"
                                        >
                                            <span class="material-symbols-outlined text-base align-middle">download</span>
                                        </a>
                                        <button
                                            onClick={() => restore(b)}
                                            class="text-danger hover:opacity-80 text-xs font-bold hover:cursor-pointer"
                                            title="Restore"
                                        >
                                            <span class="material-symbols-outlined text-base align-middle">restore</span>
                                        </button>
                                    </div>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
            </Show>
        </div>
    )
}

// --- About tab ---

const AboutTab: Component = () => {
    // The client and server ship as one artifact but do not have to be
    // *running* as one: the desktop shell caches the PWA, so a client can
    // outlive the server build it came from. Showing both is what makes a
    // mismatch visible instead of mysterious.
    const [server, setServer] = createSignal<{ version: string; go_version: string; os: string; arch: string } | null>(null)
    const [serverFailed, setServerFailed] = createSignal(false)
    const [historyOpen, setHistoryOpen] = createSignal(false)
    onMount(async () => {
        try {
            setServer(await api.getServerVersion())
        } catch {
            setServerFailed(true)
        }
    })

    return (
    <div class="space-y-5">
        <div class="flex items-baseline gap-3">
            <h3 class="text-main font-serif text-2xl font-semibold">Athena</h3>
            <span class="text-sub font-mono text-xs">v{__APP_VERSION__}</span>
        </div>

        <p class="text-sub text-sm leading-relaxed">
            A self-hosted home for your writing and archives. Capture moments, gather them into archives,
            organise with shared tags, and keep chat, todos, and canvases alongside your library, all styled
            with themes you control.
        </p>

        <div class="border-element-accent space-y-2 rounded-lg border p-4">
            <p class="text-main mb-1 text-xs font-bold uppercase tracking-widest">Versions</p>
            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt class="text-sub">Client</dt>
                <dd class="text-main font-mono">v{__APP_VERSION__}</dd>
                <dt class="text-sub">Server</dt>
                <dd class="text-main font-mono">
                    <Show
                        when={server()}
                        fallback={<span class="text-sub/70 italic">{serverFailed() ? 'unavailable' : 'checking…'}</span>}
                    >
                        {(s) => (
                            <>
                                {s().version}
                                <span class="text-sub/70 ml-2 font-sans">
                                    {s().os}/{s().arch} · {s().go_version}
                                </span>
                            </>
                        )}
                    </Show>
                </dd>
            </dl>
        </div>

        {/* The same notes the update notice shows once, kept somewhere they can
            be found again after it is dismissed. */}
        <Show when={currentNotes()}>
            {(notes) => (
                <div class="border-element-accent space-y-2 rounded-lg border p-4" data-testid="current-release-notes">
                    <p class="text-main mb-1 text-xs font-bold uppercase tracking-widest">New in v{__APP_VERSION__}</p>
                    <ul class="text-sub list-disc space-y-1 pl-4 text-xs leading-relaxed">
                        <For each={notes()}>{(note) => <li>{note}</li>}</For>
                    </ul>
                </div>
            )}
        </Show>

        {/* Everything written before this build. Collapsed by default: it only
            grows, and About is not a changelog page. Only rendered at all when
            there is history, so the first release does not offer an empty
            disclosure. */}
        <Show when={releaseHistory().length > 0}>
            <div class="border-element-accent rounded-lg border p-4">
                <button
                    type="button"
                    onClick={() => setHistoryOpen((open) => !open)}
                    aria-expanded={historyOpen()}
                    class="text-main flex w-full items-center justify-between gap-3 text-xs font-bold uppercase tracking-widest hover:cursor-pointer"
                >
                    Earlier releases
                    <span
                        class="material-symbols-outlined text-sub text-base transition-transform"
                        classList={{ 'rotate-180': historyOpen() }}
                    >
                        expand_more
                    </span>
                </button>
                <Show when={historyOpen()}>
                    <div class="mt-3 space-y-3" data-testid="release-history">
                        <For each={releaseHistory()}>
                            {(release) => (
                                <div>
                                    <p class="text-sub font-mono text-[11px] font-bold">v{release.version}</p>
                                    <ul class="text-sub mt-1 list-disc space-y-1 pl-4 text-xs leading-relaxed">
                                        <For each={release.notes}>{(note) => <li>{note}</li>}</For>
                                    </ul>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
            </div>
        </Show>

        <div class="border-element-accent space-y-2 rounded-lg border p-4">
            <p class="text-sub text-xs leading-relaxed">
                Themes and preferences are stored locally in this browser. The server only holds your content.
            </p>
            <p class="text-sub text-xs leading-relaxed">
                The desktop app adds multi-server support, interface fonts, and animation controls.
            </p>
        </div>

        <div class="flex flex-col gap-1">
            <a
                href="https://github.com/athenaeum-app/athena"
                target="_blank"
                rel="noopener noreferrer"
                class="text-highlight hover:text-highlight-strongest inline-flex items-center gap-1.5 text-sm font-medium transition-colors"
            >
                <span class="material-symbols-outlined text-base">open_in_new</span>
                github.com/athenaeum-app/athena
            </a>
        </div>

        <p class="text-sub text-xs">Built with SolidJS, Tailwind CSS, and Go.</p>
    </div>
    )
}

// --- Theme editor (unchanged behaviour, moved under Appearance) ---

interface ThemeEditorProps {
    theme: UserTheme
    isNew: boolean
    onChange: (theme: UserTheme) => void
    onSave: () => void
    onCancel: () => void
}

const ThemeEditor: Component<ThemeEditorProps> = (props) => {
    const [advanced, setAdvanced] = createSignal(!!props.theme.scoped)
    const setColor = (key: keyof ThemeColors, value: string) => {
        props.onChange({ ...props.theme, colors: { ...props.theme.colors, [key]: value } })
    }
    const setScoped = (key: keyof ScopedColors, value: string) => {
        props.onChange({ ...props.theme, scoped: { ...(props.theme.scoped || {}), [key]: value } })
    }
    const setName = (name: string) => props.onChange({ ...props.theme, name })

    const scopedFields: { key: keyof ScopedColors; label: string }[] = [
        { key: 'archive-panel-bg', label: 'Archives Panel BG' },
        { key: 'archive-panel-accent', label: 'Archives Panel Accent' },
        { key: 'menu-panel-bg', label: 'Menu Panel BG' },
        { key: 'menu-panel-accent', label: 'Menu Panel Accent' },
    ]

    const colorFields: { key: keyof ThemeColors; label: string }[] = [
        { key: 'bg', label: 'Background' },
        { key: 'element-matte', label: 'Element Matte' },
        { key: 'element-accent', label: 'Element Accent' },
        { key: 'element-lighter', label: 'Element Lighter' },
        { key: 'text-main', label: 'Text Main' },
        { key: 'text-sub', label: 'Text Sub' },
        { key: 'plain', label: 'Plain' },
        { key: 'highlight', label: 'Highlight' },
        { key: 'highlight-alt', label: 'Highlight Alt' },
        { key: 'md-heading', label: 'MD Heading' },
        { key: 'md-strong', label: 'MD Strong' },
    ]

    return (
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <h3 class="text-main font-serif text-base font-semibold">{props.isNew ? 'New Theme' : 'Edit Theme'}</h3>
                <div class="flex gap-2">
                    <button onClick={props.onCancel} class="bg-element-accent text-sub hover:bg-element-accent-highlight rounded-lg px-3 py-1 text-xs font-bold">Cancel</button>
                    <button onClick={props.onSave} class="bg-highlight-strongest text-white rounded-md px-3 py-1 text-xs font-bold transition-[filter] hover:brightness-110">Save</button>
                </div>
            </div>

            <div>
                <label class="text-sub text-xs font-bold tracking-widest uppercase block mb-1">Name</label>
                <input
                    type="text"
                    value={props.theme.name}
                    onInput={(e) => setName(e.currentTarget.value)}
                    class="bg-element text-main border-element-accent w-full rounded-lg border px-3 py-2 text-sm font-bold focus:outline-none focus:border-highlight"
                />
            </div>

            <div class="grid grid-cols-2 gap-3">
                <For each={colorFields}>
                    {(field) => (
                        <label class="flex items-center justify-between gap-2 bg-element rounded-lg border border-element-accent p-2">
                            <span class="text-sub text-xs font-bold uppercase tracking-wide">{field.label}</span>
                            <input
                                type="color"
                                value={props.theme.colors[field.key]}
                                onInput={(e) => setColor(field.key, e.currentTarget.value)}
                                class="h-8 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
                            />
                        </label>
                    )}
                </For>
            </div>

            {/* Advanced mode: per-panel scoped overrides. Unset values
                fall back to the global equivalents at apply time. */}
            <label class="bg-element border-element-accent flex items-center justify-between gap-3 rounded-lg border p-2 cursor-pointer">
                <span class="text-sub text-xs font-bold uppercase tracking-wide">Advanced: per-panel colours</span>
                <input
                    type="checkbox"
                    checked={advanced()}
                    onChange={(e) => setAdvanced(e.currentTarget.checked)}
                    class="accent-highlight-strongest h-5 w-5 cursor-pointer"
                />
            </label>
            <Show when={advanced()}>
                <div class="grid grid-cols-2 gap-3">
                    <For each={scopedFields}>
                        {(field) => (
                            <label class="flex items-center justify-between gap-2 bg-element rounded-lg border border-element-accent p-2">
                                <span class="text-sub text-xs font-bold uppercase tracking-wide">{field.label}</span>
                                <input
                                    type="color"
                                    value={props.theme.scoped?.[field.key] || '#000000'}
                                    onInput={(e) => setScoped(field.key, e.currentTarget.value)}
                                    class="h-8 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
                                />
                            </label>
                        )}
                    </For>
                </div>
            </Show>

            <div
                class="rounded-xl border-2 border-element-accent p-4"
                style={{ 'background-color': props.theme.colors.bg, color: props.theme.colors['text-main'] }}
            >
                <div style={{ color: props.theme.colors['md-heading'] }} class="text-lg font-bold mb-1">Preview Heading</div>
                <div style={{ color: props.theme.colors['text-sub'] }} class="text-sm mb-2">Preview body text in your theme.</div>
                <span class="inline-block rounded-xl px-3 py-1 text-xs font-black uppercase" style={{ 'background-color': props.theme.colors.highlight, color: props.theme.colors.bg }}>
                    Highlight
                </span>
            </div>
        </div>
    )
}

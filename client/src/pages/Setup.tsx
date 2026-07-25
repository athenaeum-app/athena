import { createSignal, Show, Switch, Match, For, onMount, type Component } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { useAuth } from '../auth'
import { api } from '../api'
import { getActiveTheme, setActiveTheme, PRESET_THEMES } from '../themes'
import { AuthShell } from '../components/AuthShell'
import { FormField } from '../components/FormField'

const STEPS = ['Welcome', 'Admin account', 'Password', 'Review']

// Setup is the first-run admin registration page. It is shown when the
// server has no users yet (GET /api/v1/setup returns needs_setup: true).
// The first user to register becomes the owner (ADR-0005) - the person
// hosting the server - surfaced to them here as "admin", since that's
// the role they'll recognize. No invite ID is required here. It walks
// through admin creation step by step (welcome -> username -> password
// -> review), rather than one long form. After registration the user
// is redirected to the main app.
export const Setup: Component = () => {
    const auth = useAuth()
    const navigate = useNavigate()
    const [step, setStep] = createSignal(0)
    const [username, setUsername] = createSignal('')
    const [password, setPassword] = createSignal('')
    const [confirm, setConfirm] = createSignal('')
    const [stayLoggedIn, setStayLoggedIn] = createSignal(true)
    const [error, setError] = createSignal('')
    const [loading, setLoading] = createSignal(false)
    const [selectedTheme, setSelectedTheme] = createSignal(getActiveTheme())

    // If the server is already set up, this page shouldn't be reachable.
    // Redirect to the app root (which will route to login or the feed).
    onMount(() => {
        api.getSetup()
            .then((s) => { if (!s.needs_setup) navigate('/') })
            .catch(() => {})
    })

    const goBack = () => {
        setError('')
        setStep((s) => s - 1)
    }

    const pickTheme = (id: string) => {
        setActiveTheme(id)
        setSelectedTheme(id)
    }

    const handleSubmit = async (e: Event) => {
        e.preventDefault()
        setError('')

        if (step() === 0) {
            setStep(1)
            return
        }
        if (step() === 1) {
            setStep(2)
            return
        }
        if (step() === 2) {
            if (password() !== confirm()) {
                setError('Passwords do not match')
                return
            }
            if (password().length < 6) {
                setError('Password must be at least 6 characters')
                return
            }
            setStep(3)
            return
        }

        setLoading(true)
        try {
            // No invite ID: first user becomes the owner automatically.
            await auth.register(username(), password(), '', stayLoggedIn())
            navigate('/')
        } catch (err: any) {
            setError(err.message || 'Setup failed')
        } finally {
            setLoading(false)
        }
    }

    return (
        <AuthShell>
            <div class="bg-element-matte border-element-accent relative flex w-full max-w-4xl flex-col overflow-hidden border shadow-xl md:h-[560px] md:flex-row">
                    {/* Left: persistent brand + step rail, like an installer's
                        left-hand step list. Content on the right changes; this
                        doesn't. */}
                    <div class="flex flex-col gap-8 border-b p-10 md:w-2/5 md:border-r md:border-b-0 md:p-12 border-element-accent">
                        <div class="flex items-center gap-4">
                            <img src="/logo.png" alt="Athena" class="h-16 w-16" />
                            <h1 class="font-serif text-main text-4xl font-semibold">Athena</h1>
                        </div>

                        <div class="flex flex-1 flex-col justify-center">
                            <div class="relative flex flex-col gap-6 pl-1">
                                <div class="bg-element-accent absolute top-3 bottom-3 left-[11px] w-px" />
                                <For each={STEPS}>
                                    {(label, i) => {
                                        const state = () => (i() < step() ? 'done' : i() === step() ? 'active' : 'upcoming')
                                        return (
                                            <div class="relative z-10 flex items-center gap-3">
                                                <span
                                                    class="bg-element-matte flex h-6 w-6 shrink-0 items-center justify-center border font-serif text-xs"
                                                    classList={{
                                                        'border-highlight-strongest text-highlight-strongest': state() !== 'upcoming',
                                                        'border-element-accent text-sub': state() === 'upcoming',
                                                    }}
                                                >
                                                    {state() === 'done' ? '✓' : i() + 1}
                                                </span>
                                                <span
                                                    class="text-sm"
                                                    classList={{
                                                        'text-main font-medium': state() === 'active',
                                                        'text-sub': state() !== 'active',
                                                    }}
                                                >
                                                    {label}
                                                </span>
                                            </div>
                                        )
                                    }}
                                </For>
                            </div>
                        </div>
                    </div>

                    {/* Right: current step content + navigation */}
                    <div class="flex flex-1 flex-col p-10 md:w-3/5 md:p-12">
                        <form onSubmit={handleSubmit} class="flex flex-1 flex-col">
                            <div class="flex flex-1 flex-col justify-center gap-4">
                                <Switch>
                                    <Match when={step() === 0}>
                                        <h2 class="font-serif text-main text-2xl font-semibold">Welcome to Athena</h2>
                                        <p class="text-sub text-sm leading-relaxed">
                                            Looks like you're the first one here. Let's get your admin account
                                            set up so you can start using the server.
                                        </p>
                                        <p class="text-sub text-sm leading-relaxed">
                                            This account can manage everything on the server. You won't need an
                                            invite since you're setting it up yourself - but if you'd like to
                                            share your Athena with other people later, you'll send them invites
                                            from here.
                                        </p>
                                    </Match>

                                    <Match when={step() === 1}>
                                        <h2 class="font-serif text-main text-xl font-semibold">Admin account</h2>
                                        <p class="text-sub text-sm">Choose a username for your admin account.</p>
                                        <FormField
                                            label="Admin username"
                                            type="text"
                                            value={username()}
                                            onInput={setUsername}
                                            required
                                            autofocus
                                        />
                                    </Match>

                                    <Match when={step() === 2}>
                                        <h2 class="font-serif text-main text-xl font-semibold">Set a password</h2>
                                        <FormField
                                            label="Password"
                                            type="password"
                                            value={password()}
                                            onInput={setPassword}
                                            required
                                            autofocus
                                        />
                                        <FormField
                                            label="Confirm password"
                                            type="password"
                                            value={confirm()}
                                            onInput={setConfirm}
                                            required
                                        />
                                    </Match>

                                    <Match when={step() === 3}>
                                        <h2 class="font-serif text-main text-xl font-semibold">Review</h2>
                                        <div class="border-element-accent flex items-center justify-between border px-3 py-2 text-sm">
                                            <span class="text-sub">Admin username</span>
                                            <span class="text-main font-medium">{username()}</span>
                                        </div>
                                        <label class="text-sub flex cursor-pointer items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={stayLoggedIn()}
                                                onChange={(e) => setStayLoggedIn(e.currentTarget.checked)}
                                                class="accent-highlight-strongest"
                                            />
                                            Stay logged in
                                        </label>

                                        {/* A real, working theme picker - not a
                                            mockup. Each swatch carries its own
                                            data-theme so it renders in its actual
                                            colors, and picking one applies it to
                                            the app immediately via localStorage. */}
                                        <div class="flex flex-col gap-2">
                                            <span class="text-sub text-xs font-medium">
                                                Pick a theme (you can change this later)
                                            </span>
                                            <div class="grid grid-cols-5 gap-2">
                                                <For each={PRESET_THEMES}>
                                                    {(id) => (
                                                        <button
                                                            type="button"
                                                            data-theme={id}
                                                            title={id}
                                                            aria-label={`Use the ${id} theme`}
                                                            onClick={() => pickTheme(id)}
                                                            class="flex h-9 items-center justify-center border"
                                                            style={{ 'background-color': 'var(--theme-bg)' }}
                                                            classList={{
                                                                'border-highlight-strongest': selectedTheme() === id,
                                                                'border-element-accent': selectedTheme() !== id,
                                                            }}
                                                        >
                                                            <span
                                                                class="block h-3 w-3"
                                                                style={{ 'background-color': 'var(--theme-highlight)' }}
                                                            />
                                                        </button>
                                                    )}
                                                </For>
                                            </div>
                                        </div>
                                    </Match>
                                </Switch>

                                <Show when={error()}>
                                    <p class="text-danger text-sm">{error()}</p>
                                </Show>
                            </div>

                            <div class="border-element-accent mt-6 flex items-center justify-between border-t pt-6">
                                <Show when={step() > 0} fallback={<span />}>
                                    <button
                                        type="button"
                                        onClick={goBack}
                                        class="text-sub hover:text-main text-sm font-medium"
                                    >
                                        Back
                                    </button>
                                </Show>
                                <button
                                    type="submit"
                                    disabled={loading()}
                                    class="bg-highlight-strongest rounded-sm px-6 py-2.5 font-semibold text-white transition-[filter] hover:brightness-110 disabled:opacity-50"
                                >
                                    {step() === 0
                                        ? 'Get started'
                                        : step() === 3
                                            ? (loading() ? 'Creating admin...' : 'Create admin account')
                                            : 'Next'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
        </AuthShell>
    )
}

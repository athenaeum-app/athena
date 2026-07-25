import { createSignal, Show, onMount, type Component } from 'solid-js'
import { useNavigate, useSearchParams } from '@solidjs/router'
import { useAuth } from '../auth'
import { api } from '../api'
import { AuthShell } from '../components/AuthShell'
import { FormField } from '../components/FormField'

export const Register: Component = () => {
    const auth = useAuth()
    const navigate = useNavigate()
    // Prefill the invite from a shareable link: /register?invite=<id>.
    const [searchParams] = useSearchParams<{ invite?: string }>()
    const invitedByLink = typeof searchParams.invite === 'string' && searchParams.invite.length > 0
    const [username, setUsername] = createSignal('')
    const [password, setPassword] = createSignal('')
    const [inviteId, setInviteId] = createSignal(searchParams.invite ?? '')
    const [stayLoggedIn, setStayLoggedIn] = createSignal(true)
    const [error, setError] = createSignal('')
    const [loading, setLoading] = createSignal(false)

    // If the server has no users yet, the first user must go through setup
    // (no invite required). Otherwise registration below requires an invite.
    onMount(() => {
        api.getSetup()
            .then((s) => { if (s.needs_setup) navigate('/setup') })
            .catch(() => {})
    })

    const handleSubmit = async (e: Event) => {
        e.preventDefault()
        setError('')
        setLoading(true)
        try {
            await auth.register(username(), password(), inviteId(), stayLoggedIn())
            navigate('/')
        } catch (err: any) {
            setError(err.message || 'Registration failed')
        } finally {
            setLoading(false)
        }
    }

    return (
        <AuthShell>
            <div class="bg-element-matte border-element-accent flex w-full max-w-sm flex-col gap-8 border p-10 shadow-xl">
                <div class="flex flex-col items-center gap-4 text-center">
                    <img src="/logo.png" alt="Athena" class="h-14 w-14" />
                    <h1 class="font-serif text-main text-3xl font-semibold">Create Account</h1>
                </div>
                <form onSubmit={handleSubmit} class="flex flex-col gap-4">
                    <FormField
                        label="Username"
                        type="text"
                        value={username()}
                        onInput={setUsername}
                        required
                        autofocus
                    />
                    <FormField
                        label="Password"
                        type="password"
                        value={password()}
                        onInput={setPassword}
                        required
                    />
                    <Show
                        when={!invitedByLink}
                        fallback={
                            <div class="border-highlight/40 bg-highlight-strongest/10 text-sub flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                                <span class="material-symbols-outlined text-highlight text-base">check_circle</span>
                                You're registering with an invite link.
                            </div>
                        }
                    >
                        <FormField
                            label="Invite ID"
                            hint="(not needed for first user)"
                            type="text"
                            value={inviteId()}
                            onInput={setInviteId}
                        />
                    </Show>
                    <label class="text-sub flex cursor-pointer items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={stayLoggedIn()}
                            onChange={(e) => setStayLoggedIn(e.currentTarget.checked)}
                            class="accent-highlight-strongest"
                        />
                        Stay logged in
                    </label>
                    <Show when={error()}>
                        <p class="text-danger text-sm">{error()}</p>
                    </Show>
                    <button
                        type="submit"
                        disabled={loading()}
                        class="bg-highlight-strongest w-full rounded-sm py-2.5 font-semibold text-white transition-[filter] hover:brightness-110 disabled:opacity-50"
                    >
                        {loading() ? 'Creating account...' : 'Register'}
                    </button>
                </form>
                <p class="text-sub text-center text-sm">
                    Already have an account?{' '}
                    <a href="/login" class="text-highlight-strongest hover:underline">Log in</a>
                </p>
            </div>
        </AuthShell>
    )
}

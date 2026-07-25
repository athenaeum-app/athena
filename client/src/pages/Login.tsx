import { createSignal, Show, onMount, type Component } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { useAuth } from '../auth'
import { api } from '../api'
import { AuthShell } from '../components/AuthShell'
import { FormField } from '../components/FormField'

export const Login: Component = () => {
    const auth = useAuth()
    const navigate = useNavigate()
    const [username, setUsername] = createSignal('')
    const [password, setPassword] = createSignal('')
    const [stayLoggedIn, setStayLoggedIn] = createSignal(true)
    const [error, setError] = createSignal('')
    const [loading, setLoading] = createSignal(false)

    // If the server has no users yet, the first user must go through setup.
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
            await auth.login(username(), password(), stayLoggedIn())
            navigate('/')
        } catch (err: any) {
            setError(err.message || 'Login failed')
        } finally {
            setLoading(false)
        }
    }

    return (
        <AuthShell>
            <div class="bg-element-matte border-element-accent flex w-full max-w-sm flex-col gap-8 border p-10 shadow-xl">
                <div class="flex flex-col items-center gap-4 text-center">
                    <img src="/logo.png" alt="Athena" class="h-14 w-14" />
                    <h1 class="font-serif text-main text-3xl font-semibold">Athena</h1>
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
                        {loading() ? 'Logging in...' : 'Log In'}
                    </button>
                </form>
                <p class="text-sub text-center text-sm">
                    Need an account?{' '}
                    <a href="/register" class="text-highlight-strongest hover:underline">Register</a>
                </p>
            </div>
        </AuthShell>
    )
}

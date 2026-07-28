import { createSignal, createContext, useContext, ParentComponent, createEffect } from 'solid-js'
import { api } from './api'
import { isTransportError, setServerUnreachable } from './reachability'

export interface AuthUser {
    id: string
    username: string
    is_owner: boolean
    roles: string[]
    permissions: number
}

interface AuthContextValue {
    user: () => AuthUser | null
    loading: () => boolean
    login: (username: string, password: string, stayLoggedIn: boolean) => Promise<void>
    register: (username: string, password: string, inviteId: string, stayLoggedIn: boolean) => Promise<void>
    logout: () => Promise<void>
    refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>()

export const AuthProvider: ParentComponent = (props) => {
    const [user, setUser] = createSignal<AuthUser | null>(null)
    const [loading, setLoading] = createSignal(true)

    // No session and a dead server both land in the catch, and they must not
    // land in the same state: "logged out" renders a login form, and a login
    // form for a server that cannot answer one is a dead end that reads as a
    // wrong password. APIError means the server answered (reachable, no
    // session); anything else means the request never arrived.
    const refresh = async () => {
        try {
            const me = await api.getMe()
            setUser(me)
            setServerUnreachable(false)
        } catch (err) {
            setUser(null)
            setServerUnreachable(isTransportError(err))
        } finally {
            setLoading(false)
        }
    }

    // A submit that never reached the server gets the unreachable screen, not
    // an inline "Failed to fetch" under the password field. The credentials in
    // the form are lost in the swap, but they were never going anywhere.
    const classify = (err: unknown) => {
        if (isTransportError(err)) setServerUnreachable(true)
        throw err
    }

    const login = async (username: string, password: string, stayLoggedIn: boolean) => {
        await api.login(username, password, stayLoggedIn).catch(classify)
        await refresh()
    }

    const register = async (username: string, password: string, inviteId: string, stayLoggedIn: boolean) => {
        await api.register(username, password, inviteId || undefined, stayLoggedIn).catch(classify)
        await refresh()
    }

    const logout = async () => {
        await api.logout()
        setUser(null)
    }

    // Check session on load
    createEffect(() => {
        refresh()
    })

    return (
        <AuthContext.Provider value={{ user, loading, login, register, logout, refresh }}>
            {props.children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth must be used within AuthProvider')
    return ctx
}

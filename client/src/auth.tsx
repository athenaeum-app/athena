import { createSignal, createContext, useContext, ParentComponent, createEffect } from 'solid-js'
import { api } from './api'

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

    const refresh = async () => {
        try {
            const me = await api.getMe()
            setUser(me)
        } catch {
            setUser(null)
        } finally {
            setLoading(false)
        }
    }

    const login = async (username: string, password: string, stayLoggedIn: boolean) => {
        const loggedIn = await api.login(username, password, stayLoggedIn)
        await refresh()
    }

    const register = async (username: string, password: string, inviteId: string, stayLoggedIn: boolean) => {
        await api.register(username, password, inviteId || undefined, stayLoggedIn)
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

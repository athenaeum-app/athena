import { describe, it, expect } from 'vitest'
import {
    PERMISSIONS,
    PERMISSION_GROUPS,
    hasPermission,
    togglePermission,
} from './permissions'

describe('hasPermission', () => {
    it('detects a directly-granted flag', () => {
        const perms = (1 << 0) | (1 << 1) // VIEW_MOMENTS | CREATE_MOMENT
        expect(hasPermission(perms, 0)).toBe(true)
        expect(hasPermission(perms, 1)).toBe(true)
        expect(hasPermission(perms, 5)).toBe(false)
    })

    it('treats ADMINISTRATOR (bit 19) as a wildcard', () => {
        const admin = 1 << 19
        // Every non-admin flag should read as granted.
        for (const p of PERMISSIONS) {
            expect(hasPermission(admin, p.bit)).toBe(true)
        }
    })

    it('grants nothing for an empty permission set', () => {
        expect(hasPermission(0, 0)).toBe(false)
        expect(hasPermission(0, 18)).toBe(false)
    })
})

describe('togglePermission', () => {
    it('flips a bit on and off', () => {
        let perms = 0
        perms = togglePermission(perms, 3)
        expect(hasPermission(perms, 3)).toBe(true)
        perms = togglePermission(perms, 3)
        expect(hasPermission(perms, 3)).toBe(false)
    })

    it('does not disturb other bits', () => {
        const base = 1 << 2
        const toggled = togglePermission(base, 7)
        expect(hasPermission(toggled, 2)).toBe(true)
        expect(hasPermission(toggled, 7)).toBe(true)
    })
})

describe('permission catalogue', () => {
    it('mirrors the server flags plus the wildcard', () => {
        // 19 real flags (bits 0..18) + ADMINISTRATOR (bit 19) + 4 v2.1
        // additions (bits 20..23) = 24 entries.
        expect(PERMISSIONS).toHaveLength(24)
        const bits = PERMISSIONS.map((p) => p.bit)
        expect(new Set(bits).size).toBe(24) // all distinct
        expect(Math.max(...bits)).toBe(23)
    })

    it('derives groups without duplicates', () => {
        expect(PERMISSION_GROUPS).toContain('Moments')
        expect(PERMISSION_GROUPS).toContain('Administration')
        expect(new Set(PERMISSION_GROUPS).size).toBe(PERMISSION_GROUPS.length)
    })
})

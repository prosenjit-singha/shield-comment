import { describe, expect, it } from 'vitest'
import type { AuthSession } from '@/lib/auth-client'
import { adminAccess, isSuperAdmin } from '@/lib/session'

function session(
  role: string | null,
  extra: { impersonatedBy?: string | null; banned?: boolean | null } = {},
): AuthSession {
  return {
    session: { id: 's1', impersonatedBy: extra.impersonatedBy ?? null },
    user: { id: 'u1', email: 'a@b.co', name: 'A', role, banned: extra.banned ?? false },
  } as unknown as AuthSession // only the fields adminAccess reads
}

describe('adminAccess', () => {
  it.each([
    ['no session', null, 'signed-out'],
    ['role user', session('user'), 'not-super-admin'],
    ['no role', session(null), 'not-super-admin'],
    ['role admin', session('admin'), 'not-super-admin'],
    ['banned super admin', session('super_admin', { banned: true }), 'banned'],
    ['impersonated super admin', session('super_admin', { impersonatedBy: 'admin-1' }), 'impersonated'],
    ['impersonated user', session('user', { impersonatedBy: 'admin-1' }), 'impersonated'],
    ['super admin', session('super_admin'), 'granted'],
  ] as const)('%s → %s', (_label, input, expected) => {
    expect(adminAccess(input)).toBe(expected)
    expect(isSuperAdmin(input)).toBe(expected === 'granted')
  })
})

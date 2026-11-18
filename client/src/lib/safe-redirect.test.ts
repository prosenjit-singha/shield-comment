import { describe, expect, it } from 'vitest'
import { safeRedirect } from '@/lib/safe-redirect'

describe('safeRedirect', () => {
  it('keeps same-app paths with their query', () => {
    expect(safeRedirect('/orders?page=2')).toBe('/orders?page=2')
    expect(safeRedirect('/onboarding')).toBe('/onboarding')
    expect(safeRedirect('/registered-pages')).toBe('/registered-pages')
  })

  it('falls back to /dashboard for anything off-site or missing', () => {
    for (const target of [undefined, '', 'orders', 'https://evil.example', '//evil.example', 42]) {
      expect(safeRedirect(target)).toBe('/dashboard')
    }
  })

  it('never sends a signed-in user back to an auth page', () => {
    for (const target of ['/login', '/login?redirect=%2Fx', '/register', '/register#top']) {
      expect(safeRedirect(target)).toBe('/dashboard')
    }
  })
})

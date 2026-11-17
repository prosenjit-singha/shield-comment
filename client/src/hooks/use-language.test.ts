import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useLanguageStore } from '@/stores/language-store'
import { useLanguage } from './use-language'

describe('useLanguage', () => {
  beforeEach(() => {
    localStorage.clear()
    useLanguageStore.setState({ language: 'en' })
  })

  it('returns English by default', () => {
    const { result } = renderHook(() => useLanguage())
    expect(result.current.language).toBe('en')
    expect(result.current.content('Hello', 'হ্যালো')).toBe('Hello')
  })

  it("returns Bangla after switching to 'bn'", () => {
    const { result } = renderHook(() => useLanguage())
    act(() => result.current.setLanguage('bn'))
    expect(result.current.content('Hello', 'হ্যালো')).toBe('হ্যালো')
  })

  it('persists the choice to localStorage', () => {
    const { result } = renderHook(() => useLanguage())
    act(() => result.current.toggleLanguage())
    expect(result.current.language).toBe('bn')
    expect(localStorage.getItem('shield-client-lang')).toContain('"language":"bn"')
  })
})

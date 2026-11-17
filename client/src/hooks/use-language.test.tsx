import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { languageFromCookieString } from '@/lib/language'
import { createLanguageStore, LanguageStoreContext, type LanguageStore } from '@/stores/language-store'
import { useLanguage } from './use-language'

function clearLanguageCookie() {
  document.cookie = 'shield-lang=; Path=/; Max-Age=0'
}

function renderUseLanguage(store: LanguageStore = createLanguageStore()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LanguageStoreContext value={store}>{children}</LanguageStoreContext>
  )
  return renderHook(() => useLanguage(), { wrapper })
}

describe('useLanguage', () => {
  beforeEach(clearLanguageCookie)

  it('returns English by default', () => {
    const { result } = renderUseLanguage()
    expect(result.current.language).toBe('en')
    expect(result.current.content('Hello', 'হ্যালো')).toBe('Hello')
  })

  it("returns Bangla after switching to 'bn'", () => {
    const { result } = renderUseLanguage()
    act(() => result.current.setLanguage('bn'))
    expect(result.current.content('Hello', 'হ্যালো')).toBe('হ্যালো')
  })

  it('persists the choice to the shield-lang cookie (not localStorage)', () => {
    const { result } = renderUseLanguage()
    act(() => result.current.toggleLanguage())
    expect(result.current.language).toBe('bn')
    expect(languageFromCookieString(document.cookie)).toBe('bn')
    expect(localStorage.length).toBe(0)
  })

  it('starts from the language the server rendered', () => {
    const { result } = renderUseLanguage(createLanguageStore('bn'))
    expect(result.current.content('Hello', 'হ্যালো')).toBe('হ্যালো')
  })

  it('keeps separate stores independent (one per SSR request)', () => {
    const a = createLanguageStore('en')
    const b = createLanguageStore('en')
    a.getState().setLanguage('bn')
    expect(b.getState().language).toBe('en')
  })
})

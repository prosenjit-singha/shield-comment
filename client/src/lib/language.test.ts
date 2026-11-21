import { describe, expect, it } from 'vitest'
import {
  fixedLanguageForPath,
  languageFromCookieString,
  parseLanguage,
  serializeLanguageCookie,
} from './language'

describe('language cookie helpers', () => {
  it('reads shield-lang from a Cookie header among other cookies', () => {
    expect(languageFromCookieString('a=1; shield-lang=bn; better-auth.session_token=x')).toBe('bn')
    expect(languageFromCookieString('shield-lang=en')).toBe('en')
  })

  it('falls back to English for missing or unknown values', () => {
    expect(languageFromCookieString(undefined)).toBe('en')
    expect(languageFromCookieString('')).toBe('en')
    expect(languageFromCookieString('shield-lang=fr')).toBe('en')
    expect(parseLanguage(undefined)).toBe('en')
  })

  it('writes a site-wide, long-lived, Lax cookie (Secure on https)', () => {
    expect(serializeLanguageCookie('bn')).toBe('shield-lang=bn; Path=/; Max-Age=31536000; SameSite=Lax')
    expect(serializeLanguageCookie('en', true)).toMatch(/; Secure$/)
  })

  it('pins the landing URLs and leaves other pages to the cookie', () => {
    expect(fixedLanguageForPath('/')).toBe('en')
    expect(fixedLanguageForPath('/bn')).toBe('bn')
    expect(fixedLanguageForPath('/bn/pricing')).toBe('bn')
    expect(fixedLanguageForPath('/dashboard')).toBeNull()
    expect(fixedLanguageForPath('/bnx')).toBeNull()
    // Legal pages (M9-T7): fixed like the landing.
    expect(fixedLanguageForPath('/privacy')).toBe('en')
    expect(fixedLanguageForPath('/terms')).toBe('en')
    expect(fixedLanguageForPath('/refund-policy')).toBe('en')
    expect(fixedLanguageForPath('/bn/refund-policy')).toBe('bn')
    expect(fixedLanguageForPath('/data-deletion')).toBeNull()
  })
})

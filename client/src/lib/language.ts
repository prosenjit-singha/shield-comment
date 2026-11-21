import { PUBLIC_PAGES } from '@/lib/seo'

export type Language = 'en' | 'bn'

/** Preference cookie (not httpOnly: the browser writes it). The server reads it so SSR HTML matches. */
export const LANGUAGE_COOKIE = 'shield-lang'
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

export function parseLanguage(value: unknown): Language {
  return value === 'bn' ? 'bn' : 'en'
}

/** Reads `shield-lang` from a `Cookie` header or `document.cookie` string. Defaults to English. */
export function languageFromCookieString(cookies: string | null | undefined): Language {
  for (const part of (cookies ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === LANGUAGE_COOKIE) return parseLanguage(decodeURIComponent(value.join('=')))
  }
  return 'en'
}

export function serializeLanguageCookie(language: Language, secure = false): string {
  const parts = [`${LANGUAGE_COOKIE}=${language}`, 'Path=/', `Max-Age=${ONE_YEAR_SECONDS}`, 'SameSite=Lax']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Browser only: remember the choice for the next server render. No-op on the server. */
export function writeLanguageCookie(language: Language): void {
  if (typeof document === 'undefined') return
  document.cookie = serializeLanguageCookie(language, window.location.protocol === 'https:')
}

/**
 * Public pages (`PUBLIC_PAGES`) have a fixed language so `hreflang` stays honest: `/`, `/privacy`… are
 * English, `/bn`, `/bn/privacy`… Bangla. Every other page follows the cookie.
 */
export function fixedLanguageForPath(pathname: string): Language | null {
  if (pathname === '/bn' || pathname.startsWith('/bn/')) return 'bn'
  if (Object.values(PUBLIC_PAGES).some((paths) => paths.en === pathname)) return 'en'
  return null
}

const BANGLA_NUMBER = new Intl.NumberFormat('bn-BD')

/** A number in Bangla digits (`3` → `৩`), for the `bangla` side of `content()`. */
export function bnNumber(value: number): string {
  return BANGLA_NUMBER.format(value)
}

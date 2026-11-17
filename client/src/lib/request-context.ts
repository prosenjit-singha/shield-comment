import { createIsomorphicFn } from '@tanstack/react-start'
import { getCookie, getRequestUrl } from '@tanstack/react-start/server'
import { LANGUAGE_COOKIE, languageFromCookieString, parseLanguage, type Language } from '@/lib/language'

/** `shield-lang` cookie: from the request during a server render, from `document.cookie` in the browser. */
export const getLanguagePreference = createIsomorphicFn()
  .server((): Language => parseLanguage(getCookie(LANGUAGE_COOKIE)))
  .client((): Language => languageFromCookieString(document.cookie))

/**
 * Absolute origin for canonical / hreflang / og:url. Prod sets `PUBLIC_SITE_URL` (e.g.
 * https://app.<domain>) so tags never depend on a client-supplied Host header.
 */
export const getSiteOrigin = createIsomorphicFn()
  .server((): string => (process.env.PUBLIC_SITE_URL ?? getRequestUrl().origin).replace(/\/+$/, ''))
  .client((): string => window.location.origin)

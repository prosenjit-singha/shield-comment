import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { parseLanguage } from '@/lib/language'
import { createQueryClient } from '@/lib/query-client'
import { getCspNonce } from '@/lib/request-context'
import { createLanguageStore } from '@/stores/language-store'
import { routeTree } from './routeTree.gen'

/**
 * TanStack Start calls this once per server request and once in the browser, so the QueryClient and
 * the language store are never shared between requests.
 */
export function getRouter() {
  const queryClient = createQueryClient()
  // Browser: start from the language the server rendered (<html lang>) so hydration matches.
  const languageStore = createLanguageStore(
    typeof document === 'undefined' ? 'en' : parseLanguage(document.documentElement.lang),
  )

  const router = createRouter({
    routeTree,
    context: { queryClient, languageStore },
    defaultPreload: 'intent',
    // Loaders read from TanStack Query, which already caches; let it decide freshness.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    // Start adds it to every inline script it emits (CSP Report-Only, M9-T8).
    ssr: { nonce: getCspNonce() },
  })

  // Dehydrates queries fetched during SSR (e.g. the session) into the page and wraps QueryClientProvider.
  setupRouterSsrQueryIntegration({ router, queryClient })

  return router
}

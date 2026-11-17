import { ClientOnly } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resolveTheme, useUiStore } from '@/stores/ui-store'

// Dev-only: `import.meta.env.DEV` is statically false in production builds, so Vite drops these chunks.
const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-query-devtools').then((m) => ({ default: m.ReactQueryDevtools })),
    )
  : null
const RouterDevtools = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-router-devtools').then((m) => ({ default: m.TanStackRouterDevtools })),
    )
  : null

/** Keeps the `.dark` class on <html> in sync with the UI store and, for 'system', the OS. */
function ThemeSync() {
  const theme = useUiStore((s) => s.theme)

  useEffect(() => {
    const apply = () =>
      document.documentElement.classList.toggle('dark', resolveTheme(theme) === 'dark')
    apply()
    if (theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  return null
}

/**
 * App-wide providers. QueryClientProvider comes from `setupRouterSsrQueryIntegration` (router.tsx) and
 * the language store from __root.tsx, because both must be per request.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <ThemeSync />
      {children}
      <ClientOnly>
        <Suspense fallback={null}>
          {ReactQueryDevtools && <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />}
          {RouterDevtools && <RouterDevtools position="bottom-right" />}
        </Suspense>
      </ClientOnly>
    </TooltipProvider>
  )
}

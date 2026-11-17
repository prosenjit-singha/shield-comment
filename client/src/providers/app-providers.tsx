import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createQueryClient } from '@/lib/query-client'
import { useLanguageStore } from '@/stores/language-store'
import { resolveTheme, useUiStore } from '@/stores/ui-store'

// Dev-only: `import.meta.env.DEV` is statically false in production builds, so Vite drops this chunk.
const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-query-devtools').then((m) => ({ default: m.ReactQueryDevtools })),
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

/** Keeps <html lang> in sync with the chosen language (screen readers, Bangla hyphenation/shaping). */
function LanguageSync() {
  const language = useLanguageStore((s) => s.language)

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  return null
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeSync />
        <LanguageSync />
        {children}
      </TooltipProvider>
      {ReactQueryDevtools && (
        <Suspense fallback={null}>
          <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
        </Suspense>
      )}
    </QueryClientProvider>
  )
}

import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Scripts,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { fixedLanguageForPath } from '@/lib/language'
import { getLanguagePreference } from '@/lib/request-context'
import { SITE_NAME } from '@/lib/seo'
import { AppProviders } from '@/providers/app-providers'
import {
  LanguageStoreContext,
  useLanguageStoreState,
  type LanguageStore,
} from '@/stores/language-store'
import appCss from '../globals.css?url'

export interface RouterContext {
  queryClient: QueryClient
  languageStore: LanguageStore
}

// Runs before first paint so a dark-theme user never sees a light flash (ui-store persists to localStorage).
const THEME_BOOT_SCRIPT = `try{var t=(JSON.parse(localStorage.getItem('shield-client-ui')||'{}').state||{}).theme||'system';if(t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`

export const Route = createRootRouteWithContext<RouterContext>()({
  // Language for this render: fixed on the landing URLs (`/`, `/bn`), otherwise the `shield-lang` cookie.
  // Skipped for hover preloads so the UI doesn't switch language before the click.
  beforeLoad: ({ context, location, preload }) => {
    if (preload) return
    const language = fixedLanguageForPath(location.pathname) ?? getLanguagePreference()
    context.languageStore.setState({ language })
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#005CDA' },
      { title: SITE_NAME },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
  errorComponent: RootError,
})

function RootDocument({ children }: { children: ReactNode }) {
  const { languageStore } = Route.useRouteContext()
  const language = useLanguageStoreState(languageStore, (s) => s.language)
  const nonce = useRouter().options.ssr?.nonce

  return (
    // suppressHydrationWarning: the boot script may add `.dark` before React hydrates.
    <html lang={language} suppressHydrationWarning>
      <head>
        <HeadContent />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-svh bg-background font-sans text-foreground antialiased">
        <LanguageStoreContext value={languageStore}>
          <AppProviders>{children}</AppProviders>
        </LanguageStoreContext>
        <Scripts />
      </body>
    </html>
  )
}

function CenteredMessage({ title, body }: { title: string; body: string }) {
  const { content } = useLanguage()
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-muted p-6 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      <Button asChild>
        <Link to="/">{content('Back to home', 'হোমে ফিরে যান')}</Link>
      </Button>
    </main>
  )
}

function NotFound() {
  const { content } = useLanguage()
  return (
    <CenteredMessage
      title={content('Page not found', 'পেজটি পাওয়া যায়নি')}
      body={content('This page does not exist.', 'এই পেজটি নেই।')}
    />
  )
}

function RootError({ error }: ErrorComponentProps) {
  const { content } = useLanguage()
  return (
    <CenteredMessage
      title={content('Something went wrong', 'কিছু একটা সমস্যা হয়েছে')}
      body={error instanceof Error ? error.message : String(error)}
    />
  )
}

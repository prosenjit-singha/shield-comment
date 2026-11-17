import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import { Languages, LogOut, Moon, ShieldCheck, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import { authClient } from '@/lib/auth-client'
import { sessionQueryOptions } from '@/lib/session'
import { resolveTheme, useUiStore } from '@/stores/ui-store'

/**
 * Pathless layout for every logged-in page.
 *
 * `ssr: 'data-only'` (SW-T7 decision): beforeLoad runs on the server too, so a signed-out request gets a
 * real HTTP redirect to /login before any HTML, and the session is dehydrated into the page (no second
 * get-session call in the browser). The components render only in the browser: dashboards are
 * private (no SEO value), chart-heavy, and read browser-only state (theme, localStorage). `ssr: false`
 * would skip the server check and flash an empty shell before redirecting.
 */
export const Route = createFileRoute('/_app')({
  ssr: 'data-only',
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
    if (!session) throw redirect({ to: '/login', search: { redirect: location.href } })
    return { session }
  },
  pendingComponent: AppPending,
  component: AppLayout,
})

function AppPending() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <Skeleton className="h-10 w-48 rounded-full" />
      <Skeleton className="h-40 w-full rounded-3xl" />
    </div>
  )
}

function AppLayout() {
  const { session } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { language, toggleLanguage, content } = useLanguage()
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const isDark = resolveTheme(theme) === 'dark'

  const signOut = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signOut()
      if (error) throw new Error(error.message ?? 'Sign-out failed')
    },
    onSuccess: async () => {
      queryClient.clear() // drop the session and any tenant data cached under it
      await navigate({ to: '/login', search: {}, replace: true })
    },
  })

  return (
    <div className="flex min-h-svh flex-col bg-muted">
      {/* Placeholder shell; the real sidebar + impersonation banner arrive with Module 6. */}
      <header className="flex items-center gap-2 border-b bg-card px-4 py-3 sm:gap-3 sm:px-6">
        <ShieldCheck className="size-6 text-primary" aria-hidden />
        <span className="font-semibold">ShieldComment BD</span>
        <span className="ml-auto hidden text-sm text-muted-foreground sm:inline">{session.user.email}</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto sm:ml-0"
          onClick={toggleLanguage}
          aria-label={content('Switch to Bangla', 'ইংরেজিতে দেখুন')}
        >
          <Languages />
          {language === 'en' ? 'বাংলা' : 'English'}
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label={isDark ? content('Switch to light theme', 'লাইট থিম') : content('Switch to dark theme', 'ডার্ক থিম')}
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
        >
          {isDark ? <Sun /> : <Moon />}
        </Button>
        <Button variant="outline" size="sm" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
          <LogOut />
          <span className="hidden sm:inline">{content('Log out', 'লগ আউট')}</span>
        </Button>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  )
}

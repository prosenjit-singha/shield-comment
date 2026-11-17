import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import { LogOut, Moon, ShieldCheck, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'
import { isSuperAdmin, sessionQueryOptions } from '@/lib/session'
import { resolveTheme, useUiStore } from '@/stores/ui-store'

/** Pathless layout: every route below it needs a Better Auth session with role `super_admin`. */
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
    if (!isSuperAdmin(session)) {
      throw redirect({ to: '/admin/login', search: { redirect: location.href } })
    }
    return { session }
  },
  component: AuthedLayout,
})

function AuthedLayout() {
  const { session } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
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
      await navigate({ to: '/admin/login', search: {}, replace: true })
    },
  })

  return (
    <div className="flex min-h-svh flex-col bg-muted">
      {/* Placeholder shell; the Animate UI sidebar arrives with Module 2. */}
      <header className="flex items-center gap-3 border-b bg-card px-6 py-3">
        <ShieldCheck className="size-6 text-primary" aria-hidden />
        <span className="font-semibold">ShieldComment BD · Admin</span>
        <span className="ml-auto hidden text-sm text-muted-foreground sm:inline">
          {session.user.email}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
        >
          {isDark ? <Sun /> : <Moon />}
        </Button>
        <Button variant="outline" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
          <LogOut />
          Sign out
        </Button>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 p-6">
        <Outlet />
      </main>
    </div>
  )
}

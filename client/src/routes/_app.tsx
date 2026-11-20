import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import { CircleAlert } from 'lucide-react'
import { useState } from 'react'
import { AppBottomBar, AppSidebar } from '@/components/app-shell/app-nav'
import { AppTopBar } from '@/components/app-shell/app-top-bar'
import { ImpersonationBanner } from '@/components/app-shell/impersonation-banner'
import { ImpersonationEnded } from '@/components/app-shell/impersonation-ended'
import { PlanStatusBanner } from '@/components/app-shell/plan-banner'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import { authErrorMessage, type AuthError } from '@/lib/auth-errors'
import { signOutCurrentSession } from '@/lib/auth-forms'
import { sessionQueryOptions } from '@/lib/session'

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
  const { content } = useLanguage()
  const impersonated = Boolean(session.session.impersonatedBy)
  const workspaceId = session.session.activeOrganizationId
  const [impersonationEnded, setImpersonationEnded] = useState(false)

  const signOut = useMutation<void, AuthError>({
    mutationFn: signOutCurrentSession,
    onSuccess: async () => {
      queryClient.clear() // drop the session and any tenant data cached under it
      await navigate({ to: '/login', search: {}, replace: true })
    },
  })

  // D11: "Exit" ends the impersonated session only (the admin's own session lives on the admin origin).
  // The children unmount with the shell, so nothing refetches under the dead session.
  const exitImpersonation = useMutation<void, AuthError>({
    mutationFn: signOutCurrentSession,
    onSuccess: () => {
      setImpersonationEnded(true)
      queryClient.clear()
    },
  })

  if (impersonationEnded) return <ImpersonationEnded />

  return (
    <div className="flex min-h-svh flex-col bg-muted">
      {impersonated ? (
        <ImpersonationBanner
          ownerEmail={session.user.email}
          onExit={() => exitImpersonation.mutate()}
          pending={exitImpersonation.isPending}
          error={exitImpersonation.error}
        />
      ) : null}
      <AppTopBar
        email={session.user.email}
        onSignOut={impersonated ? undefined : () => signOut.mutate()}
        signingOut={signOut.isPending}
      />
      {/* PW-T8: trial / paused / limit banner from the billing summary (none while loading or on failure). */}
      {workspaceId ? <PlanStatusBanner workspaceId={workspaceId} /> : null}
      {signOut.error && !signOut.isPending ? (
        <div className="mx-auto w-full max-w-6xl px-4 pt-4 sm:px-6">
          <div
            role="alert"
            data-kind={signOut.error.kind}
            className="flex items-start gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-foreground"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <p>
              {content('Couldn’t log you out.', 'লগ আউট করা যায়নি।')} {authErrorMessage(signOut.error, content)}
            </p>
          </div>
        </div>
      ) : null}
      {/* M6-T8 (D16 c): sidebar from md up, bottom bar below (pb-24 keeps content clear of it). */}
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 p-4 pb-24 sm:p-6 sm:pb-24 md:pb-6">
        <AppSidebar />
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
      <AppBottomBar />
    </div>
  )
}

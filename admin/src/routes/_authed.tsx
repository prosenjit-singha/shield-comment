import { createFileRoute, Outlet, redirect, useRouterState } from '@tanstack/react-router'
import { AppSidebar } from '@/components/app-shell/app-sidebar'
import { activeNavItem } from '@/components/app-shell/nav-items'
import { FullPageLoader } from '@/components/full-page-loader'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AuthSession } from '@/lib/auth-client'
import { isSuperAdmin, sessionQueryOptions } from '@/lib/session'
import { useUiStore } from '@/stores/ui-store'

/**
 * Pathless layout: every route below it needs a Better Auth session with role `super_admin`
 * that is neither banned nor an impersonation session (see `adminAccess`).
 */
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const toLogin = redirect({ to: '/admin/login', search: { redirect: location.href } })
    let session: AuthSession | null
    try {
      session = await context.queryClient.ensureQueryData(sessionQueryOptions)
    } catch {
      // Fail closed: if the session can't be checked, the login page explains why.
      throw toLogin
    }
    // Refuses: no session, role !== 'super_admin', banned, and impersonation sessions.
    if (!isSuperAdmin(session)) throw toLogin
    return { session }
  },
  pendingComponent: () => <FullPageLoader />,
  component: AuthedLayout,
})

function AuthedLayout() {
  const { session } = Route.useRouteContext()
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const setCollapsed = useUiStore((s) => s.setSidebarCollapsed)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const section = activeNavItem(pathname)?.label

  return (
    // Own provider so the shell's tooltips also work where only the router is rendered (tests).
    <TooltipProvider>
      <SidebarProvider
        open={!collapsed}
        onOpenChange={(open) => setCollapsed(!open)}
        className="bg-muted dark:bg-background"
      >
        <AppSidebar user={session.user} />
        <SidebarInset className="min-w-0 bg-muted dark:bg-background">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 bg-muted/85 px-4 backdrop-blur dark:bg-background/80 md:px-6">
            <SidebarTrigger className="-ml-1" />
            <span className="truncate text-sm font-medium">{section ?? 'Admin'}</span>
          </header>
          {/* SidebarInset is the <main> landmark. */}
          <div className="mx-auto w-full max-w-6xl flex-1 px-4 pt-2 pb-10 md:px-6">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

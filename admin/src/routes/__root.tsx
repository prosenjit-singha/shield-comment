import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'

export interface RouterContext {
  queryClient: QueryClient
}

// Dev-only, same pattern as the Query devtools: Vite drops this chunk from production builds.
const RouterDevtools = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-router-devtools').then((m) => ({
        default: m.TanStackRouterDevtools,
      })),
    )
  : null

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RootError,
})

function RootLayout() {
  return (
    <>
      <Outlet />
      <Toaster position="top-right" closeButton />
      {RouterDevtools && (
        <Suspense fallback={null}>
          <RouterDevtools position="bottom-right" />
        </Suspense>
      )}
    </>
  )
}

function CenteredMessage({ title, body }: { title: string; body: string }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-muted p-6 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      <Button asChild>
        <Link to="/admin/dashboard">Back to dashboard</Link>
      </Button>
    </main>
  )
}

function NotFound() {
  return <CenteredMessage title="Page not found" body="This admin page does not exist." />
}

function RootError({ error }: ErrorComponentProps) {
  return <CenteredMessage title="Something went wrong" body={error instanceof Error ? error.message : String(error)} />
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { CircleAlert, LoaderCircle, LogOut, ShieldCheck, WifiOff } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { FullPageLoader } from '@/components/full-page-loader'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authClient, type AuthSession } from '@/lib/auth-client'
import { SignInError, signInErrorFromResponse, toSignInError } from '@/lib/auth-errors'
import { safeRedirect } from '@/lib/safe-redirect'
import {
  adminAccess,
  isSuperAdmin,
  sessionQueryKey,
  sessionQueryOptions,
  type AdminAccess,
} from '@/lib/session'

interface LoginSearch {
  redirect?: string
}

export const Route = createFileRoute('/admin/login')({
  // Return the key even when invalid: the router merges the raw search under this result.
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    let session: AuthSession | null = null
    try {
      session = await context.queryClient.ensureQueryData(sessionQueryOptions)
    } catch {
      // Session check failed (offline / API down): stay here; the page shows the problem.
      return
    }
    if (isSuperAdmin(session)) throw redirect({ href: safeRedirect(search.redirect), replace: true })
  },
  pendingComponent: () => <FullPageLoader />,
  component: LoginPage,
})

/** Why a signed-in session was refused (every `AdminAccess` except granted / signed-out). */
const refusalCopy: Record<Exclude<AdminAccess, 'granted' | 'signed-out'>, (email: string) => string> = {
  'not-super-admin': (email) =>
    `${email} is signed in, but it is not a super admin account. Sign out to use a different account.`,
  banned: (email) => `${email} has been banned and can't use the admin panel.`,
  impersonated: () =>
    'This is a "Login as Client" session. Impersonation sessions can\'t open the admin panel. Sign out to continue.',
}

function LoginPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const sessionQuery = useQuery(sessionQueryOptions)
  const session = sessionQuery.data
  const access = adminAccess(session)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // After any auth change: clear the cached session (reset = drop data + one refetch for this
  // page's observer), then re-run this route's beforeLoad, which reuses that in-flight fetch and
  // redirects a super admin to the `?redirect` target (via safeRedirect).
  const refreshSession = async () => {
    await queryClient.resetQueries({ queryKey: sessionQueryKey })
    await router.invalidate()
  }

  const signIn = useMutation<unknown, SignInError, { email: string; password: string }>({
    mutationFn: async (input) => {
      const response = { retryAfter: null as string | null }
      let result: Awaited<ReturnType<typeof authClient.signIn.email>>
      try {
        result = await authClient.signIn.email(input, {
          onError: (ctx) => {
            response.retryAfter = ctx.response.headers.get('X-Retry-After')
          },
        })
      } catch (thrown) {
        throw toSignInError(thrown)
      }
      if (result.error) throw signInErrorFromResponse(result.error, response.retryAfter)
      return result.data
    },
    onSuccess: refreshSession,
  })

  const signOut = useMutation({
    mutationFn: async () => {
      let error: { message?: string } | null
      try {
        ;({ error } = await authClient.signOut())
      } catch {
        throw new Error("Can't reach the server. Check your connection and try again.")
      }
      if (error) throw new Error(error.message || 'Sign-out failed. Try again.')
    },
    onSuccess: refreshSession,
  })

  const clearError = () => {
    if (signIn.isError) signIn.reset()
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (signIn.isPending) return
    signIn.mutate({ email: email.trim(), password })
  }

  const badCredentials = signIn.error?.kind === 'invalid-credentials'

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-4 sm:p-6 dark:bg-background">
      <Card className="w-full max-w-sm gap-6 [--card-spacing:--spacing(6)]">
        <CardHeader className="justify-items-center gap-2 text-center">
          <span className="mb-1 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="size-6" aria-hidden />
          </span>
          <CardTitle className="text-xl font-semibold">ShieldComment BD Admin</CardTitle>
          <CardDescription>Super admin sign-in</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {sessionQuery.isError && !session && (
            <Notice icon={<WifiOff className="size-4" aria-hidden />} tone="muted">
              Couldn't check your session. The server may be unreachable.{' '}
              <button
                type="button"
                className="font-medium text-primary underline-offset-4 hover:underline"
                onClick={() => void sessionQuery.refetch()}
              >
                Retry
              </button>
            </Notice>
          )}

          {session && access !== 'granted' && access !== 'signed-out' ? (
            // Signed in, but the `_authed` guard refuses this session.
            <div className="flex flex-col gap-4">
              <Notice icon={<CircleAlert className="size-4" aria-hidden />} tone="destructive">
                {refusalCopy[access](session.user.email)}
              </Notice>
              {signOut.error && (
                <p className="text-center text-sm text-destructive" role="alert">
                  {signOut.error.message}
                </p>
              )}
              <Button
                variant="outline"
                className="h-10 w-full rounded-full"
                onClick={() => signOut.mutate()}
                disabled={signOut.isPending}
              >
                {signOut.isPending ? (
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
                ) : (
                  <LogOut aria-hidden />
                )}
                {signOut.isPending ? 'Signing out…' : 'Sign out'}
              </Button>
            </div>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={onSubmit} aria-busy={signIn.isPending}>
              <fieldset className="flex flex-col gap-4" disabled={signIn.isPending}>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    autoFocus
                    required
                    className="h-10 px-4"
                    aria-invalid={badCredentials || undefined}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      clearError()
                    }}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    className="h-10 px-4"
                    aria-invalid={badCredentials || undefined}
                    aria-describedby={signIn.error ? 'sign-in-error' : undefined}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                      clearError()
                    }}
                  />
                </div>
              </fieldset>
              {signIn.error && (
                <Notice
                  id="sign-in-error"
                  icon={
                    signIn.error.kind === 'network' ? (
                      <WifiOff className="size-4" aria-hidden />
                    ) : (
                      <CircleAlert className="size-4" aria-hidden />
                    )
                  }
                  tone="destructive"
                  kind={signIn.error.kind}
                >
                  {signIn.error.message}
                </Notice>
              )}
              <Button type="submit" className="h-10 w-full rounded-full" disabled={signIn.isPending}>
                {signIn.isPending && (
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
                )}
                {signIn.isPending ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

function Notice({
  id,
  icon,
  tone,
  kind,
  children,
}: {
  id?: string
  icon: ReactNode
  tone: 'destructive' | 'muted'
  kind?: string
  children: ReactNode
}) {
  return (
    <div
      id={id}
      role="alert"
      data-kind={kind}
      className={
        tone === 'destructive'
          ? 'flex items-start gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-foreground'
          : 'flex items-start gap-2.5 rounded-2xl border bg-muted px-4 py-3 text-sm text-muted-foreground'
      }
    >
      <span className={tone === 'destructive' ? 'mt-0.5 text-destructive' : 'mt-0.5'}>{icon}</span>
      <p className="flex-1">{children}</p>
    </div>
  )
}

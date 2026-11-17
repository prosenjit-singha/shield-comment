import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authClient } from '@/lib/auth-client'
import { safeRedirect } from '@/lib/safe-redirect'
import { isSuperAdmin, sessionQueryKey, sessionQueryOptions } from '@/lib/session'

interface LoginSearch {
  redirect?: string
}

export const Route = createFileRoute('/admin/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
    if (isSuperAdmin(session)) throw redirect({ href: safeRedirect(search.redirect), replace: true })
  },
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: session } = useQuery(sessionQueryOptions)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // After any auth change: drop the cached session and re-run this route's beforeLoad,
  // which redirects a super admin to the target page.
  const refreshSession = async () => {
    queryClient.removeQueries({ queryKey: sessionQueryKey })
    await router.invalidate()
  }

  const signIn = useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      const { data, error } = await authClient.signIn.email(input)
      if (error) throw new Error(error.message ?? 'Sign-in failed')
      return data
    },
    onSuccess: refreshSession,
  })

  const signOut = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signOut()
      if (error) throw new Error(error.message ?? 'Sign-out failed')
    },
    onSuccess: refreshSession,
  })

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    signIn.mutate({ email, password })
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-sm rounded-3xl">
        <CardHeader className="items-center text-center">
          <ShieldCheck className="mx-auto size-10 text-primary" aria-hidden />
          <CardTitle className="text-xl">ShieldComment BD Admin</CardTitle>
          <CardDescription>Super admin sign-in</CardDescription>
        </CardHeader>
        <CardContent>
          {session ? (
            // Signed in, but the guard rejected it: not a super admin.
            <div className="flex flex-col gap-4 text-center">
              <p className="text-sm text-muted-foreground" role="alert">
                {session.user.email} is not a super admin account.
              </p>
              <Button
                variant="outline"
                onClick={() => signOut.mutate()}
                disabled={signOut.isPending}
              >
                Sign out
              </Button>
            </div>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={onSubmit}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {signIn.error && (
                <p className="text-sm text-destructive" role="alert">
                  {signIn.error.message}
                </p>
              )}
              <Button type="submit" disabled={signIn.isPending}>
                {signIn.isPending ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLanguage } from '@/hooks/use-language'
import { authClient } from '@/lib/auth-client'
import { safeRedirect } from '@/lib/safe-redirect'
import { sessionQueryKey, sessionQueryOptions } from '@/lib/session'

interface LoginSearch {
  redirect?: string
}

/** Placeholder sign-in (SW-T7). Sign-up, reset and the real design arrive with Module 1/6. */
export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
    if (session) throw redirect({ href: safeRedirect(search.redirect), replace: true })
  },
  head: () => ({ meta: [{ title: 'Log in | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { content } = useLanguage()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const signIn = useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      const { data, error } = await authClient.signIn.email(input)
      if (error) throw new Error(error.message ?? 'Sign-in failed')
      return data
    },
    // Drop the cached `null` session and re-run beforeLoad, which redirects to the target page.
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: sessionQueryKey })
      await router.invalidate()
    },
  })

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    signIn.mutate({ email, password })
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-4 sm:p-6">
      <Card className="w-full max-w-sm rounded-3xl">
        <CardHeader className="items-center text-center">
          <Link to="/" aria-label="ShieldComment BD">
            <ShieldCheck className="mx-auto size-10 text-primary" aria-hidden />
          </Link>
          <CardTitle className="text-xl">{content('Welcome back', 'আবার স্বাগতম')}</CardTitle>
          <CardDescription>
            {content('Log in to your ShieldComment workspace', 'আপনার ShieldComment ওয়ার্কস্পেসে লগ ইন করুন')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">{content('Email', 'ইমেইল')}</Label>
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
              <Label htmlFor="password">{content('Password', 'পাসওয়ার্ড')}</Label>
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
              {signIn.isPending ? content('Logging in…', 'লগ ইন হচ্ছে…') : content('Log in', 'লগ ইন')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

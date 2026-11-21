import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { LoaderCircle } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { AuthAlert, AuthScreen, FormField } from '@/components/auth/auth-screen'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { authErrorMessage, type AuthError } from '@/lib/auth-errors'
import {
  fieldErrorMessage,
  signInWithEmail,
  validateSignIn,
  type FieldErrors,
  type SignInInput,
} from '@/lib/auth-forms'
import { checkoutTarget, validateCheckoutIntent, type CheckoutIntent } from '@/lib/billing'
import { postAuthDestination } from '@/lib/post-auth'
import { safeRedirect } from '@/lib/safe-redirect'
import { sessionQueryOptions } from '@/lib/session'

interface LoginSearch extends CheckoutIntent {
  redirect?: string
}

/**
 * C2 sign-in (M3-T8). A signed-in visitor goes straight to `?redirect=` (via `safeRedirect`). After a
 * sign-in without a usable `?redirect=`, `postAuthDestination` applies the D13 onboarding rule. D11
 * (M8-T11): `?plan=&interval=` (an existing account from a "Choose plan" button) goes to that checkout.
 */
export const Route = createFileRoute('/login')({
  // Return the key even when invalid: the router merges the raw search under this result.
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
    ...validateCheckoutIntent(search),
  }),
  beforeLoad: async ({ context, search }) => {
    let session: unknown = null
    try {
      session = await context.queryClient.ensureQueryData(sessionQueryOptions)
    } catch {
      return // session check failed (offline / API down): show the form; sign-in reports the problem
    }
    if (session) throw redirect({ href: safeRedirect(search.redirect, checkoutTarget(search) ?? '/dashboard'), replace: true })
  },
  head: () => ({ meta: [{ title: 'Log in | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: LoginPage,
})

function LoginPage() {
  const { redirect: target, plan, interval } = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { content } = useLanguage()
  const [values, setValues] = useState<SignInInput>({ email: '', password: '' })
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<keyof SignInInput>>({})

  const signIn = useMutation<void, AuthError, SignInInput>({
    mutationFn: signInWithEmail,
    onSuccess: async () => {
      // New identity: drop the cached `null` session and anything cached under a previous user.
      queryClient.removeQueries()
      // An explicit (safe) ?redirect= wins; otherwise D13 picks /onboarding (0 active Pages) or /dashboard.
      const explicit = safeRedirect(target, '') || checkoutTarget({ plan, interval })
      await navigate({ href: explicit || (await postAuthDestination(queryClient)), replace: true })
    },
  })

  const update = (field: keyof SignInInput, value: string) => {
    setValues((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
    if (signIn.isError) signIn.reset()
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (signIn.isPending) return
    const errors = validateSignIn(values)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    signIn.mutate(values)
  }

  const badCredentials = signIn.error?.kind === 'invalid-credentials'
  const errorFor = (field: keyof SignInInput) => {
    const error = fieldErrors[field]
    return error ? fieldErrorMessage(field, error, content) : undefined
  }

  return (
    <AuthScreen
      title={content('Welcome back', 'আবার স্বাগতম')}
      description={content(
        'Log in to keep scam comments off your ads.',
        'আপনার অ্যাডে স্ক্যাম কমেন্ট ঠেকাতে লগ ইন করুন।',
      )}
      footer={
        <p>
          {content('New to ShieldComment?', 'ShieldComment-এ নতুন?')}{' '}
          <Link to="/register" search={{ plan, interval }} className="font-medium text-primary underline-offset-4 hover:underline">
            {content('Create an account', 'অ্যাকাউন্ট খুলুন')}
          </Link>
        </p>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate aria-busy={signIn.isPending}>
        <fieldset className="flex flex-col gap-4" disabled={signIn.isPending}>
          <FormField
            id="email"
            label={content('Email', 'ইমেইল')}
            type="email"
            autoComplete="username"
            inputMode="email"
            value={values.email}
            onChange={(e) => update('email', e.target.value)}
            error={errorFor('email')}
            aria-invalid={badCredentials || fieldErrors.email ? true : undefined}
          />
          <FormField
            id="password"
            label={content('Password', 'পাসওয়ার্ড')}
            type="password"
            autoComplete="current-password"
            value={values.password}
            onChange={(e) => update('password', e.target.value)}
            error={errorFor('password')}
            aria-invalid={badCredentials || fieldErrors.password ? true : undefined}
          />
        </fieldset>
        {signIn.error && (
          <AuthAlert id="sign-in-error" kind={signIn.error.kind}>
            {authErrorMessage(signIn.error, content)}
          </AuthAlert>
        )}
        <Button type="submit" className="h-11 w-full" disabled={signIn.isPending}>
          {signIn.isPending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
          {signIn.isPending ? content('Logging in…', 'লগ ইন হচ্ছে…') : content('Log in', 'লগ ইন')}
        </Button>
      </form>
    </AuthScreen>
  )
}

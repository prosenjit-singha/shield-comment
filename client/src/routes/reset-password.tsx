import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { LoaderCircle } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { AuthAlert, AuthScreen, FormField } from '@/components/auth/auth-screen'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { authErrorMessage, type AuthError } from '@/lib/auth-errors'
import {
  fieldErrorMessage,
  PASSWORD_MIN,
  resetPassword,
  validateNewPassword,
  type FieldErrors,
  type NewPasswordInput,
} from '@/lib/auth-forms'
import { validateImpersonateSearch } from '@/lib/impersonation'

/**
 * Choose a new password from the emailed link (M9-T6, D10 b). Browser-only (`ssr: false`): the token is
 * kept in component state and stripped from the address bar (like `/impersonate`) before anything is
 * sent. Success revokes every session (backend) → `/login?reset=1`.
 */
export const Route = createFileRoute('/reset-password')({
  ssr: false,
  // Same `?token=` shape as `/impersonate`.
  validateSearch: validateImpersonateSearch,
  head: () => ({ meta: [{ title: 'Choose a new password | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const { token: tokenInUrl } = Route.useSearch()
  const [token] = useState(tokenInUrl)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { content } = useLanguage()
  const [values, setValues] = useState<NewPasswordInput>({ password: '', confirmPassword: '' })
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<keyof NewPasswordInput>>({})

  useEffect(() => {
    if (tokenInUrl) void navigate({ to: Route.fullPath, search: {}, replace: true })
  }, [tokenInUrl, navigate])

  const reset = useMutation<void, AuthError, string>({
    mutationFn: (password) => resetPassword(token ?? '', password),
    onSuccess: async () => {
      // Every session was revoked: forget whoever was cached so /login shows the form.
      queryClient.removeQueries()
      await navigate({ to: '/login', search: { reset: 1 }, replace: true })
    },
  })

  const update = (field: keyof NewPasswordInput, value: string) => {
    setValues((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
    if (reset.isError) reset.reset()
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (reset.isPending) return
    const errors = validateNewPassword(values)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    reset.mutate(values.password)
  }

  const errorFor = (field: keyof NewPasswordInput) => {
    const error = fieldErrors[field]
    return error ? fieldErrorMessage(field, error, content) : undefined
  }
  const newLink = (
    <Link to="/forgot-password" className="font-medium text-primary underline-offset-4 hover:underline">
      {content('Request a new link', 'নতুন লিংক চান')}
    </Link>
  )

  return (
    <AuthScreen
      title={content('Choose a new password', 'নতুন পাসওয়ার্ড বেছে নিন')}
      description={content(
        'You’ll be logged out everywhere, then you can log in with the new password.',
        'সব জায়গা থেকে লগ আউট হয়ে যাবেন, তারপর নতুন পাসওয়ার্ড দিয়ে লগ ইন করতে পারবেন।',
      )}
      footer={
        <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          {content('Back to log in', 'লগ ইনে ফিরে যান')}
        </Link>
      }
    >
      {!token ? (
        <AuthAlert kind="invalid-token">
          {content('This reset link is incomplete.', 'এই রিসেট লিংকটি অসম্পূর্ণ।')} {newLink}
        </AuthAlert>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate aria-busy={reset.isPending}>
          <fieldset className="flex flex-col gap-4" disabled={reset.isPending}>
            <FormField
              id="password"
              label={content('New password', 'নতুন পাসওয়ার্ড')}
              type="password"
              autoComplete="new-password"
              value={values.password}
              onChange={(e) => update('password', e.target.value)}
              error={errorFor('password')}
              hint={content(`At least ${PASSWORD_MIN} characters.`, 'কমপক্ষে ৮ অক্ষর।')}
            />
            <FormField
              id="confirmPassword"
              label={content('Confirm new password', 'নতুন পাসওয়ার্ড আবার লিখুন')}
              type="password"
              autoComplete="new-password"
              value={values.confirmPassword}
              onChange={(e) => update('confirmPassword', e.target.value)}
              error={errorFor('confirmPassword')}
            />
          </fieldset>
          {reset.error && (
            <AuthAlert id="reset-password-error" kind={reset.error.kind}>
              {authErrorMessage(reset.error, content)} {reset.error.kind === 'invalid-token' && newLink}
            </AuthAlert>
          )}
          <Button type="submit" className="h-11 w-full" disabled={reset.isPending}>
            {reset.isPending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {reset.isPending ? content('Saving…', 'সেভ হচ্ছে…') : content('Save new password', 'নতুন পাসওয়ার্ড সেভ করুন')}
          </Button>
        </form>
      )}
    </AuthScreen>
  )
}

import { useMutation } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { LoaderCircle, MailCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { AuthAlert, AuthScreen, FormField } from '@/components/auth/auth-screen'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { authErrorMessage, type AuthError } from '@/lib/auth-errors'
import { emailError, fieldErrorMessage, requestPasswordReset, type FieldError } from '@/lib/auth-forms'

/**
 * Forgot password (M9-T6, D10 b): email → `request-password-reset`. The answer never says whether the
 * account exists (the backend sends 200 either way), so neither does the page.
 */
export const Route = createFileRoute('/forgot-password')({
  head: () => ({ meta: [{ title: 'Forgot password | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: ForgotPasswordPage,
})

function ForgotPasswordPage() {
  const { content } = useLanguage()
  const [email, setEmail] = useState('')
  const [fieldError, setFieldError] = useState<FieldError>()
  const request = useMutation<void, AuthError, string>({ mutationFn: requestPasswordReset })

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (request.isPending) return
    const error = emailError(email)
    setFieldError(error)
    if (!error) request.mutate(email)
  }

  const backToLogin = (
    <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
      {content('Back to log in', 'লগ ইনে ফিরে যান')}
    </Link>
  )

  return (
    <AuthScreen
      title={content('Reset your password', 'পাসওয়ার্ড রিসেট করুন')}
      description={content(
        'Enter your account email and we’ll send you a link to choose a new password.',
        'আপনার অ্যাকাউন্টের ইমেইল দিন, নতুন পাসওয়ার্ড বেছে নেওয়ার লিংক পাঠিয়ে দেব।',
      )}
      footer={backToLogin}
    >
      {request.isSuccess ? (
        <div role="status" className="flex items-start gap-3 rounded-2xl bg-muted px-4 py-3 text-sm">
          <MailCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p className="text-pretty">
            {content(
              `If an account exists for ${request.variables.trim()}, we sent it a link to reset the password. The link works for 1 hour. Check your spam folder if you can’t find it.`,
              `${request.variables.trim()} ঠিকানায় অ্যাকাউন্ট থাকলে পাসওয়ার্ড রিসেটের একটি লিংক পাঠিয়েছি। লিংকটি ১ ঘণ্টা কাজ করবে। খুঁজে না পেলে স্প্যাম ফোল্ডার দেখুন।`,
            )}
          </p>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate aria-busy={request.isPending}>
          <fieldset className="flex flex-col gap-4" disabled={request.isPending}>
            <FormField
              id="email"
              label={content('Email', 'ইমেইল')}
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setFieldError(undefined)
                if (request.isError) request.reset()
              }}
              error={fieldError ? fieldErrorMessage('email', fieldError, content) : undefined}
            />
          </fieldset>
          {request.error && (
            <AuthAlert id="forgot-password-error" kind={request.error.kind}>
              {authErrorMessage(request.error, content)}
            </AuthAlert>
          )}
          <Button type="submit" className="h-11 w-full" disabled={request.isPending}>
            {request.isPending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {request.isPending ? content('Sending…', 'পাঠানো হচ্ছে…') : content('Send reset link', 'রিসেট লিংক পাঠান')}
          </Button>
        </form>
      )}
    </AuthScreen>
  )
}

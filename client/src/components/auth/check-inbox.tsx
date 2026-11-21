import { useMutation } from '@tanstack/react-query'
import { LoaderCircle, MailCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { AuthAlert, AuthScreen, FormField } from '@/components/auth/auth-screen'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { authErrorMessage, type AuthError } from '@/lib/auth-errors'
import { emailError, fieldErrorMessage, sendVerificationEmail, type FieldError } from '@/lib/auth-forms'
import { formatCount } from '@/lib/dashboard-summary'

/** Seconds the resend button waits after a sent email (the backend allows 3 per minute per IP). */
const RESEND_COOLDOWN_SECONDS = 60

/**
 * "Check your inbox" (M9-T6, D10 b): after `/register` or an invite sign-up (`sign-up`: the backend just
 * sent the link) and when `/login` gets 403 `EMAIL_NOT_VERIFIED` (`sign-in`: nothing was sent).
 */
export function CheckInbox({ email, reason, footer }: { email: string; reason: 'sign-up' | 'sign-in'; footer: ReactNode }) {
  const { content } = useLanguage()
  return (
    <AuthScreen
      title={content('Check your inbox', 'আপনার ইনবক্স দেখুন')}
      description={
        reason === 'sign-up'
          ? content(
              `We sent a verification link to ${email}. Open it to finish setting up your account.`,
              `${email} ঠিকানায় একটি যাচাই লিংক পাঠিয়েছি। অ্যাকাউন্ট চালু করতে লিংকটি খুলুন।`,
            )
          : content(
              `Verify your email before you log in. We can send the link to ${email} again.`,
              `লগ ইন করার আগে আপনার ইমেইল যাচাই করুন। ${email} ঠিকানায় লিংকটি আবার পাঠাতে পারি।`,
            )
      }
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-2xl bg-muted px-4 py-3 text-sm">
          <MailCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p className="text-pretty">
            {content(
              'The link works for 1 hour. Can’t find it? Check your spam folder, or send it again.',
              'লিংকটি ১ ঘণ্টা কাজ করবে। খুঁজে না পেলে স্প্যাম ফোল্ডার দেখুন, অথবা আবার পাঠান।',
            )}
          </p>
        </div>
        <ResendVerification email={email} />
      </div>
    </AuthScreen>
  )
}

/**
 * Resend button (`send-verification-email`) with a cooldown after each send or 429. Without `email` it
 * shows its own email field (the `/verify-email` failure screen).
 */
export function ResendVerification({ email: fixedEmail }: { email?: string }) {
  const { content, language } = useLanguage()
  const [typed, setTyped] = useState('')
  const [fieldError, setFieldError] = useState<FieldError>()
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  const startCooldown = (seconds: number) => {
    const at = Date.now()
    setNow(at)
    setCooldownUntil(at + seconds * 1000)
  }
  const resend = useMutation<void, AuthError, string>({
    mutationFn: sendVerificationEmail,
    onSuccess: () => startCooldown(RESEND_COOLDOWN_SECONDS),
    onError: (error) => {
      if (error.retryAfterSeconds) startCooldown(error.retryAfterSeconds)
    },
  })

  const secondsLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))
  useEffect(() => {
    if (cooldownUntil <= now) return
    const id = setTimeout(() => setNow(Date.now()), 1000)
    return () => clearTimeout(id)
  }, [cooldownUntil, now])

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (resend.isPending || secondsLeft > 0) return
    const email = fixedEmail ?? typed
    if (fixedEmail === undefined) {
      const error = emailError(typed)
      setFieldError(error)
      if (error) return
    }
    resend.mutate(email)
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate aria-busy={resend.isPending}>
      {fixedEmail === undefined && (
        <FormField
          id="resend-email"
          label={content('Email', 'ইমেইল')}
          type="email"
          autoComplete="email"
          inputMode="email"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value)
            setFieldError(undefined)
          }}
          error={fieldError ? fieldErrorMessage('email', fieldError, content) : undefined}
        />
      )}
      {resend.isSuccess && (
        <p role="status" className="rounded-2xl bg-primary/10 px-4 py-3 text-sm">
          {content('We sent a new link. Check your inbox.', 'নতুন একটি লিংক পাঠিয়েছি। আপনার ইনবক্স দেখুন।')}
        </p>
      )}
      {resend.error && <AuthAlert kind={resend.error.kind}>{authErrorMessage(resend.error, content)}</AuthAlert>}
      <Button type="submit" variant="outline" className="h-11 w-full" disabled={resend.isPending || secondsLeft > 0}>
        {resend.isPending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}
        {resend.isPending
          ? content('Sending…', 'পাঠানো হচ্ছে…')
          : secondsLeft > 0
            ? content(`Resend in ${secondsLeft} s`, `${formatCount(secondsLeft, language)} সেকেন্ড পরে আবার পাঠান`)
            : content('Resend verification email', 'যাচাই ইমেইল আবার পাঠান')}
      </Button>
    </form>
  )
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { CircleCheck, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AuthAlert, AuthScreen } from '@/components/auth/auth-screen'
import { ResendVerification } from '@/components/auth/check-inbox'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { authErrorMessage, type AuthError } from '@/lib/auth-errors'
import { verifyEmail } from '@/lib/auth-forms'
import { validateImpersonateSearch } from '@/lib/impersonation'
import { takePendingInvite } from '@/lib/invite'
import { postAuthDestination } from '@/lib/post-auth'
import { sessionQueryOptions } from '@/lib/session'

/** What happens after the link worked. */
type Verified =
  | { next: 'go'; href: string }
  | { next: 'log-in' } // a replayed link: verified, but no session was set
  | { next: 'open-invite' } // an invitee on a browser that didn't sign up (M9-T6-a)

/**
 * The emailed verification link (M9-T6, D10 b). Browser-only (`ssr: false`); the token is kept in state,
 * stripped from the address bar, then sent once (`GET verify-email`, which signs the user in). Then: the
 * invite this browser signed up from (M9-T6-a), else `postAuthDestination`.
 */
export const Route = createFileRoute('/verify-email')({
  ssr: false,
  validateSearch: validateImpersonateSearch,
  head: () => ({ meta: [{ title: 'Verify email | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: VerifyEmailPage,
})

function VerifyEmailPage() {
  const { token: tokenInUrl } = Route.useSearch()
  const [token] = useState(tokenInUrl)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { content } = useLanguage()
  const started = useRef(false)

  const verify = useMutation<Verified, AuthError, string>({
    mutationFn: async (value) => {
      await verifyEmail(value)
      // A new identity: drop the cached `null` session and anything cached under a previous user.
      queryClient.removeQueries()
      const session = await queryClient.fetchQuery(sessionQueryOptions).catch(() => null)
      if (!session) return { next: 'log-in' }
      const invite = takePendingInvite()
      if (invite && invite.email.toLowerCase() === session.user.email.toLowerCase()) {
        return { next: 'go', href: `/invite/${invite.invitationId}` }
      }
      if (!session.session.activeOrganizationId) return { next: 'open-invite' }
      return { next: 'go', href: await postAuthDestination(queryClient) }
    },
    onSuccess: async (result) => {
      if (result.next === 'go') await navigate({ href: result.href, replace: true })
    },
  })
  const { mutate } = verify

  useEffect(() => {
    // StrictMode runs effects twice on mount; the ref survives, so the token is sent exactly once.
    if (started.current || !token) return
    started.current = true
    void navigate({ to: Route.fullPath, search: {}, replace: true }).finally(() => mutate(token))
  }, [token, navigate, mutate])

  const loginLink = (
    <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
      {content('Back to log in', 'লগ ইনে ফিরে যান')}
    </Link>
  )

  if (verify.data?.next === 'log-in' || verify.data?.next === 'open-invite') {
    return (
      <AuthScreen
        title={content('Email verified', 'ইমেইল যাচাই হয়েছে')}
        description={
          verify.data.next === 'log-in'
            ? content('Your email address is verified. Log in to continue.', 'আপনার ইমেইল ঠিকানা যাচাই হয়েছে। চালিয়ে যেতে লগ ইন করুন।')
            : content(
                'To join the workspace you were invited to, open the invitation link from your email again.',
                'যে ওয়ার্কস্পেসে আমন্ত্রণ পেয়েছেন সেখানে যোগ দিতে ইমেইলের আমন্ত্রণ লিংকটি আবার খুলুন।',
              )
        }
        footer={null}
      >
        <div role="status" className="flex flex-col items-center gap-4">
          <CircleCheck className="size-10 text-primary" aria-hidden />
          <Button asChild className="h-11 w-full">
            {verify.data.next === 'log-in' ? (
              <Link to="/login">{content('Log in', 'লগ ইন')}</Link>
            ) : (
              <Link to="/dashboard">{content('Go to dashboard', 'ড্যাশবোর্ডে যান')}</Link>
            )}
          </Button>
        </div>
      </AuthScreen>
    )
  }

  if (!token || verify.error?.kind === 'invalid-token') {
    return (
      <AuthScreen
        title={content('This link doesn’t work', 'এই লিংকটি কাজ করছে না')}
        description={content(
          'Verification links work once, for 1 hour. Enter your email and we’ll send a new one.',
          'যাচাই লিংক একবারই, ১ ঘণ্টার জন্য কাজ করে। আপনার ইমেইল দিন, নতুন একটি পাঠিয়ে দেব।',
        )}
        footer={loginLink}
      >
        <div className="flex flex-col gap-4">
          <AuthAlert kind="invalid-token">
            {token
              ? content('This verification link has expired or is not valid.', 'এই যাচাই লিংকের মেয়াদ শেষ বা এটি সঠিক নয়।')
              : content('This verification link is incomplete.', 'এই যাচাই লিংকটি অসম্পূর্ণ।')}
          </AuthAlert>
          <ResendVerification />
        </div>
      </AuthScreen>
    )
  }

  if (verify.error) {
    return (
      <AuthScreen 
        title={content('We couldn’t verify your email', 'ইমেইল যাচাই করা যায়নি')}
        description={content('The link may still work. Try again.', 'লিংকটি হয়তো এখনও কাজ করবে। আবার চেষ্টা করুন।')}
        footer={loginLink}
      >
        <div className="flex flex-col gap-4">
          <AuthAlert kind={verify.error.kind}>{authErrorMessage(verify.error, content)}</AuthAlert>
          <Button className="h-11 w-full" onClick={() => mutate(token)}>
            {content('Try again', 'আবার চেষ্টা করুন')}
          </Button>
        </div>
      </AuthScreen>
    )
  }

  return (
    <AuthScreen
      title={content('Verifying your email…', 'ইমেইল যাচাই হচ্ছে…')}
      description={content('This takes a second.', 'এক মুহূর্ত অপেক্ষা করুন।')}
      footer={null}
    >
      <p role="status" className="flex justify-center py-2">
        <LoaderCircle className="size-8 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
        <span className="sr-only">{content('Verifying your email…', 'ইমেইল যাচাই হচ্ছে…')}</span>
      </p>
    </AuthScreen>
  )
}

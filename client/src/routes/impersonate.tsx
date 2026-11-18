import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Ban, Clock, Link2Off, Loader2, ServerCrash, ShieldAlert, UserX, WifiOff, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { useLanguage } from '@/hooks/use-language'
import {
  exchangeImpersonationToken,
  ImpersonationExchangeError,
  isRetryable,
  validateImpersonateSearch,
  type ImpersonationFailure,
} from '@/lib/impersonation'

/**
 * Landing page for the admin panel's "Login as Client" (M2-T13). It runs only in the browser
 * (`ssr: false`): the server never calls the backend with the token, and no loader sees it.
 * Flow: keep the token in state → strip it from the URL (replace) → POST it once → drop every cached
 * query (the session and anything cached under a previous user) → /dashboard.
 */
export const Route = createFileRoute('/impersonate')({
  ssr: false,
  validateSearch: validateImpersonateSearch,
  head: () => ({ meta: [{ title: 'Signing in | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  pendingComponent: SigningIn,
  component: ImpersonatePage,
})

function ImpersonatePage() {
  const { token: tokenInUrl } = Route.useSearch()
  // Captured on the first render, before the URL is cleaned. The token is single-use.
  const [token] = useState(tokenInUrl)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const started = useRef(false)

  const exchange = useMutation({
    mutationFn: exchangeImpersonationToken,
    onSuccess: async () => {
      queryClient.removeQueries()
      await navigate({ to: '/dashboard', replace: true })
    },
  })
  const { mutate } = exchange

  useEffect(() => {
    // StrictMode runs effects twice on mount; the ref survives, so the token is posted exactly once.
    if (started.current || !token) return
    started.current = true
    // Clean the address bar (and the Referer) before the token goes anywhere.
    void navigate({ to: Route.fullPath, search: {}, replace: true }).finally(() => mutate(token))
  }, [token, navigate, mutate])

  if (!token) return <ExchangeError reason="missing" />
  if (exchange.isError) {
    const reason = exchange.error instanceof ImpersonationExchangeError ? exchange.error.reason : 'server'
    return (
      <ExchangeError
        reason={reason}
        onRetry={isRetryable(reason) ? () => mutate(token) : undefined}
      />
    )
  }
  return <SigningIn />
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-4 sm:p-6">
      <Card className="w-full max-w-md rounded-3xl">{children}</Card>
    </main>
  )
}

function SigningIn() {
  const { content } = useLanguage()
  return (
    <Screen>
      <CardHeader className="items-center text-center" role="status" aria-live="polite">
        <Loader2 className="mx-auto size-10 animate-spin text-primary" aria-hidden />
        <CardTitle className="text-xl">
          {content('Opening the client workspace…', 'ক্লায়েন্টের ওয়ার্কস্পেস খোলা হচ্ছে…')}
        </CardTitle>
        <CardDescription>
          {content(
            'Signing you in as the workspace owner. This takes a second.',
            'আপনাকে ওয়ার্কস্পেস মালিক হিসেবে লগ ইন করানো হচ্ছে। এক মুহূর্ত অপেক্ষা করুন।',
          )}
        </CardDescription>
      </CardHeader>
    </Screen>
  )
}

interface FailureCopy {
  icon: LucideIcon
  title: string
  body: string
}

function useFailureCopy(reason: ImpersonationFailure): FailureCopy {
  const { content } = useLanguage()
  const askAgain = content(
    'Go back to the admin panel and click "Login as Client" again.',
    'অ্যাডমিন প্যানেলে ফিরে গিয়ে আবার "Login as Client" ক্লিক করুন।',
  )
  switch (reason) {
    case 'missing':
      return {
        icon: Link2Off,
        title: content('This login link is incomplete', 'এই লগইন লিংকটি অসম্পূর্ণ'),
        body: `${content('The link has no sign-in token.', 'লিংকে কোনো সাইন-ইন টোকেন নেই।')} ${askAgain}`,
      }
    case 'invalid':
      return {
        icon: Link2Off,
        title: content('This login link is not valid', 'এই লগইন লিংকটি সঠিক নয়'),
        body: `${content(
          'It looks broken or was copied only in part.',
          'লিংকটি ভাঙা বা আংশিক কপি করা হয়েছে বলে মনে হচ্ছে।',
        )} ${askAgain}`,
      }
    case 'expired':
      return {
        icon: Clock,
        title: content('This login link has expired or was already used', 'এই লগইন লিংকের মেয়াদ শেষ বা এটি আগেই ব্যবহার হয়েছে'),
        body: `${content(
          'Each link works once, within 60 seconds.',
          'প্রতিটি লিংক মাত্র একবার, ৬০ সেকেন্ডের মধ্যে কাজ করে।',
        )} ${askAgain}`,
      }
    case 'forbidden':
      return {
        icon: ShieldAlert,
        title: content('Admin access was removed', 'অ্যাডমিন অ্যাক্সেস বাতিল হয়েছে'),
        body: content(
          'The admin who created this link is no longer a super admin, so the login was refused.',
          'যে অ্যাডমিন লিংকটি তৈরি করেছেন তিনি আর সুপার অ্যাডমিন নন, তাই লগইন প্রত্যাখ্যান করা হয়েছে।',
        ),
      }
    case 'not-found':
      return {
        icon: UserX,
        title: content('Workspace not found', 'ওয়ার্কস্পেস পাওয়া যায়নি'),
        body: content(
          'This workspace no longer exists. Check the client list in the admin panel.',
          'এই ওয়ার্কস্পেসটি আর নেই। অ্যাডমিন প্যানেলে ক্লায়েন্ট তালিকা দেখুন।',
        ),
      }
    case 'suspended':
      return {
        icon: Ban,
        title: content('This workspace is suspended', 'এই ওয়ার্কস্পেসটি স্থগিত'),
        body: content(
          'Suspended workspaces can’t be opened. Reactivate it in the admin panel first.',
          'স্থগিত ওয়ার্কস্পেস খোলা যায় না। আগে অ্যাডমিন প্যানেল থেকে এটি আবার চালু করুন।',
        ),
      }
    case 'no-owner':
      return {
        icon: UserX,
        title: content('No owner to sign in as', 'লগ ইন করার মতো কোনো মালিক নেই'),
        body: content(
          'This workspace has no active owner account, so there is no one to log in as.',
          'এই ওয়ার্কস্পেসে কোনো সক্রিয় মালিক অ্যাকাউন্ট নেই, তাই কারো হয়ে লগ ইন করা যাচ্ছে না।',
        ),
      }
    case 'rate-limited':
      return {
        icon: Clock,
        title: content('Too many attempts', 'অনেকবার চেষ্টা করা হয়েছে'),
        body: content('Wait a moment, then try again.', 'কিছুক্ষণ অপেক্ষা করে আবার চেষ্টা করুন।'),
      }
    case 'network':
      return {
        icon: WifiOff,
        title: content('Can’t reach ShieldComment', 'ShieldComment-এ সংযোগ করা যাচ্ছে না'),
        body: content(
          'Check your internet connection and try again.',
          'ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
        ),
      }
    case 'server':
      return {
        icon: ServerCrash,
        title: content('Something went wrong', 'কিছু একটা সমস্যা হয়েছে'),
        body: content(
          'The server couldn’t finish the login. Try again in a moment.',
          'সার্ভার লগইন সম্পন্ন করতে পারেনি। একটু পরে আবার চেষ্টা করুন।',
        ),
      }
  }
}

/** A retry shows the "signing in" screen again (the mutation is pending, no longer in error). */
function ExchangeError({ reason, onRetry }: { reason: ImpersonationFailure; onRetry?: () => void }) {
  const { content } = useLanguage()
  const { icon: Icon, title, body } = useFailureCopy(reason)
  return (
    <Screen>
      <CardHeader className="items-center text-center">
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <Icon className="size-7" aria-hidden />
        </span>
        <CardTitle>
          <h1 className="text-xl font-semibold text-balance">{title}</h1>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-center text-sm text-pretty text-muted-foreground" role="alert" data-reason={reason}>
          {body}
        </p>
      </CardContent>
      <CardFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">
        <Button asChild variant={onRetry ? 'outline' : 'default'} className="h-10 w-full px-5 sm:w-auto">
          <Link to="/login">{content('Go to login', 'লগইনে যান')}</Link>
        </Button>
        {onRetry && (
          <Button className="h-10 w-full px-5 sm:w-auto" onClick={onRetry}>
            {content('Try again', 'আবার চেষ্টা করুন')}
          </Button>
        )}
      </CardFooter>
    </Screen>
  )
}

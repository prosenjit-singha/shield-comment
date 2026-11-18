import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowRight, Check } from 'lucide-react'
import {
  ImpersonationConnectNotice,
  MetaConnectButton,
  MetaConnectError,
} from '@/components/meta/meta-connect'
import { MetaNotice, MetaReturnNotices, PagesLoadErrorNotice } from '@/components/meta/meta-notice'
import { PageLimitPill } from '@/components/meta/page-identity'
import { PageToggleRow } from '@/components/meta/page-toggle-row'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import { useMetaConnect } from '@/hooks/use-meta-connect'
import type { ApiError } from '@/lib/api'
import {
  togglePage,
  validateMetaReturnSearch,
  workspacePagesQueryKey,
  workspacePagesQueryOptions,
  type MetaReturnSearch,
  type TogglePageResponse,
  type WorkspacePage,
} from '@/lib/meta-pages'
import { cn } from '@/lib/utils'

/**
 * C3 onboarding wizard (M3-T10): 1 connect Facebook (+ the Instagram accounts linked to its Pages, D4)
 * → 2 switch on the Pages to protect (plan limit, D10) → 3 finish → /dashboard. Skippable at any time.
 * Shown after sign-in / sign-up while the workspace has 0 active Pages (D13, `postAuthDestination`);
 * the OAuth callback returns here with `?meta=connected[&skipped=N]` or `?meta=error&reason=…` (D6).
 * Impersonated sessions can't connect (D5: backend 403) but may toggle Pages.
 */
export const Route = createFileRoute('/_app/onboarding')({
  validateSearch: (search: Record<string, unknown>): MetaReturnSearch => validateMetaReturnSearch(search),
  head: () => ({ meta: [{ title: 'Get started | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: OnboardingPage,
})

interface ToggleVariables {
  page: WorkspacePage
  isActive: boolean
}

function OnboardingPage() {
  const { session } = Route.useRouteContext()
  const search = Route.useSearch()
  const { content } = useLanguage()
  const workspaceId = session.session.activeOrganizationId
  const impersonated = Boolean(session.session.impersonatedBy)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 py-2 sm:py-6">
      <header className="flex flex-col gap-2 text-center sm:text-left">
        <p className="text-sm font-medium text-primary">{content('Get started', 'শুরু করুন')}</p>
        <h1 className="text-2xl font-semibold text-balance sm:text-3xl">
          {content('Connect your Facebook Page and Instagram', 'আপনার ফেসবুক পেজ ও ইনস্টাগ্রাম কানেক্ট করুন')}
        </h1>
        <p className="text-sm text-pretty text-muted-foreground">
          {content(
            'ShieldComment hides scam and abusive comments on the Pages and Instagram accounts you connect.',
            'আপনি যে পেজ ও ইনস্টাগ্রাম অ্যাকাউন্ট কানেক্ট করবেন, সেখানে ShieldComment স্ক্যাম ও আপত্তিকর কমেন্ট হাইড করবে।',
          )}
        </p>
      </header>
      {workspaceId ? (
        <OnboardingWizard workspaceId={workspaceId} impersonated={impersonated} search={search} />
      ) : (
        <>
          <MetaNotice tone="error" kind="no-workspace">
            {content(
              'Your account has no active workspace yet, so nothing can be connected. Contact support.',
              'আপনার অ্যাকাউন্টে এখনো কোনো সক্রিয় ওয়ার্কস্পেস নেই, তাই কিছু কানেক্ট করা যাচ্ছে না। সাপোর্টে যোগাযোগ করুন।',
            )}
          </MetaNotice>
          <WizardFooter canFinish={false} />
        </>
      )}
    </div>
  )
}

function OnboardingWizard({
  workspaceId,
  impersonated,
  search,
}: {
  workspaceId: string
  impersonated: boolean
  search: MetaReturnSearch
}) {
  const { content } = useLanguage()
  const queryClient = useQueryClient()
  const pages = useQuery(workspacePagesQueryOptions(workspaceId))

  const connect = useMetaConnect(workspaceId, '/onboarding')

  // No optimistic update here (that's C6): the switch moves once the refetched list says so. The PATCH
  // answer has no `pageLimit`, so the list (+ count) is always refetched, after errors too (a 409 means
  // our copy was stale).
  const toggle = useMutation<TogglePageResponse, ApiError, ToggleVariables>({
    mutationFn: ({ page, isActive }) => togglePage(workspaceId, page.id, isActive),
    onSettled: () => queryClient.invalidateQueries({ queryKey: workspacePagesQueryKey(workspaceId) }),
  })

  const items = pages.data?.items ?? []
  const pageLimit = pages.data?.pageLimit
  const connected = items.length > 0
  const activeCount = pageLimit?.activeCount ?? 0
  const currentStep = !connected ? 1 : activeCount === 0 ? 2 : 3

  return (
    <>
      <Stepper current={currentStep} />

      <MetaReturnNotices search={search} />

      <Card className="gap-4 rounded-3xl">
        <CardHeader className="gap-1.5">
          <CardTitle>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <StepBadge step={1} done={connected} />
              {connected
                ? content('Facebook connected', 'ফেসবুক কানেক্ট হয়েছে')
                : content('Connect Facebook', 'ফেসবুক কানেক্ট করুন')}
            </h2>
          </CardTitle>
          <CardDescription className="text-pretty">
            {connected
              ? content(
                  'Added a Page or linked an Instagram account on Facebook? Reconnect to bring it in.',
                  'ফেসবুকে নতুন পেজ যোগ করেছেন বা ইনস্টাগ্রাম অ্যাকাউন্ট যুক্ত করেছেন? সেটি আনতে আবার কানেক্ট করুন।',
                )
              : content(
                  'Log in with Facebook and pick the Pages to protect. Instagram business accounts linked to those Pages come along automatically.',
                  'ফেসবুক দিয়ে লগ ইন করে যে পেজগুলো সুরক্ষিত রাখতে চান সেগুলো বেছে নিন। ওই পেজগুলোর সাথে যুক্ত ইনস্টাগ্রাম বিজনেস অ্যাকাউন্টও স্বয়ংক্রিয়ভাবে যুক্ত হবে।',
                )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!connected && (
            <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                {content('You are an admin of the Facebook Page.', 'আপনি ফেসবুক পেজটির অ্যাডমিন।')}
              </li>
              <li className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                {content(
                  'For Instagram: a Business or Creator account linked to that Page.',
                  'ইনস্টাগ্রামের জন্য: ওই পেজের সাথে যুক্ত একটি বিজনেস বা ক্রিয়েটর অ্যাকাউন্ট।',
                )}
              </li>
            </ul>
          )}
          {impersonated ? (
            <ImpersonationConnectNotice />
          ) : (
            <div>
              <MetaConnectButton
                connect={connect}
                variant={connected ? 'outline' : 'default'}
                label={
                  connected
                    ? content('Reconnect Facebook', 'আবার ফেসবুক কানেক্ট করুন')
                    : content('Continue with Facebook', 'ফেসবুক দিয়ে চালিয়ে যান')
                }
              />
            </div>
          )}
          <MetaConnectError connect={connect} />
        </CardContent>
      </Card>

      <Card className="gap-4 rounded-3xl">
        <CardHeader className="gap-1.5">
          <CardTitle>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <StepBadge step={2} done={activeCount > 0} />
              {content('Choose Pages to protect', 'কোন পেজ সুরক্ষিত রাখবেন বেছে নিন')}
            </h2>
          </CardTitle>
          <CardDescription className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-pretty">
              {content(
                'New Pages start switched off. Switch on the ones ShieldComment should watch.',
                'নতুন পেজ বন্ধ অবস্থায় থাকে। যেগুলো ShieldComment নজরে রাখবে সেগুলো চালু করুন।',
              )}
            </span>
            {pageLimit ? <PageLimitPill pageLimit={pageLimit} /> : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pages.isPending ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              <Skeleton className="h-16 w-full rounded-2xl" />
              <Skeleton className="h-16 w-full rounded-2xl" />
            </div>
          ) : pages.isError ? (
            <PagesLoadErrorNotice error={pages.error} retrying={pages.isFetching} onRetry={() => void pages.refetch()} />
          ) : items.length === 0 ? (
            <p className="rounded-2xl border border-dashed px-4 py-6 text-center text-sm text-pretty text-muted-foreground">
              {search.meta === 'connected'
                ? content(
                    'Facebook didn’t share any Pages with us. Reconnect and select at least one Page in the Facebook window.',
                    'ফেসবুক আমাদের সাথে কোনো পেজ শেয়ার করেনি। আবার কানেক্ট করে ফেসবুকের উইন্ডোতে অন্তত একটি পেজ সিলেক্ট করুন।',
                  )
                : content(
                    'Your Pages will show up here after you connect Facebook.',
                    'ফেসবুক কানেক্ট করার পর আপনার পেজগুলো এখানে দেখাবে।',
                  )}
            </p>
          ) : (
            <ul className="flex flex-col gap-3" aria-label={content('Your Pages', 'আপনার পেজসমূহ')}>
              {items.map((page) => (
                <PageToggleRow
                  key={page.id}
                  page={page}
                  disabled={toggle.isPending}
                  pending={toggle.isPending && toggle.variables?.page.id === page.id}
                  failure={
                    !toggle.isPending && toggle.error && toggle.variables?.page.id === page.id
                      ? { error: toggle.error, target: toggle.variables.isActive }
                      : null
                  }
                  onToggle={(isActive) => toggle.mutate({ page, isActive })}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <WizardFooter canFinish={activeCount > 0} />
    </>
  )
}

function StepBadge({ step, done }: { step: number; done: boolean }) {
  return (
    <span
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
        done ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
      )}
      aria-hidden
    >
      {done ? <Check className="size-4" /> : step}
    </span>
  )
}

function Stepper({ current }: { current: 1 | 2 | 3 }) {
  const { content } = useLanguage()
  const steps = [
    content('Connect', 'কানেক্ট'),
    content('Choose Pages', 'পেজ বাছাই'),
    content('Finish', 'শেষ'),
  ]
  return (
    <ol aria-label={content('Setup steps', 'সেটআপের ধাপ')} className="grid grid-cols-3 gap-2">
      {steps.map((label, index) => {
        const step = index + 1
        const state = step < current ? 'done' : step === current ? 'current' : 'upcoming'
        return (
          <li
            key={label}
            aria-current={state === 'current' ? 'step' : undefined}
            data-state={state}
            className={cn(
              'flex items-center justify-center gap-2 rounded-full border px-3 py-2 text-xs font-medium sm:text-sm',
              state === 'current' && 'border-primary bg-primary text-primary-foreground',
              state === 'done' && 'border-primary/30 bg-primary/10 text-primary',
              state === 'upcoming' && 'bg-card text-muted-foreground',
            )}
          >
            {state === 'done' ? <Check className="size-4" aria-hidden /> : null}
            <span className="truncate">{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

function WizardFooter({ canFinish }: { canFinish: boolean }) {
  const { content } = useLanguage()
  const finishLabel = content('Finish setup', 'সেটআপ শেষ করুন')
  return (
    <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
      <Button asChild variant="ghost" className="h-11 px-5">
        <Link to="/dashboard">{content('Skip for now', 'এখন থাক')}</Link>
      </Button>
      <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
        {canFinish ? (
          <Button asChild className="h-11 px-6">
            <Link to="/dashboard">
              {finishLabel}
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        ) : (
          <>
            <Button className="h-11 px-6" disabled aria-describedby="finish-hint">
              {finishLabel}
              <ArrowRight aria-hidden />
            </Button>
            <p id="finish-hint" className="text-center text-xs text-muted-foreground sm:text-right">
              {content('Switch on at least one Page to finish.', 'শেষ করতে অন্তত একটি পেজ চালু করুন।')}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

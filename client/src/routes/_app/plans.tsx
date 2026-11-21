import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { CircleAlert } from 'lucide-react'
import { useState } from 'react'
import { IntervalSwitch, PlanCard } from '@/components/plans/plan-card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import type { ApiError } from '@/lib/api'
import {
  billingSummaryQueryKey,
  billingSummaryQueryOptions,
  type BillingSummary,
  type SubscriptionInterval,
} from '@/lib/billing-summary'
import {
  formatNumber,
  planButtonVariant,
  plansQueryKey,
  plansQueryOptions,
  startTrial,
  trialErrorMessage,
  type PublicPlan,
} from '@/lib/plans'

/**
 * Client `/plans` (PR-T6; PR-D7, D9, D10, D13, D14, D17, D18; readings 5, 9): Monthly/Yearly switch with
 * "Save up to N%", one card per active plan in `sort_order` (the highlighted one stronger, with the
 * primary button), the best live discount as a struck list price + plain "50% off" text, limits and
 * features. A plan with a live trial shows "Start free N-day trial" while the account is
 * `trialEligible` (→ `/onboarding`); every other card links to its checkout on `/billing?plan=&interval=`
 * (M8-T11, D11; replaced PR-D13's "Contact us"). Sign-up lands here while the account has no plan
 * (`postAuthDestination`).
 */
export const Route = createFileRoute('/_app/plans')({
  head: () => ({ meta: [{ title: 'Plans | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: PlansPage,
})

function PlansPage() {
  const { session } = Route.useRouteContext()
  const { content, language } = useLanguage()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const workspaceId = session.session.activeOrganizationId ?? null
  const impersonated = Boolean(session.session.impersonatedBy)
  const [interval, setBillingInterval] = useState<SubscriptionInterval>('month')

  const plans = useQuery(plansQueryOptions)
  // Same key as the shell banner: no second request.
  const summary = useQuery({ ...billingSummaryQueryOptions(workspaceId ?? ''), enabled: workspaceId !== null })
  const trialEligible = summary.data?.trialEligible === true

  const trial = useMutation<BillingSummary, ApiError, string>({
    mutationFn: (planId) => startTrial(workspaceId ?? '', planId),
    onSuccess: async (next) => {
      if (workspaceId) queryClient.setQueryData(billingSummaryQueryKey(workspaceId), next)
      await navigate({ to: '/onboarding' })
    },
    // The trial may have ended or been used meanwhile: refresh what the cards are built from.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: plansQueryKey })
      if (workspaceId) void queryClient.invalidateQueries({ queryKey: billingSummaryQueryKey(workspaceId) })
    },
  })

  const data = plans.data
  const hasYearly = data?.items.some((plan) => plan.yearly !== null) ?? false
  const savePercent = data?.yearlySaveUpToPercent ?? 0

  return (
    <div className="flex flex-col gap-6 py-2 sm:py-6">
      <header className="flex flex-col items-center gap-2 text-center">
        <p className="text-sm font-medium text-primary">{content('Plans', 'প্ল্যান')}</p>
        <h1 className="text-2xl font-semibold text-balance sm:text-3xl">
          {content('Choose the plan for your business', 'আপনার ব্যবসার জন্য প্ল্যান বেছে নিন')}
        </h1>
        <p className="max-w-xl text-sm text-pretty text-muted-foreground">
          {content(
            'Every plan hides scam, poaching and abusive comments in Bangla, Banglish and English.',
            'প্রতিটি প্ল্যানে বাংলা, বাংলিশ ও ইংরেজিতে স্ক্যাম, কাস্টমার টানা ও আপত্তিকর কমেন্ট হাইড হয়।',
          )}
        </p>
        {hasYearly ? <IntervalSwitch interval={interval} onChange={setBillingInterval} savePercent={savePercent} className="mt-2" /> : null}
      </header>

      {trial.error ? (
        <div
          role="alert"
          className="mx-auto flex w-full max-w-2xl items-start gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-foreground"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <p>{trialErrorMessage(trial.error, content, impersonated)}</p>
        </div>
      ) : null}

      {plans.isPending ? (
        <div className="grid gap-4 md:grid-cols-3" aria-hidden>
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-96 rounded-3xl" />
          ))}
        </div>
      ) : plans.isError ? (
        <div role="alert" className="mx-auto flex flex-col items-center gap-3 rounded-2xl border bg-card px-6 py-5 text-center text-sm">
          <p>{content('Couldn’t load the plans.', 'প্ল্যানগুলো লোড করা যায়নি।')}</p>
          <Button variant="outline" onClick={() => void plans.refetch()}>
            {content('Try again', 'আবার চেষ্টা করুন')}
          </Button>
        </div>
      ) : data && data.items.length > 0 ? (
        <ul className="grid gap-4 md:grid-cols-3">
          {data.items.map((plan) => (
            <PlanCard key={plan.id} plan={plan} interval={interval} language={language}>
              <PlanAction
                plan={plan}
                showTrial={plan.trial !== null && trialEligible}
                interval={plan.yearly && interval === 'year' ? 'year' : 'month'}
                trialPending={trial.isPending && trial.variables === plan.id}
                trialDisabled={trial.isPending}
                onStartTrial={() => trial.mutate(plan.id)}
              />
            </PlanCard>
          ))}
        </ul>
      ) : (
        <p className="text-center text-sm text-muted-foreground">
          {content('No plans are available right now.', 'এই মুহূর্তে কোনো প্ল্যান নেই।')}
        </p>
      )}
    </div>
  )
}

/** The card's button: "Start free N-day trial" while trial-eligible, else "Choose <plan>" → its checkout. */
function PlanAction({
  plan,
  showTrial,
  interval,
  trialPending,
  trialDisabled,
  onStartTrial,
}: {
  plan: PublicPlan
  showTrial: boolean
  interval: SubscriptionInterval
  trialPending: boolean
  trialDisabled: boolean
  onStartTrial: () => void
}) {
  const { content } = useLanguage()
  const variant = planButtonVariant(plan)
  if (showTrial && plan.trial)
    return (
      <div className="flex flex-col gap-1.5">
        <Button variant={variant} size="lg" className="w-full" disabled={trialDisabled} onClick={onStartTrial}>
          {trialPending
            ? content('Starting trial…', 'ট্রায়াল শুরু হচ্ছে…')
            : content(`Start free ${plan.trial.days}-day trial`, `${formatNumber(plan.trial.days, 'bn')} দিনের ফ্রি ট্রায়াল শুরু করুন`)}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {content(
            `${formatNumber(plan.trial.commentLimit, 'en')} comments included. No payment needed.`,
            `${formatNumber(plan.trial.commentLimit, 'bn')}টি কমেন্ট সহ। কোনো পেমেন্ট লাগবে না।`,
          )}
        </p>
      </div>
    )
  return (
    <Button asChild variant={variant} size="lg" className="w-full">
      <Link to="/billing" search={{ plan: plan.slug, interval }}>
        {content(`Choose ${plan.name}`, `${plan.name} বেছে নিন`)}
      </Link>
    </Button>
  )
}

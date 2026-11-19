import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Check, CircleAlert, MessageCircle, Minus } from 'lucide-react'
import { useId, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useLanguage } from '@/hooks/use-language'
import type { ApiError } from '@/lib/api'
import type { Language } from '@/lib/language'
import {
  billingSummaryQueryKey,
  billingSummaryQueryOptions,
  type BillingSummary,
  type SubscriptionInterval,
} from '@/lib/billing-summary'
import {
  contactWhatsappHref,
  featureLabel,
  formatNumber,
  formatTaka,
  limitLabel,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  plansQueryKey,
  plansQueryOptions,
  startTrial,
  trialErrorMessage,
  type PublicPlan,
} from '@/lib/plans'
import { cn } from '@/lib/utils'

/**
 * Client `/plans` (PR-T6; PR-D7, D9, D10, D13, D14, D17, D18; readings 5, 9): Monthly/Yearly switch with
 * "Save up to N%", one card per active plan in `sort_order` (the highlighted one stronger, with the
 * primary button), the best live discount as a struck list price + plain "50% off" text, limits and
 * features. A plan with a live trial shows "Start free N-day trial" while the account is
 * `trialEligible` (→ `/onboarding`); every other card shows "Contact us" (WhatsApp, hidden without a
 * number) until Module 8 checkout. Sign-up lands here while the account has no plan (`postAuthDestination`).
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
  const switchId = useId()
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
        {hasYearly ? (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3 text-sm font-medium">
            <label htmlFor={switchId} className={cn(interval === 'month' ? 'text-foreground' : 'text-muted-foreground')}>
              {content('Monthly', 'মাসিক')}
            </label>
            <Switch
              id={switchId}
              checked={interval === 'year'}
              onCheckedChange={(checked) => setBillingInterval(checked ? 'year' : 'month')}
              aria-label={content('Bill yearly', 'বার্ষিক বিল')}
            />
            <span className={cn(interval === 'year' ? 'text-foreground' : 'text-muted-foreground')}>
              {content('Yearly', 'বার্ষিক')}
            </span>
            {savePercent > 0 ? (
              <span className="text-primary" data-testid="save-up-to">
                {content(`Save up to ${savePercent}%`, `${formatNumber(savePercent, 'bn')}% পর্যন্ত সাশ্রয়`)}
              </span>
            ) : null}
          </div>
        ) : null}
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
            <PlanCard
              key={plan.id}
              plan={plan}
              interval={interval}
              showTrial={plan.trial !== null && trialEligible}
              contactHref={contactWhatsappHref(data.contactWhatsapp, plan.name, plan.yearly && interval === 'year' ? 'year' : 'month', content)}
              trialPending={trial.isPending && trial.variables === plan.id}
              trialDisabled={trial.isPending}
              onStartTrial={() => trial.mutate(plan.id)}
              language={language}
            />
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

function PlanCard({
  plan,
  interval,
  showTrial,
  contactHref,
  trialPending,
  trialDisabled,
  onStartTrial,
  language,
}: {
  plan: PublicPlan
  interval: SubscriptionInterval
  showTrial: boolean
  contactHref: string | null
  trialPending: boolean
  trialDisabled: boolean
  onStartTrial: () => void
  language: Language
}) {
  const { content } = useLanguage()
  const titleId = useId()
  const yearly = interval === 'year' && plan.yearly !== null
  const price = yearly && plan.yearly ? plan.yearly : plan.monthly
  const discounted = price.perMonthBdt !== price.listPerMonthBdt
  const variant = plan.highlighted ? 'default' : 'outline'
  const pick = (text: { en: string; bn: string } | null) => (text ? (language === 'bn' ? text.bn : text.en) : null)
  const badge = pick(plan.badge)
  const description = pick(plan.description)

  return (
    <li aria-labelledby={titleId} data-testid="plan-card" data-highlighted={plan.highlighted || undefined}>
      <Card
        className={cn(
          'h-full gap-5 rounded-3xl p-6',
          plan.highlighted ? 'shadow-lg ring-2 ring-primary' : 'ring-1 ring-foreground/10',
        )}
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <h2 id={titleId} className="text-lg font-semibold">
              {plan.name}
            </h2>
            {badge ? <Badge variant={plan.highlighted ? 'default' : 'outline'}>{badge}</Badge> : null}
          </div>
          {description ? <p className="text-sm text-pretty text-muted-foreground">{description}</p> : null}
        </div>

        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-3xl font-semibold tabular-nums">{formatTaka(price.perMonthBdt, language)}</span>
            <span className="text-sm text-muted-foreground">{content('/month', '/মাস')}</span>
            {discounted ? (
              <s className="text-sm text-muted-foreground tabular-nums" data-testid="list-price">
                {formatTaka(price.listPerMonthBdt, language)}
              </s>
            ) : null}
          </p>
          {price.saving ? (
            <p className="text-sm font-medium text-primary">{content(price.saving.label, price.saving.labelBn)}</p>
          ) : null}
          {yearly ? (
            <p className="text-xs text-muted-foreground">
              {content(
                `Billed ${formatTaka(price.chargedBdt, 'en')} yearly`,
                `বছরে ${formatTaka(price.chargedBdt, 'bn')} বিল`,
              )}
            </p>
          ) : interval === 'year' ? (
            <p className="text-xs text-muted-foreground">{content('Monthly billing only', 'শুধু মাসিক বিল')}</p>
          ) : null}
        </div>

        {showTrial && plan.trial ? (
          <div className="flex flex-col gap-1.5">
            <Button variant={variant} size="lg" className="w-full" disabled={trialDisabled} onClick={onStartTrial}>
              {trialPending
                ? content('Starting trial…', 'ট্রায়াল শুরু হচ্ছে…')
                : content(
                    `Start free ${plan.trial.days}-day trial`,
                    `${formatNumber(plan.trial.days, 'bn')} দিনের ফ্রি ট্রায়াল শুরু করুন`,
                  )}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {content(
                `${formatNumber(plan.trial.commentLimit, 'en')} comments included. No payment needed.`,
                `${formatNumber(plan.trial.commentLimit, 'bn')}টি কমেন্ট সহ। কোনো পেমেন্ট লাগবে না।`,
              )}
            </p>
          </div>
        ) : contactHref ? (
          <Button asChild variant={variant} size="lg" className="w-full">
            <a href={contactHref} target="_blank" rel="noopener noreferrer">
              <MessageCircle aria-hidden />
              {content('Contact us', 'যোগাযোগ করুন')}
            </a>
          </Button>
        ) : null}

        <ul className="flex flex-col gap-2 border-t pt-4 text-sm">
          {PLAN_LIMIT_KEYS.map((key) => (
            <li key={key} className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              {limitLabel(key, plan.limits[key], content, language)}
            </li>
          ))}
          {PLAN_FEATURE_KEYS.map((key) => {
            const included = plan.features[key]
            return (
              <li key={key} className={cn('flex items-start gap-2', !included && 'text-muted-foreground')}>
                {included ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                ) : (
                  <Minus className="mt-0.5 size-4 shrink-0" aria-hidden />
                )}
                <span>
                  {featureLabel(key, content)}
                  {included ? null : <span className="sr-only"> {content('(not included)', '(নেই)')}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      </Card>
    </li>
  )
}

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, CreditCard, Printer, X } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { DashboardError } from '@/components/dashboard/dashboard-charts'
import { MetaNotice } from '@/components/meta/meta-notice'
import { IntervalSwitch, PlanCard } from '@/components/plans/plan-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useLanguage } from '@/hooks/use-language'
import { toApiError, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import {
  autoRenewErrorMessage,
  checkoutErrorMessage,
  goToGateway,
  INVOICES_PAGE_SIZE,
  invoiceQueryOptions,
  invoicesQueryKey,
  invoicesQueryOptions,
  PAYMENT_POLL_MAX,
  paymentStatusQueryOptions,
  previewCoupon,
  promotionMonths,
  removeSavedCard,
  setAutoRenew,
  startCheckout,
  validateBillingSearch,
  type CheckoutInput,
  type CheckoutResult,
  type CouponPreview,
  type InvoiceStatus,
  type InvoiceView,
  type PaymentReturn,
} from '@/lib/billing'
import {
  billingSummaryQueryKey,
  billingSummaryQueryOptions,
  type AutoRenewView,
  type BillingSummary,
  type BillingSummaryStatus,
  type SubscriptionInterval,
} from '@/lib/billing-summary'
import { formatDhakaDate } from '@/lib/data-deletion'
import type { Language } from '@/lib/language'
import { formatNumber, formatTaka, planButtonVariant, plansQueryOptions, type PublicPlan } from '@/lib/plans'
import { teamQueryOptions } from '@/lib/team'

/**
 * C10 `/billing` (M8-T10; D2, D4–D7, M8-D7b, M8-D15). Current plan + status + comments bar from the
 * billing summary, renewal (D4: from 7 days before the end), pending / scheduled notices, auto-renew
 * (only when available), the `/plans` cards as a picker, coupon preview and "Pay" → SSLCommerz (or the
 * ৳0 path straight to the success state). `?payment=&tranId=` is the SSLCommerz return (M8-T5);
 * `pending` polls the payment until it settles. D2: only the owner pays; admins, moderators and
 * impersonated sessions read everything without the buttons (the role comes from `GET …/team`).
 * M8-T11 (D8, D11): `?plan=<slug>&interval=` preselects that plan and opens its checkout (owner only);
 * owner + admin see the invoices list; `?invoice=<id>` shows one invoice alone, printable (the shell
 * chrome is `print:hidden`, the browser's "Save as PDF" makes the PDF).
 */
export const Route = createFileRoute('/_app/billing')({
  head: () => ({ meta: [{ title: 'Billing | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  validateSearch: validateBillingSearch,
  component: BillingPage,
})

function BillingPage() {
  const { session } = Route.useRouteContext()
  const { content } = useLanguage()
  const workspaceId = session.session.activeOrganizationId
  const { invoice } = Route.useSearch()
  if (workspaceId && invoice) return <InvoiceDetail workspaceId={workspaceId} invoiceId={invoice} />
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{content('Billing', 'বিলিং')}</h1>
        <p className="text-sm text-muted-foreground">
          {content('Your plan, usage and payments. Pay with bKash, Nagad or card.', 'আপনার প্ল্যান, ব্যবহার ও পেমেন্ট। বিকাশ, নগদ বা কার্ডে পেমেন্ট করুন।')}
        </p>
      </div>
      {workspaceId ? (
        <BillingView workspaceId={workspaceId} userId={session.user.id} impersonated={Boolean(session.session.impersonatedBy)} />
      ) : (
        <p className="text-sm text-muted-foreground">{content('No workspace selected.', 'কোনো ওয়ার্কস্পেস বাছাই করা নেই।')}</p>
      )}
    </div>
  )
}

interface Selection {
  planId: string
  interval: SubscriptionInterval
}

function BillingView({ workspaceId, userId, impersonated }: { workspaceId: string; userId: string; impersonated: boolean }) {
  const { content, language } = useLanguage()
  const queryClient = useQueryClient()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const summary = useQuery(billingSummaryQueryOptions(workspaceId))
  const plans = useQuery(plansQueryOptions)
  const team = useQuery(teamQueryOptions(workspaceId))
  const [interval, setBillingInterval] = useState<SubscriptionInterval>(search.interval ?? 'month')
  const [picked, setSelected] = useState<string | null>(null)

  const role = team.data?.members.find((member) => member.userId === userId)?.role ?? null
  const canPay = role === 'owner' && !impersonated
  const readOnly = impersonated || (role !== null && role !== 'owner')
  const refreshSummary = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: billingSummaryQueryKey(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: invoicesQueryKey(workspaceId) }),
    ])

  // D11: `?plan=<slug>&interval=` (from /plans or the sign-up hand-off) until the owner picks another card.
  const preselected = plans.data?.items.find((plan) => plan.slug === search.plan)?.id ?? null
  const selected = picked ?? preselected
  useEffect(() => {
    if (preselected && canPay) document.getElementById('billing-checkout')?.scrollIntoView?.({ behavior: 'smooth' })
  }, [preselected, canPay])

  const selectedPlan = plans.data?.items.find((plan) => plan.id === selected) ?? null
  const selection: Selection | null = selectedPlan ? { planId: selectedPlan.id, interval: selectedPlan.yearly && interval === 'year' ? 'year' : 'month' } : null

  const renew = (data: BillingSummary) => {
    const current = plans.data?.items.find((plan) => plan.slug === data.plan?.slug)
    if (!current) return
    setSelected(current.id)
    setBillingInterval(data.interval ?? 'month')
    document.getElementById('billing-checkout')?.scrollIntoView?.({ behavior: 'smooth' })
  }

  return (
    <>
      {search.payment ? (
        <PaymentReturnNotice
          workspaceId={workspaceId}
          payment={search.payment}
          tranId={search.tranId}
          onSettled={() => void refreshSummary()}
          onDismiss={() => void navigate({ search: {}, replace: true })}
        />
      ) : null}
      {impersonated ? (
        <MetaNotice tone="info" kind="impersonation-read-only">
          {content(
            'You’re signed in as this client by support. Billing is read-only: nothing can be paid or changed in the client’s name.',
            'আপনি সাপোর্ট থেকে এই ক্লায়েন্ট হিসেবে লগ ইন করেছেন। বিলিং শুধু দেখা যাবে: ক্লায়েন্টের নামে কোনো পেমেন্ট বা পরিবর্তন করা যাবে না।',
          )}
        </MetaNotice>
      ) : readOnly ? (
        <MetaNotice tone="info" kind="owner-only">
          {content('Only the workspace owner can pay or change the plan.', 'শুধু ওয়ার্কস্পেসের মালিক পেমেন্ট বা প্ল্যান পরিবর্তন করতে পারেন।')}
        </MetaNotice>
      ) : null}

      {summary.isPending ? (
        <Skeleton data-testid="billing-skeleton" className="h-48 w-full rounded-3xl" />
      ) : summary.isError ? (
        <DashboardError
          title={content('Couldn’t load your billing', 'আপনার বিলিং লোড করা যায়নি')}
          message={toApiError(summary.error).isNetwork ? content('Check your connection and try again.', 'ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।') : content('Please try again.', 'আবার চেষ্টা করুন।')}
          onRetry={() => void summary.refetch()}
          retrying={summary.isFetching}
        />
      ) : (
        <>
          <SummaryCard summary={summary.data} canPay={canPay} canRenewWithPlans={plans.isSuccess} onRenew={() => renew(summary.data)} />
          {summary.data.autoRenew.available ? (
            <AutoRenewCard workspaceId={workspaceId} autoRenew={summary.data.autoRenew} canPay={canPay} onUnavailable={() => void refreshSummary()} />
          ) : null}
        </>
      )}

      <section aria-labelledby="billing-plans" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="billing-plans" className="text-lg font-semibold">
            {content('Plans', 'প্ল্যান')}
          </h2>
          {plans.data?.items.some((plan) => plan.yearly !== null) ? (
            <IntervalSwitch interval={interval} onChange={setBillingInterval} savePercent={plans.data.yearlySaveUpToPercent} />
          ) : null}
        </div>
        {plans.isPending ? (
          <div className="grid gap-4 md:grid-cols-3" aria-hidden>
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-96 rounded-3xl" />
            ))}
          </div>
        ) : plans.isError ? (
          <DashboardError
            title={content('Couldn’t load the plans', 'প্ল্যানগুলো লোড করা যায়নি')}
            message={content('Please try again.', 'আবার চেষ্টা করুন।')}
            onRetry={() => void plans.refetch()}
            retrying={plans.isFetching}
          />
        ) : (
          <ul className="grid gap-4 md:grid-cols-3">
            {plans.data.items.map((plan) => {
              const isCurrent = summary.data?.plan?.slug === plan.slug && (summary.data.status === 'ACTIVE' || summary.data.status === 'TRIALING')
              const isSelected = plan.id === selected
              return (
                <PlanCard key={plan.id} plan={plan} interval={interval} language={language} selected={isSelected}>
                  {isCurrent ? <p className="text-sm font-medium text-primary">{content('Your current plan', 'আপনার বর্তমান প্ল্যান')}</p> : null}
                  {canPay ? (
                    <Button
                      variant={isSelected ? 'default' : planButtonVariant(plan)}
                      size="lg"
                      className="w-full"
                      aria-pressed={isSelected}
                      onClick={() => setSelected(plan.id)}
                    >
                      {isSelected ? content('Selected', 'বাছাই করা হয়েছে') : content(`Choose ${plan.name}`, `${plan.name} বেছে নিন`)}
                    </Button>
                  ) : null}
                </PlanCard>
              )
            })}
          </ul>
        )}
      </section>

      {canPay && selectedPlan && selection ? (
        <CheckoutPanel
          // A new plan / interval starts a fresh coupon preview and checkout.
          key={`${selection.planId}:${selection.interval}`}
          workspaceId={workspaceId}
          plan={selectedPlan}
          selection={selection}
          language={language}
          onPaid={(tranId) => {
            void refreshSummary()
            void navigate({ search: { payment: 'success', tranId } })
          }}
        />
      ) : null}

      {role === 'owner' || role === 'admin' ? <InvoicesSection workspaceId={workspaceId} /> : null}
    </>
  )
}

const STATUS_LABEL: Record<BillingSummaryStatus, [string, string]> = {
  TRIALING: ['Trial', 'ট্রায়াল'],
  ACTIVE: ['Active', 'চালু'],
  EXPIRED: ['Expired', 'মেয়াদ শেষ'],
  CANCELED: ['Canceled', 'বাতিল'],
  NONE: ['No plan', 'কোনো প্ল্যান নেই'],
}

const intervalLabel = (interval: SubscriptionInterval, content: ContentFn) => (interval === 'year' ? content('Yearly', 'বার্ষিক') : content('Monthly', 'মাসিক'))

function SummaryCard({
  summary,
  canPay,
  canRenewWithPlans,
  onRenew,
}: {
  summary: BillingSummary
  canPay: boolean
  canRenewWithPlans: boolean
  onRenew: () => void
}) {
  const { content, language } = useLanguage()
  const live = summary.status === 'ACTIVE' || summary.status === 'TRIALING'
  const [en, bn] = STATUS_LABEL[summary.status]
  const date = (iso: string) => formatDhakaDate(iso, language)
  const termEnd = summary.renewal?.dueAt ?? summary.termEndsAt
  const { used, limit, resetsAt } = summary.comments
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0

  return (
    <Card className="gap-5 rounded-3xl p-6" data-testid="billing-summary">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{summary.plan?.name ?? content('No plan yet', 'এখনো কোনো প্ল্যান নেই')}</h2>
        <Badge variant={live ? 'default' : 'destructive'} data-testid="billing-status">
          {content(en, bn)}
        </Badge>
        {summary.interval && summary.status !== 'TRIALING' ? <Badge variant="outline">{intervalLabel(summary.interval, content)}</Badge> : null}
      </div>

      <p className="text-sm text-muted-foreground" data-testid="billing-term">
        {summary.status === 'TRIALING' && summary.trialEndsAt
          ? content(`Trial ends ${date(summary.trialEndsAt)}`, `ট্রায়াল শেষ হবে ${date(summary.trialEndsAt)}`)
          : summary.status === 'ACTIVE' && termEnd
            ? content(`Paid until ${date(termEnd)}`, `${date(termEnd)} পর্যন্ত পেমেন্ট করা আছে`)
            : summary.status !== 'NONE' && summary.termEndsAt
              ? content(`Ended ${date(summary.termEndsAt)}`, `${date(summary.termEndsAt)} তারিখে শেষ হয়েছে`)
              : content('You haven’t picked a plan yet.', 'আপনি এখনো কোনো প্ল্যান বেছে নেননি।')}
      </p>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="font-medium">{content('Comments this period', 'এই সময়ের কমেন্ট')}</span>
          <span className="tabular-nums text-muted-foreground">
            {limit > 0
              ? `${formatNumber(used, language)} / ${formatNumber(limit, language)}`
              : content('No allowance without an active plan', 'চালু প্ল্যান ছাড়া কোনো কমেন্ট নেই')}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={content('Comments used', 'ব্যবহৃত কমেন্ট')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div className={limit > 0 && used >= limit ? 'h-full rounded-full bg-destructive' : 'h-full rounded-full bg-primary'} style={{ width: `${percent}%` }} />
        </div>
        {resetsAt && limit > 0 ? (
          <p className="text-xs text-muted-foreground">{content(`Resets ${date(resetsAt)}`, `${date(resetsAt)} তারিখে নতুন করে শুরু হবে`)}</p>
        ) : null}
        <p className="text-xs text-muted-foreground tabular-nums">
          {content(
            `Pages ${formatNumber(summary.pages.used, 'en')} / ${formatNumber(summary.pages.limit, 'en')} · Workspaces ${formatNumber(summary.workspaces.used, 'en')} / ${formatNumber(summary.workspaces.limit, 'en')}`,
            `পেজ ${formatNumber(summary.pages.used, 'bn')} / ${formatNumber(summary.pages.limit, 'bn')} · ওয়ার্কস্পেস ${formatNumber(summary.workspaces.used, 'bn')} / ${formatNumber(summary.workspaces.limit, 'bn')}`,
          )}
        </p>
      </div>

      {summary.renewal && !summary.scheduled ? (
        summary.renewal.canRenew ? (
          <MetaNotice
            tone="warning"
            kind="renewal-open"
            action={
              canPay ? (
                <Button size="sm" className="h-9 shrink-0 px-4" onClick={onRenew} disabled={!canRenewWithPlans}>
                  {content('Renew', 'রিনিউ করুন')}
                </Button>
              ) : undefined
            }
          >
            {content(
              `Your term ends ${date(summary.renewal.dueAt)}. Renew now to keep moderation running; the new term starts when this one ends.`,
              `আপনার মেয়াদ শেষ হবে ${date(summary.renewal.dueAt)}। মডারেশন চালু রাখতে এখনই রিনিউ করুন; নতুন মেয়াদ এই মেয়াদ শেষ হলে শুরু হবে।`,
            )}
          </MetaNotice>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="renewal-closed">
            {content(
              `Renewal opens 7 days before ${date(summary.renewal.dueAt)}.`,
              `${date(summary.renewal.dueAt)} এর ৭ দিন আগে থেকে রিনিউ করা যাবে।`,
            )}
          </p>
        )
      ) : null}

      {summary.scheduled ? (
        <MetaNotice tone="info" kind="scheduled">
          {content(
            `Switches to ${summary.scheduled.planName} (${intervalLabel(summary.scheduled.interval, content)}) on ${date(summary.scheduled.startsAt)}. Already paid.`,
            `${date(summary.scheduled.startsAt)} তারিখে ${summary.scheduled.planName} (${intervalLabel(summary.scheduled.interval, content)}) প্ল্যানে বদলে যাবে। পেমেন্ট হয়ে গেছে।`,
          )}
        </MetaNotice>
      ) : null}

      {summary.pendingPayment ? (
        <MetaNotice tone="info" kind="pending-payment">
          {content(
            `A payment of ${formatTaka(summary.pendingPayment.amountBdt, 'en')} is in progress (transaction ${summary.pendingPayment.tranId}). If you closed the payment page, it’s cancelled after 60 minutes.`,
            `${formatTaka(summary.pendingPayment.amountBdt, 'bn')} এর একটি পেমেন্ট চলছে (ট্রানজেকশন ${summary.pendingPayment.tranId})। পেমেন্ট পেজ বন্ধ করে থাকলে ৬০ মিনিট পরে এটি বাতিল হয়ে যাবে।`,
          )}
        </MetaNotice>
      ) : null}

      {summary.status === 'TRIALING' ? (
        <p className="text-sm text-muted-foreground" data-kind="trial-to-paid">
          {content(
            'Paying now ends the trial: your paid term starts today with the plan’s full limits.',
            'এখন পেমেন্ট করলে ট্রায়াল শেষ হবে: পেইড মেয়াদ আজ থেকেই প্ল্যানের পুরো লিমিট নিয়ে শুরু হবে।',
          )}
        </p>
      ) : summary.status === 'ACTIVE' ? (
        <p className="text-sm text-muted-foreground" data-kind="no-grace">
          {content(
            'If the term ends unpaid, moderation pauses at once. Nothing is deleted.',
            'পেমেন্ট ছাড়া মেয়াদ শেষ হলে সাথে সাথে মডারেশন বন্ধ হবে। কিছুই মুছে যাবে না।',
          )}
        </p>
      ) : (
        <MetaNotice tone="warning" kind="paused">
          {content(
            'Moderation is paused. Choose a plan and pay to turn it back on. Nothing was deleted.',
            'মডারেশন বন্ধ আছে। আবার চালু করতে একটি প্ল্যান বেছে পেমেন্ট করুন। কিছুই মুছে যায়নি।',
          )}
        </MetaNotice>
      )}
    </Card>
  )
}

function AutoRenewCard({
  workspaceId,
  autoRenew,
  canPay,
  onUnavailable,
}: {
  workspaceId: string
  autoRenew: AutoRenewView
  canPay: boolean
  onUnavailable: () => void
}) {
  const { content } = useLanguage()
  const queryClient = useQueryClient()
  const switchId = useId()
  const save = (next: AutoRenewView) =>
    queryClient.setQueryData<BillingSummary>(billingSummaryQueryKey(workspaceId), (old) => (old ? { ...old, autoRenew: next } : old))
  const onError = (error: ApiError) => {
    if (error.code === 'AUTO_RENEW_UNAVAILABLE') onUnavailable()
  }
  const toggle = useMutation<AutoRenewView, ApiError, boolean>({ mutationFn: (enabled) => setAutoRenew(workspaceId, enabled), onSuccess: save, onError })
  const remove = useMutation<AutoRenewView, ApiError, void>({ mutationFn: () => removeSavedCard(workspaceId), onSuccess: save, onError })
  const error = toggle.error ?? remove.error
  const busy = toggle.isPending || remove.isPending

  return (
    <Card className="gap-4 rounded-3xl p-6" data-testid="auto-renew">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={switchId} className="text-base font-semibold">
          {content('Auto-renew', 'অটো-রিনিউ')}
        </label>
        <Switch
          id={switchId}
          checked={autoRenew.enabled}
          disabled={!canPay || busy}
          onCheckedChange={(checked) => {
            remove.reset()
            toggle.mutate(checked)
          }}
        />
      </div>
      <p className="text-sm text-pretty text-muted-foreground">
        {content(
          'When on, your card or mobile wallet is saved at your next payment. We charge it in the 24 hours before your term ends, with one retry. If that fails, renew by hand: we’ll email you.',
          'চালু থাকলে পরের পেমেন্টে আপনার কার্ড বা মোবাইল ওয়ালেট সেভ হবে। মেয়াদ শেষ হওয়ার আগের ২৪ ঘণ্টায় আমরা চার্জ করব, একবার আবার চেষ্টা সহ। তা ব্যর্থ হলে নিজে রিনিউ করুন: আমরা ইমেইল করব।',
        )}
      </p>
      {autoRenew.tokenSaved ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="flex items-center gap-2">
            <CreditCard className="size-4 text-muted-foreground" aria-hidden />
            {content('A card or wallet is saved.', 'একটি কার্ড বা ওয়ালেট সেভ করা আছে।')}
          </span>
          {canPay ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-4"
              disabled={busy}
              onClick={() => {
                toggle.reset()
                remove.mutate()
              }}
            >
              {content('Remove saved card', 'সেভ করা কার্ড মুছুন')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <MetaNotice tone="error" kind="auto-renew-error">
          {autoRenewErrorMessage(error, content)}
        </MetaNotice>
      ) : null}
    </Card>
  )
}

function CheckoutPanel({
  workspaceId,
  plan,
  selection,
  language,
  onPaid,
}: {
  workspaceId: string
  plan: PublicPlan
  selection: Selection
  language: Language
  onPaid: (tranId: string) => void
}) {
  const { content } = useLanguage()
  const couponId = useId()
  const [code, setCode] = useState('')
  const price = selection.interval === 'year' && plan.yearly ? plan.yearly : plan.monthly

  const coupon = useMutation<CouponPreview, ApiError, string>({
    mutationFn: (value) => previewCoupon(workspaceId, { ...selection, code: value }),
  })
  const checkout = useMutation<CheckoutResult, ApiError, CheckoutInput>({
    mutationFn: (input) => startCheckout(workspaceId, input),
    onSuccess: (result) => {
      if ('gatewayUrl' in result) goToGateway(result.gatewayUrl)
      else onPaid(result.tranId)
    },
  })
  const applied = coupon.isSuccess ? coupon.variables : undefined
  const leaving = checkout.isSuccess && 'gatewayUrl' in checkout.data

  const apply = (event: FormEvent) => {
    event.preventDefault()
    const value = code.trim()
    if (value) coupon.mutate(value)
  }

  return (
    <Card id="billing-checkout" className="gap-5 rounded-3xl p-6" data-testid="checkout">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{content('Checkout', 'চেকআউট')}</h2>
        <p className="text-sm text-muted-foreground" data-testid="checkout-plan">
          {`${plan.name} · ${intervalLabel(selection.interval, content)} · ${formatTaka(price.chargedBdt, language)}`}
        </p>
      </div>

      <form onSubmit={apply} className="flex flex-col gap-2">
        <label htmlFor={couponId} className="text-sm font-medium">
          {content('Coupon code', 'কুপন কোড')}
        </label>
        <div className="flex gap-2">
          <Input
            id={couponId}
            value={code}
            maxLength={64}
            autoComplete="off"
            className="h-10 px-4"
            aria-invalid={coupon.isError || undefined}
            onChange={(event) => {
              setCode(event.target.value)
              if (!coupon.isIdle) coupon.reset()
            }}
          />
          <Button type="submit" variant="outline" className="h-10 px-5" disabled={coupon.isPending || code.trim() === ''}>
            {content('Apply', 'প্রয়োগ করুন')}
          </Button>
        </div>
        {coupon.error ? (
          <p role="alert" className="text-sm text-destructive">
            {checkoutErrorMessage(coupon.error, content, false)}
          </p>
        ) : null}
      </form>

      {coupon.data ? <PriceLines preview={coupon.data} language={language} /> : null}

      <p className="text-xs text-pretty text-muted-foreground">
        {content(
          'Upgrades start today and the unused days of your paid term come off the price. A smaller plan or monthly billing can be picked in the 7 days before renewal and starts when the current term ends. The exact amount is shown on the SSLCommerz payment page.',
          'আপগ্রেড আজ থেকেই শুরু হয় এবং পেইড মেয়াদের বাকি দিনের দাম বাদ যায়। ছোট প্ল্যান বা মাসিক বিল রিনিউয়ের আগের ৭ দিনে বেছে নেওয়া যায় এবং বর্তমান মেয়াদ শেষ হলে শুরু হয়। সঠিক পরিমাণ SSLCommerz পেমেন্ট পেজে দেখানো হয়।',
        )}
      </p>

      {checkout.error ? (
        <MetaNotice tone="error" kind="checkout-error" network={checkout.error.isNetwork}>
          {checkoutErrorMessage(checkout.error, content, false)}
        </MetaNotice>
      ) : null}

      <Button
        size="lg"
        className="w-full sm:w-auto sm:self-start"
        disabled={checkout.isPending || leaving}
        onClick={() => checkout.mutate({ ...selection, ...(applied ? { couponCode: applied } : {}) })}
      >
        {checkout.isPending || leaving
          ? content('Opening the payment page…', 'পেমেন্ট পেজ খোলা হচ্ছে…')
          : content('Pay with bKash / Nagad / card', 'বিকাশ / নগদ / কার্ডে পেমেন্ট করুন')}
      </Button>
    </Card>
  )
}

function PriceLines({ preview, language }: { preview: CouponPreview; language: Language }) {
  const { content } = useLanguage()
  const { price } = preview
  const minus = (amount: number) => `− ${formatTaka(amount, language)}`
  const rows: [string, string, string][] = [['list', content('Plan price', 'প্ল্যানের দাম'), formatTaka(price.listChargedBdt, language)]]
  if (price.discount) rows.push(['discount', content(price.discount.label, price.discount.labelBn), minus(price.discount.amountBdt)])
  if (price.coupon)
    rows.push(['coupon', `${content('Coupon', 'কুপন')} ${price.coupon.code ?? ''} · ${content(price.coupon.label, price.coupon.labelBn)}`, minus(price.coupon.amountBdt)])
  if (price.creditBdt > 0) rows.push(['credit', content('Unused days of your current term', 'বর্তমান মেয়াদের বাকি দিন'), minus(price.creditBdt)])
  return (
    <dl className="flex flex-col gap-1.5 rounded-2xl bg-muted px-4 py-3 text-sm" data-testid="price-lines">
      {rows.map(([key, label, value]) => (
        <div key={key} className="flex justify-between gap-3" data-line={key}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="tabular-nums">{value}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-3 border-t pt-1.5 font-semibold" data-line="total">
        <dt>{content('To pay', 'মোট দিতে হবে')}</dt>
        <dd className="tabular-nums">{formatTaka(preview.amountBdt, language)}</dd>
      </div>
    </dl>
  )
}

/** M8-T5 return: success / failed / cancelled are final; `pending` polls the payment until it settles. */
function PaymentReturnNotice({
  workspaceId,
  payment,
  tranId,
  onSettled,
  onDismiss,
}: {
  workspaceId: string
  payment: PaymentReturn
  tranId: string | undefined
  onSettled: () => void
  onDismiss: () => void
}) {
  const { content } = useLanguage()
  const queryClient = useQueryClient()
  const options = paymentStatusQueryOptions(workspaceId, tranId ?? '')
  const status = useQuery({ ...options, enabled: payment === 'pending' && tranId !== undefined })
  // The observer result has no fetch count; `dataUpdatedAt` (read here) re-renders on every poll.
  const polls = status.dataUpdatedAt ? (queryClient.getQueryState(options.queryKey)?.dataUpdateCount ?? 0) : 0
  const settled = status.data?.status
  useEffect(() => {
    if (settled === 'PAID') onSettled()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per settled status
  }, [settled])

  let outcome: 'success' | 'failed' | 'cancelled' | 'confirming' | 'slow' | 'unknown'
  if (payment !== 'pending') outcome = payment
  else if (!tranId || status.isError) outcome = 'unknown'
  else if (!status.data) outcome = 'confirming'
  else if (settled === 'PAID') outcome = 'success'
  else if (settled === 'PENDING') outcome = polls >= PAYMENT_POLL_MAX ? 'slow' : 'confirming'
  else outcome = 'failed'

  const text: Record<typeof outcome, string> = {
    success: content('Payment received. Your plan is active.', 'পেমেন্ট পাওয়া গেছে। আপনার প্ল্যান চালু হয়েছে।'),
    failed: content('The payment didn’t go through, so nothing changed. You can try again.', 'পেমেন্ট সম্পন্ন হয়নি, তাই কিছুই বদলায়নি। আবার চেষ্টা করতে পারেন।'),
    cancelled: content('You cancelled the payment. Nothing was charged.', 'আপনি পেমেন্ট বাতিল করেছেন। কোনো টাকা কাটা হয়নি।'),
    confirming: content('Confirming your payment…', 'আপনার পেমেন্ট নিশ্চিত করা হচ্ছে…'),
    slow: content(
      'Still confirming your payment. This can take a few minutes: refresh this page later. Your plan turns on as soon as it’s confirmed.',
      'পেমেন্ট এখনো নিশ্চিত করা হচ্ছে। কয়েক মিনিট লাগতে পারে: পরে এই পেজটি রিফ্রেশ করুন। নিশ্চিত হলেই আপনার প্ল্যান চালু হবে।',
    ),
    unknown: content(
      'We couldn’t check this payment yet. Refresh this page in a few minutes.',
      'এই পেমেন্টটি এখনো যাচাই করা যায়নি। কয়েক মিনিট পরে পেজটি রিফ্রেশ করুন।',
    ),
  }
  const tone = outcome === 'success' ? 'success' : outcome === 'failed' ? 'error' : outcome === 'cancelled' ? 'warning' : 'info'

  return (
    <MetaNotice
      tone={tone}
      kind={`payment:${outcome}`}
      action={
        <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={content('Dismiss', 'বন্ধ করুন')} onClick={onDismiss}>
          <X aria-hidden />
        </Button>
      }
    >
      {text[outcome]}
      {tranId ? (
        <span className="block text-xs text-muted-foreground">
          {content('Transaction ID', 'ট্রানজেকশন আইডি')}: {tranId}
        </span>
      ) : null}
    </MetaNotice>
  )
}

const INVOICE_STATUS: Record<InvoiceStatus, [string, string]> = { PAID: ['Paid', 'পরিশোধিত'], REFUNDED: ['Refunded', 'ফেরত দেওয়া হয়েছে'] }

function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const { content } = useLanguage()
  const [en, bn] = INVOICE_STATUS[status]
  return (
    <Badge variant={status === 'REFUNDED' ? 'destructive' : 'outline'} data-testid="invoice-status" data-status={status}>
      {content(en, bn)}
    </Badge>
  )
}

/** D2: owner + admin only (the caller hides it for moderators). Newest first, `INVOICES_PAGE_SIZE` a page. */
function InvoicesSection({ workspaceId }: { workspaceId: string }) {
  const { content, language } = useLanguage()
  const [skip, setSkip] = useState(0)
  const invoices = useQuery({ ...invoicesQueryOptions(workspaceId, skip), placeholderData: keepPreviousData })
  const total = invoices.data?.total ?? 0

  return (
    <section aria-labelledby="billing-invoices" className="flex flex-col gap-4" data-testid="invoices">
      <h2 id="billing-invoices" className="text-lg font-semibold">
        {content('Invoices', 'ইনভয়েস')}
      </h2>
      {invoices.isPending ? (
        <Skeleton className="h-32 w-full rounded-3xl" />
      ) : invoices.isError ? (
        <DashboardError
          title={content('Couldn’t load your invoices', 'আপনার ইনভয়েস লোড করা যায়নি')}
          message={content('Please try again.', 'আবার চেষ্টা করুন।')}
          onRetry={() => void invoices.refetch()}
          retrying={invoices.isFetching}
        />
      ) : invoices.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{content('No invoices yet. Each payment adds one here.', 'এখনো কোনো ইনভয়েস নেই। প্রতিটি পেমেন্টের ইনভয়েস এখানে দেখাবে।')}</p>
      ) : (
        <>
          <Card className="gap-0 rounded-3xl p-2">
            <ul aria-label={content('Invoices', 'ইনভয়েস')}>
              {invoices.data.items.map((item) => (
                <li key={item.id} data-testid="invoice-row">
                  <Link
                    to="/billing"
                    search={{ invoice: item.id }}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl px-4 py-3 text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  >
                    <span className="font-medium tabular-nums">{item.invoiceNumber}</span>
                    <span className="flex-1 text-muted-foreground">
                      {`${formatDhakaDate(item.paidAt, language)} · ${item.plan.name} · ${intervalLabel(item.interval, content)}`}
                    </span>
                    <span className="tabular-nums">{formatTaka(item.amountBdt, language)}</span>
                    <InvoiceStatusBadge status={item.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          {total > INVOICES_PAGE_SIZE ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <Button variant="outline" size="sm" className="h-9 px-4" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - INVOICES_PAGE_SIZE))}>
                {content('Newer', 'নতুনগুলো')}
              </Button>
              <span className="tabular-nums text-muted-foreground" data-testid="invoices-page">
                {content(
                  `${skip + 1}–${Math.min(skip + INVOICES_PAGE_SIZE, total)} of ${total}`,
                  `${formatNumber(total, 'bn')}টির মধ্যে ${formatNumber(skip + 1, 'bn')}–${formatNumber(Math.min(skip + INVOICES_PAGE_SIZE, total), 'bn')}`,
                )}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-9 px-4"
                disabled={skip + INVOICES_PAGE_SIZE >= total}
                onClick={() => setSkip(skip + INVOICES_PAGE_SIZE)}
              >
                {content('Older', 'পুরোনোগুলো')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

/** `?invoice=<id>`: the invoice alone (D8), with Back + Print; both buttons stay off paper. */
function InvoiceDetail({ workspaceId, invoiceId }: { workspaceId: string; invoiceId: string }) {
  const { content } = useLanguage()
  const invoice = useQuery(invoiceQueryOptions(workspaceId, invoiceId))
  const missing = invoice.isError && [403, 404].includes(toApiError(invoice.error).status)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button asChild variant="outline" className="h-10 px-4">
          <Link to="/billing">
            <ArrowLeft aria-hidden />
            {content('Back to billing', 'বিলিংয়ে ফিরে যান')}
          </Link>
        </Button>
        {invoice.data ? (
          <Button className="h-10 px-4" onClick={() => window.print()}>
            <Printer aria-hidden />
            {content('Print or save as PDF', 'প্রিন্ট বা PDF হিসেবে সেভ করুন')}
          </Button>
        ) : null}
      </div>
      {invoice.isPending ? (
        <Skeleton className="h-96 w-full rounded-3xl" />
      ) : invoice.isError ? (
        <DashboardError
          title={content('Couldn’t load the invoice', 'ইনভয়েস লোড করা যায়নি')}
          message={missing ? content('This invoice isn’t available.', 'এই ইনভয়েসটি পাওয়া যাচ্ছে না।') : content('Please try again.', 'আবার চেষ্টা করুন।')}
          onRetry={() => void invoice.refetch()}
          retrying={invoice.isFetching}
        />
      ) : (
        <InvoiceDocument invoice={invoice.data} />
      )}
    </div>
  )
}

function InvoiceDocument({ invoice }: { invoice: InvoiceView }) {
  const { content, language } = useLanguage()
  const date = (iso: string) => formatDhakaDate(iso, language)
  const money = (amount: number) => formatTaka(amount, language)
  const minus = (amount: number) => `− ${money(amount)}`
  const { seller } = invoice
  const meta: [string, string, string][] = [
    ['date', content('Date paid', 'পেমেন্টের তারিখ'), date(invoice.paidAt)],
    ['plan', content('Plan', 'প্ল্যান'), `${invoice.plan.name} · ${intervalLabel(invoice.interval, content)}`],
    ['term', content('Term', 'মেয়াদ'), `${date(invoice.term.start)} – ${date(invoice.term.end)}`],
    [
      'method',
      content('Paid with', 'পেমেন্ট মাধ্যম'),
      invoice.gateway === 'PROMOTION' ? content('Promotion (nothing to pay)', 'প্রমোশন (কিছু দিতে হয়নি)') : invoice.gateway,
    ],
    ['tran', content('Transaction ID', 'ট্রানজেকশন আইডি'), invoice.tranId],
  ]
  const lines: [string, string, string][] = [['list', content('Plan price', 'প্ল্যানের দাম'), money(invoice.listPriceBdt)]]
  invoice.promotions.forEach((p, index) => {
    const label = [p.code ? `${content('Coupon', 'কুপন')} ${p.code}` : null, content(p.label, p.labelBn), promotionMonths(p.months, content)]
    lines.push([`promotion-${index}`, label.filter(Boolean).join(' · '), minus(p.amountOffBdt)])
  })
  if (invoice.creditBdt > 0) lines.push(['credit', content('Unused days of your previous term', 'আগের মেয়াদের বাকি দিন'), minus(invoice.creditBdt)])

  return (
    <Card className="gap-6 rounded-3xl p-6 sm:p-8 print:shadow-none print:ring-0" data-testid="invoice">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{content('Invoice', 'ইনভয়েস')}</h1>
          <p className="text-sm tabular-nums text-muted-foreground" data-testid="invoice-number">
            {invoice.invoiceNumber}
          </p>
        </div>
        <InvoiceStatusBadge status={invoice.status} />
      </div>

      {seller.name || seller.address ? (
        <div className="text-sm" data-testid="invoice-seller">
          {seller.name ? <p className="font-medium">{seller.name}</p> : null}
          {seller.address ? <p className="whitespace-pre-line text-muted-foreground">{seller.address}</p> : null}
        </div>
      ) : null}

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {meta.map(([key, label, value]) => (
          <div key={key} className="flex flex-col" data-meta={key}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>

      <dl className="flex flex-col gap-1.5 rounded-2xl bg-muted px-4 py-3 text-sm print:bg-transparent print:px-0" data-testid="invoice-lines">
        {lines.map(([key, label, value]) => (
          <div key={key} className="flex justify-between gap-3" data-line={key}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="shrink-0 tabular-nums">{value}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t pt-1.5 font-semibold" data-line="total">
          <dt>{content('Total paid', 'মোট পরিশোধিত')}</dt>
          <dd className="tabular-nums">{money(invoice.chargedBdt)}</dd>
        </div>
      </dl>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p data-testid="invoice-vat">{content('All prices include VAT.', 'সব দামে ভ্যাট অন্তর্ভুক্ত।')}</p>
        {invoice.status === 'REFUNDED' ? (
          <p>{content('This payment was refunded.', 'এই পেমেন্টটি ফেরত দেওয়া হয়েছে।')}</p>
        ) : null}
      </div>
    </Card>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { PillRadioGroup, type PillOption } from '@/components/clients/pill-radio-group'
import {
  type ActivatePlanResponse,
  activateClientPlan,
  activationErrorMessages,
  activationPricePreview,
  activationTermEnd,
  type AppliedPromotion,
  couponErrorMessages,
  hasYearlyPrice,
  startDateBounds,
  startDateError,
} from '@/lib/admin-activation'
import {
  type AdminClient,
  adminClientsKey,
  formatDhakaDate,
  REASON_MAX,
  reasonError,
  type SubscriptionInterval,
  subscriptionIntervalLabels,
} from '@/lib/admin-clients'
import { type AdminPlan, formatPlanPrice, plansQueryOptions } from '@/lib/admin-plans'
import { ApiError } from '@/lib/api'

/**
 * "Activate plan" (PW-T9, PW-D16): the super admin picks an active plan, Monthly / Yearly, a start
 * date (today − 31 days … today, Dhaka), a reason and an optional coupon (PR-T5). The backend ends
 * the account's live subscription, applies the best automatic discount + the coupon on top and
 * starts the new term with a fresh comment period; audit-logged. The dialog then shows what was
 * charged and what came off (no preview endpoint exists, so the saving shows after activating).
 */
export function ActivatePlanDialog({ client, onClose }: { client: AdminClient | null; onClose: () => void }) {
  return (
    <Dialog open={client !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Keyed so each opening starts from the defaults. */}
      {client && <ActivateForm key={client.id} client={client} onClose={onClose} />}
    </Dialog>
  )
}

/** Lead sentence: what the activation ends (nothing to end without a live plan). */
function activationLead(client: AdminClient): string {
  const sub = client.subscription
  const startsNew = 'starts the new term from the start date.'
  if (client.plan && sub?.status === 'TRIALING') return `Ends the ${client.plan.name} trial right away and ${startsNew}`
  if (client.plan && sub?.status === 'ACTIVE') {
    return `Ends ${client.plan.name} (${subscriptionIntervalLabels[sub.interval]}) right away and ${startsNew}`
  }
  return 'No active plan to end: starts the new term from the start date.'
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code && activationErrorMessages[err.code]) return activationErrorMessages[err.code] as string
    if (err.status === 404) return 'This client no longer exists.'
    return err.message
  }
  return err instanceof Error ? err.message : 'Could not activate the plan.'
}

function ActivateForm({ client, onClose }: { client: AdminClient; onClose: () => void }) {
  const queryClient = useQueryClient()
  const plans = useQuery(plansQueryOptions())
  const ids = { plan: useId(), interval: useId(), date: useId(), reason: useId(), coupon: useId() }
  const [now] = useState(() => new Date())
  const bounds = startDateBounds(now)

  const [planId, setPlanId] = useState<string | null>(null)
  const [billing, setBilling] = useState<SubscriptionInterval>('month')
  const [startDate, setStartDate] = useState(bounds.max)
  const [reason, setReason] = useState('')
  const [reasonTouched, setReasonTouched] = useState(false)
  const [coupon, setCoupon] = useState('')
  const [couponError, setCouponError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [result, setResult] = useState<ActivatePlanResponse | null>(null)

  const items = (plans.data?.items ?? []).filter((plan) => plan.isActive)
  // Default: the client's live plan when it is listed, else the first plan.
  const selected: AdminPlan | undefined =
    items.find((plan) => plan.id === planId) ?? items.find((plan) => plan.id === client.plan?.id) ?? items[0]
  const yearlyOk = selected ? hasYearlyPrice(selected) : false
  const interval: SubscriptionInterval = billing === 'year' && !yearlyOk ? 'month' : billing

  const dateError = startDateError(startDate, interval, now)
  const reasonErr = reasonError(reason)
  const showReasonError = reasonTouched && reasonErr !== null
  const preview = selected ? activationPricePreview(selected, interval) : null
  const termEnd = dateError ? null : activationTermEnd(startDate, interval)

  const mutation = useMutation({
    mutationFn: activateClientPlan,
    onSuccess: (res) => {
      toast.success(
        `${client.name} is now on ${res.subscription.plan.name} (${subscriptionIntervalLabels[res.subscription.interval]}).`,
      )
      void queryClient.invalidateQueries({ queryKey: adminClientsKey })
      setResult(res)
    },
    onError: (err) => {
      const couponMessage = err instanceof ApiError && err.code ? couponErrorMessages[err.code] : undefined
      if (couponMessage) setCouponError(couponMessage)
      else setServerError(errorText(err))
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setReasonTouched(true)
    if (!selected || dateError || reasonErr || mutation.isPending) return
    setServerError(null)
    setCouponError(null)
    const couponCode = coupon.trim()
    mutation.mutate({
      workspaceId: client.id,
      body: { planId: selected.id, interval, startDate, reason: reason.trim(), ...(couponCode ? { couponCode } : {}) },
    })
  }

  if (result) return <ActivationResult client={client} result={result} onClose={onClose} />

  const planOptions: PillOption<string>[] = items.map((plan) => ({
    value: plan.id,
    label: plan.name,
    hint: formatPlanPrice(plan.monthlyPriceBdt),
  }))
  const intervalOptions: PillOption<SubscriptionInterval>[] = [
    { value: 'month', label: 'Monthly' },
    {
      value: 'year',
      label: 'Yearly',
      disabled: !yearlyOk,
      title: yearlyOk ? undefined : 'This plan has no yearly price.',
    },
  ]
  const reasonLength = reason.trim().length

  return (
    <DialogContent className="sm:max-w-lg">
      <form onSubmit={submit} className="grid gap-5" noValidate>
        <DialogHeader>
          <DialogTitle>Activate a plan for {client.name}</DialogTitle>
          <DialogDescription>
            {activationLead(client)} The plan covers every workspace on this client’s billing account, and this
            period’s comments start again from 0.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <span id={ids.plan} className="text-sm font-medium">
            Plan
          </span>
          {plans.isPending ? (
            <div className="flex gap-2" aria-label="Loading plans">
              <Skeleton className="h-11 w-24 rounded-full" />
              <Skeleton className="h-11 w-24 rounded-full" />
              <Skeleton className="h-11 w-24 rounded-full" />
            </div>
          ) : plans.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Could not load the plans.{' '}
              <button type="button" className="underline underline-offset-2" onClick={() => void plans.refetch()}>
                Retry
              </button>
            </p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active plans.</p>
          ) : (
            <PillRadioGroup labelledBy={ids.plan} options={planOptions} value={selected?.id} onChange={setPlanId} />
          )}
        </div>

        <div className="grid gap-2">
          <span id={ids.interval} className="text-sm font-medium">
            Billing
          </span>
          <PillRadioGroup labelledBy={ids.interval} options={intervalOptions} value={interval} onChange={setBilling} />
          {selected && !yearlyOk && (
            <p className="text-xs text-muted-foreground">{selected.name} has no yearly price.</p>
          )}
        </div>

        <div className="grid gap-2">
          <Label htmlFor={ids.date}>Start date</Label>
          <Input
            id={ids.date}
            type="date"
            value={startDate}
            min={bounds.min}
            max={bounds.max}
            onChange={(e) => setStartDate(e.target.value)}
            aria-invalid={dateError !== null || undefined}
            aria-describedby={`${ids.date}-hint`}
            className="w-44"
          />
          <p
            id={`${ids.date}-hint`}
            className={`text-xs ${dateError ? 'text-destructive' : 'text-muted-foreground'}`}
            role={dateError ? 'alert' : undefined}
          >
            {dateError ?? `Bangladesh time, from ${formatDhakaDate(`${bounds.min}T00:00:00+06:00`)} to today.`}
          </p>
        </div>

        {selected && preview && (
          <div className="rounded-2xl bg-muted/50 px-4 py-3" aria-live="polite">
            <p className="text-sm">
              <span className="text-muted-foreground">List price </span>
              <span className="font-medium tabular-nums" data-testid="activation-price">
                {preview}
              </span>
            </p>
            {termEnd && (
              <p className="text-xs text-muted-foreground">
                {selected.name} · term ends {formatDhakaDate(termEnd)}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              The client’s automatic discount and the coupon come off when you activate.
            </p>
          </div>
        )}

        <div className="grid gap-2">
          <Label htmlFor={ids.coupon}>Coupon (optional)</Label>
          <Input
            id={ids.coupon}
            value={coupon}
            onChange={(e) => {
              setCoupon(e.target.value)
              setCouponError(null)
            }}
            placeholder="e.g. EID25"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={couponError !== null || undefined}
            aria-describedby={`${ids.coupon}-hint`}
            className="w-56 uppercase placeholder:normal-case"
          />
          <p
            id={`${ids.coupon}-hint`}
            className={`text-xs ${couponError ? 'text-destructive' : 'text-muted-foreground'}`}
            role={couponError ? 'alert' : undefined}
          >
            {couponError ?? 'Any case. Comes off after the automatic discount.'}
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor={ids.reason}>Reason</Label>
          <Textarea
            id={ids.reason}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setReasonTouched(true)}
            placeholder="e.g. Paid ৳1,499 by bKash, TrxID 9A8B7C"
            aria-invalid={showReasonError || undefined}
            aria-describedby={`${ids.reason}-hint`}
            rows={3}
          />
          <div id={`${ids.reason}-hint`} className="flex justify-between gap-3 text-xs">
            <span
              className={showReasonError ? 'text-destructive' : 'text-muted-foreground'}
              role={showReasonError ? 'alert' : undefined}
            >
              {showReasonError ? reasonErr : 'Saved to the audit log.'}
            </span>
            <span className={reasonLength > REASON_MAX ? 'text-destructive' : 'text-muted-foreground'}>
              {reasonLength}/{REASON_MAX}
            </span>
          </div>
        </div>

        {serverError && (
          <p role="alert" className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {serverError}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!selected || dateError !== null || reasonErr !== null || mutation.isPending}
          >
            {mutation.isPending ? 'Activating…' : 'Activate plan'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

/** After a 201: what the term costs and what came off (`price` from the backend, PR-D12). */
function ActivationResult({
  client,
  result,
  onClose,
}: {
  client: AdminClient
  result: ActivatePlanResponse
  onClose: () => void
}) {
  const { subscription, price } = result
  const yearly = subscription.interval === 'year'
  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Plan activated</DialogTitle>
        <DialogDescription>
          {client.name} is on {subscription.plan.name} ({subscriptionIntervalLabels[subscription.interval]}) until{' '}
          {formatDhakaDate(subscription.termEndsAt)}.
        </DialogDescription>
      </DialogHeader>
      <dl data-testid="activation-result" className="grid gap-2 rounded-2xl bg-muted/50 px-4 py-3 text-sm">
        <PriceRow label="List price" value={formatPlanPrice(price.listChargedBdt)} />
        {price.discount && <PromotionRow promotion={price.discount} />}
        {price.coupon && <PromotionRow promotion={price.coupon} />}
        <div className="flex justify-between gap-3 border-t pt-2 font-semibold">
          <dt>Charged</dt>
          <dd className="tabular-nums">
            {formatPlanPrice(price.chargedBdt)}
            {yearly && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({formatPlanPrice(price.perMonthBdt)}/month)
              </span>
            )}
          </dd>
        </div>
      </dl>
      {!price.discount && !price.coupon && <p className="text-xs text-muted-foreground">No promotion applied.</p>}
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function PriceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="min-w-0 text-muted-foreground">{label}</dt>
      <dd className="shrink-0 tabular-nums">{value}</dd>
    </div>
  )
}

function PromotionRow({ promotion }: { promotion: AppliedPromotion }) {
  const name = promotion.code ? `Coupon ${promotion.code}` : promotion.name
  return <PriceRow label={`${name} · ${promotion.label}`} value={`−${formatPlanPrice(promotion.amountBdt)}`} />
}

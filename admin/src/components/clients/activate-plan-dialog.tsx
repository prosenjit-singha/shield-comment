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
  activateClientPlan,
  activationErrorMessages,
  activationPricePreview,
  activationTermEnd,
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
 * date (today − 31 days … today, Dhaka) and a reason. The backend ends the account's live
 * subscription and starts the new term with a fresh comment period; audit-logged.
 */
export function ActivatePlanDialog({ client, onClose }: { client: AdminClient | null; onClose: () => void }) {
  return (
    <Dialog open={client !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Keyed so each opening starts from the defaults. */}
      {client && <ActivateForm key={client.id} client={client} onClose={onClose} />}
    </Dialog>
  )
}

/** What the client is on now, for the dialog description. */
function currentPlanText(client: AdminClient): string {
  const sub = client.subscription
  if (client.plan && sub?.status === 'TRIALING') return `the ${client.plan.name} trial`
  if (client.plan && sub?.status === 'ACTIVE') return `${client.plan.name} (${subscriptionIntervalLabels[sub.interval]})`
  return 'no active plan'
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
  const ids = { plan: useId(), interval: useId(), date: useId(), reason: useId() }
  const [now] = useState(() => new Date())
  const bounds = startDateBounds(now)

  const [planId, setPlanId] = useState<string | null>(null)
  const [billing, setBilling] = useState<SubscriptionInterval>('month')
  const [startDate, setStartDate] = useState(bounds.max)
  const [reason, setReason] = useState('')
  const [reasonTouched, setReasonTouched] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

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
      onClose()
    },
    onError: (err) => setServerError(errorText(err)),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setReasonTouched(true)
    if (!selected || dateError || reasonErr || mutation.isPending) return
    setServerError(null)
    mutation.mutate({
      workspaceId: client.id,
      body: { planId: selected.id, interval, startDate, reason: reason.trim() },
    })
  }

  const planOptions: PillOption<string>[] = items.map((plan) => ({
    value: plan.id,
    label: plan.name,
    hint: formatPlanPrice(plan.offerPriceBdt ?? plan.originalPriceBdt),
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
    <DialogContent className="rounded-2xl sm:max-w-lg">
      <form onSubmit={submit} className="grid gap-5" noValidate>
        <DialogHeader>
          <DialogTitle>Activate a plan for {client.name}</DialogTitle>
          <DialogDescription>
            Ends {currentPlanText(client)} right away and starts the new term from the start date. The plan covers
            every workspace on this client’s billing account, and this period’s comments start again from 0.
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
          <div className="rounded-2xl border bg-muted/50 px-4 py-3" aria-live="polite">
            <p className="text-sm font-medium tabular-nums" data-testid="activation-price">
              {preview}
            </p>
            {termEnd && (
              <p className="text-xs text-muted-foreground">
                {selected.name} · term ends {formatDhakaDate(termEnd)}
              </p>
            )}
          </div>
        )}

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

        <DialogFooter className="rounded-b-2xl">
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

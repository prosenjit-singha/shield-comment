import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
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
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  type AdminTransactionDetail,
  adminBillingKey,
  eventSourceLabels,
  formatDhakaTime,
  outcomeLabel,
  paymentKindLabels,
  promotionMonths,
  refundTransaction,
  transactionQueryOptions,
  transactionStatusLabels,
} from '@/lib/admin-billing'
import { formatDhakaDate, REASON_MAX, reasonError, subscriptionIntervalLabels } from '@/lib/admin-clients'
import { formatBdt } from '@/lib/admin-dashboard'
import { ApiError } from '@/lib/api'

const dateTime = (iso: string) => `${formatDhakaDate(iso)}, ${formatDhakaTime(iso)}`

/** A4 transaction sheet (M8-T8 `GET …/transactions/:id`) with D9 "Mark refunded". */
export function TransactionSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      {id && (
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetBody id={id} />
        </SheetContent>
      )}
    </Sheet>
  )
}

function SheetBody({ id }: { id: string }) {
  const query = useQuery(transactionQueryOptions(id))
  const [refunding, setRefunding] = useState(false)

  if (query.isPending) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>Transaction</SheetTitle>
          <SheetDescription>Loading…</SheetDescription>
        </SheetHeader>
        <div className="grid gap-3 px-5" aria-label="Loading transaction">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      </>
    )
  }
  if (query.isError) {
    const gone = query.error instanceof ApiError && query.error.status === 404
    return (
      <>
        <SheetHeader>
          <SheetTitle>Transaction</SheetTitle>
          <SheetDescription>Couldn't load this transaction.</SheetDescription>
        </SheetHeader>
        <p role="alert" className="px-5 text-sm text-destructive">
          {gone ? 'This transaction no longer exists.' : query.error.message}{' '}
          {!gone && (
            <button type="button" className="underline underline-offset-2" onClick={() => void query.refetch()}>
              Retry
            </button>
          )}
        </p>
      </>
    )
  }

  const tx = query.data
  return (
    <>
      <SheetHeader className="pr-12">
        <SheetTitle>
          {tx.workspace.name} · {formatBdt(tx.amountBdt)}
        </SheetTitle>
        <SheetDescription>
          {transactionStatusLabels[tx.status]} · {tx.invoiceNumber ?? 'No invoice'} · times are Bangladesh time
        </SheetDescription>
      </SheetHeader>

      <div className="grid gap-3 px-5">
        {tx.riskFlagged && (
          <p className="flex items-start gap-2 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            High risk (SSLCommerz risk level {tx.riskLevel ?? 1}). Activated anyway; check it in the merchant panel.
          </p>
        )}

        <Block title="Payment">
          <Row label="Payer">
            {tx.user ? (
              <span className="flex flex-col items-end">
                <span>{tx.user.name}</span>
                <span className="text-xs text-muted-foreground">{tx.user.email}</span>
              </span>
            ) : (
              'Deleted user'
            )}
          </Row>
          <Row label="Plan">
            {tx.plan.name} · {subscriptionIntervalLabels[tx.interval]} · {paymentKindLabels[tx.kind]}
          </Row>
          {tx.term && (
            <Row label="Term">
              {formatDhakaDate(tx.term.start)} – {formatDhakaDate(tx.term.end)}
            </Row>
          )}
          <Row label="Created">{dateTime(tx.createdAt)}</Row>
          {tx.paidAt && <Row label="Paid">{dateTime(tx.paidAt)}</Row>}
        </Block>

        <Block title="Price">
          <Row label="List price">{formatBdt(tx.listPriceBdt)}</Row>
          {tx.promotions.map((p) => (
            <Row
              key={p.type}
              label={
                <span className="flex flex-col">
                  <span>
                    {p.type === 'COUPON' ? `Coupon ${p.code ?? ''}`.trim() : 'Discount'} · {p.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {[p.name, promotionMonths(p.months)].filter(Boolean).join(' · ')}
                  </span>
                </span>
              }
            >
              −{formatBdt(p.amountOffBdt)}
            </Row>
          ))}
          {tx.creditBdt > 0 && <Row label="Upgrade credit">−{formatBdt(tx.creditBdt)}</Row>}
          <Row label={<span className="font-medium text-foreground">Charged</span>}>
            <span className="font-semibold">{formatBdt(tx.amountBdt)}</span>
          </Row>
        </Block>

        <Block title="Gateway">
          <Row label="Method">{tx.gateway}</Row>
          {tx.cardType && <Row label="Card type">{tx.cardType}</Row>}
          <Row label="Transaction ID">
            <Mono>{tx.tranId}</Mono>
          </Row>
          {tx.valId && (
            <Row label="Validation ID">
              <Mono>{tx.valId}</Mono>
            </Row>
          )}
          {tx.bankTranId && (
            <Row label="Bank transaction ID">
              <Mono>{tx.bankTranId}</Mono>
            </Row>
          )}
          {tx.riskLevel !== null && <Row label="Risk level">{tx.riskLevel}</Row>}
        </Block>

        <Block title="Events">
          {tx.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No SSLCommerz callbacks for this transaction.</p>
          ) : (
            <ol className="grid gap-2" aria-label="Events">
              {tx.events.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="flex flex-col">
                    <span>{outcomeLabel(e.outcome)}</span>
                    <span className="text-xs text-muted-foreground">{eventSourceLabels[e.source]}</span>
                  </span>
                  <time dateTime={e.receivedAt} className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {dateTime(e.receivedAt)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </Block>

        {tx.refund && (
          <Block title="Refund">
            <Row label="Marked by">{tx.refund.admin.name}</Row>
            <Row label="When">{dateTime(tx.refund.createdAt)}</Row>
            <p className="text-sm whitespace-pre-wrap">{tx.refund.reason}</p>
          </Block>
        )}
      </div>

      {tx.status === 'PAID' && (
        <SheetFooter>
          <Button variant="outline" onClick={() => setRefunding(true)}>
            Mark refunded
          </Button>
        </SheetFooter>
      )}
      <RefundDialog tx={refunding ? tx : null} onClose={() => setRefunding(false)} />
    </>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 rounded-2xl bg-muted/60 px-4 py-3">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right tabular-nums">{children}</span>
    </div>
  )
}

function Mono({ children }: { children: string }) {
  return (
    <code className="block max-w-52 truncate font-mono text-xs" title={children}>
      {children}
    </code>
  )
}

/** D9 confirm dialog: reason (1–500) saved to the refund audit; the plan is not changed. */
function RefundDialog({ tx, onClose }: { tx: AdminTransactionDetail | null; onClose: () => void }) {
  return (
    <Dialog open={tx !== null} onOpenChange={(open) => !open && onClose()}>
      {tx && <RefundForm key={tx.id} tx={tx} onClose={onClose} />}
    </Dialog>
  )
}

function RefundForm({ tx, onClose }: { tx: AdminTransactionDetail; onClose: () => void }) {
  const queryClient = useQueryClient()
  const reasonId = useId()
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const error = reasonError(reason)

  const mutation = useMutation({
    mutationFn: refundTransaction,
    onSuccess: () => {
      toast.success(`${tx.tranId} is marked refunded.`)
      onClose()
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error('Only a paid transaction can be marked refunded.', {
          description: 'Its status changed meanwhile; the sheet now shows the latest.',
        })
        onClose()
      } else if (err instanceof ApiError && err.status === 404) {
        toast.error('This transaction no longer exists.')
        onClose()
      } else if (err instanceof ApiError && err.status === 400) {
        toast.error('The refund was rejected.', { description: err.message })
      } else {
        toast.error('Could not mark the refund.', { description: err instanceof Error ? err.message : undefined })
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: adminBillingKey }),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (error || mutation.isPending) return
    mutation.mutate({ id: tx.id, reason: reason.trim() })
  }

  const showError = touched && error !== null
  const length = reason.trim().length

  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <DialogHeader>
          <DialogTitle>Mark {formatBdt(tx.amountBdt)} refunded?</DialogTitle>
          <DialogDescription>
            Refund the money in the SSLCommerz merchant panel first; this only records it. {tx.workspace.name}'s plan
            is not changed (cancel it separately if needed).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={reasonId}>Reason</Label>
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="e.g. Charged twice, refunded in the merchant panel"
            aria-invalid={showError || undefined}
            aria-describedby={`${reasonId}-hint`}
            rows={3}
            autoFocus
          />
          <div id={`${reasonId}-hint`} className="flex justify-between gap-3 text-xs">
            <span
              className={showError ? 'text-destructive' : 'text-muted-foreground'}
              role={showError ? 'alert' : undefined}
            >
              {showError ? error : 'Saved to the refund audit.'}
            </span>
            <span className={length > REASON_MAX ? 'text-destructive' : 'text-muted-foreground'}>
              {length}/{REASON_MAX}
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={error !== null || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Mark refunded'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

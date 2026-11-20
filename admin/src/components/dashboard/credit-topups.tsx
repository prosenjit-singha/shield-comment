import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Wallet } from 'lucide-react'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { toast } from 'sonner'
import { BlockError } from '@/components/dashboard/ai-spend'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  type AiCreditTopup,
  adminAiSummaryKey,
  adminAiTopupsKey,
  aiTopupsQueryOptions,
  createTopup,
  deleteTopup,
  TOPUP_NOTE_MAX,
  topupAmountError,
  topupDateError,
  topupErrorMessage,
  topupNoteError,
} from '@/lib/admin-ai'
import { dhakaToday, formatBucketLabel } from '@/lib/admin-dashboard'
import { formatUsd } from '@/lib/admin-system'
import { ApiError } from '@/lib/api'

function useRefreshCredit() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: adminAiTopupsKey }),
      queryClient.invalidateQueries({ queryKey: adminAiSummaryKey }),
    ])
}

/** D26: Neon credit the admin bought (no Neon API for it), newest top-up date first. */
export function CreditTopups() {
  const query = useQuery(aiTopupsQueryOptions())
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<AiCreditTopup | null>(null)
  const items = query.data?.items

  return (
    <section aria-label="Credit top-ups" className="min-w-0 rounded-3xl bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div>
          <h2 className="text-base font-semibold">Credit top-ups</h2>
          <p className="text-sm text-muted-foreground">Neon AI credit you bought, as entered here.</p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus data-icon="inline-start" />
          Add top-up
        </Button>
      </div>
      {query.isError ? (
        <BlockError title="Couldn’t load the top-ups" error={query.error} onRetry={() => void query.refetch()} />
      ) : items && items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 border-t px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Wallet className="size-6" aria-hidden />
          </span>
          <p className="text-sm text-muted-foreground">No top-ups yet. Add the credit you bought on Neon.</p>
        </div>
      ) : (
        <div className="min-w-0 border-t">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Date</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>By</TableHead>
                <TableHead className="pr-5 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items
                ? items.map((t) => (
                    <TableRow key={t.id} data-testid="topup-row" className="hover:bg-muted">
                      <TableCell className="pl-5 whitespace-nowrap">{formatBucketLabel(t.toppedUpOn)}</TableCell>
                      <TableCell className="font-medium tabular-nums">{formatUsd(t.amountUsd)}</TableCell>
                      <TableCell className="max-w-64 truncate" title={t.note ?? undefined}>
                        {t.note ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="max-w-40 truncate">{t.createdBy.name}</TableCell>
                      <TableCell className="pr-5 text-right">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Delete the ${formatUsd(t.amountUsd)} top-up of ${formatBucketLabel(t.toppedUpOn)}`}
                          onClick={() => setDeleting(t)}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                : Array.from({ length: 2 }, (_, i) => (
                    <TableRow key={i} className="hover:bg-transparent" aria-hidden>
                      {Array.from({ length: 5 }, (_, j) => (
                        <TableCell key={j} className={j === 0 ? 'pl-5' : undefined}>
                          <Skeleton className="h-4 w-16 rounded-full" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && <AddTopupForm onClose={() => setAdding(false)} />}
      </Dialog>
      <DeleteTopupDialog topup={deleting} onClose={() => setDeleting(null)} />
    </section>
  )
}

function AddTopupForm({ onClose }: { onClose: () => void }) {
  const refresh = useRefreshCredit()
  const ids = { amount: useId(), date: useId(), note: useId() }
  const [now] = useState(() => new Date())
  const today = dhakaToday(now)
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(today)
  const [note, setNote] = useState('')
  const [tried, setTried] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const errors = { amount: topupAmountError(amount), date: topupDateError(date, now), note: topupNoteError(note) }
  const show = { amount: tried || amount !== '' ? errors.amount : null, date: errors.date, note: errors.note }

  const mutation = useMutation({
    mutationFn: createTopup,
    onSuccess: ({ topup }) => {
      toast.success(`Added a ${formatUsd(topup.amountUsd)} top-up.`)
      void refresh()
      onClose()
    },
    onError: (err) => setServerError(topupErrorMessage(err)),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTried(true)
    if (errors.amount || errors.date || errors.note || mutation.isPending) return
    setServerError(null)
    const trimmed = note.trim()
    mutation.mutate({ amountUsd: Number(amount.trim()), toppedUpOn: date, ...(trimmed ? { note: trimmed } : {}) })
  }

  const noteLength = note.trim().length
  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={submit} className="grid gap-5" noValidate>
        <DialogHeader>
          <DialogTitle>Add a credit top-up</DialogTitle>
          <DialogDescription>
            The credit you bought on Neon. Remaining credit on the dashboard = all top-ups − estimated spend.
          </DialogDescription>
        </DialogHeader>

        <Field id={ids.amount} label="Amount (USD)" error={show.amount} hint="More than $0, up to 2 decimals.">
          <Input
            id={ids.amount}
            inputMode="decimal"
            autoComplete="off"
            placeholder="25.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={show.amount !== null || undefined}
            aria-describedby={`${ids.amount}-hint`}
            className="w-40"
          />
        </Field>

        <Field id={ids.date} label="Top-up date" error={show.date} hint="Bangladesh time, today or earlier.">
          <Input
            id={ids.date}
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            aria-invalid={show.date !== null || undefined}
            aria-describedby={`${ids.date}-hint`}
            className="w-44"
          />
        </Field>

        <div className="grid gap-2">
          <Label htmlFor={ids.note}>Note (optional)</Label>
          <Textarea
            id={ids.note}
            value={note}
            rows={2}
            placeholder="e.g. Card ending 4242, invoice #123"
            onChange={(e) => setNote(e.target.value)}
            aria-invalid={show.note !== null || undefined}
            aria-describedby={`${ids.note}-hint`}
          />
          <div id={`${ids.note}-hint`} className="flex justify-between gap-3 text-xs">
            <span className={show.note ? 'text-destructive' : 'text-muted-foreground'} role={show.note ? 'alert' : undefined}>
              {show.note ?? 'Only admins see it.'}
            </span>
            <span className={show.note ? 'text-destructive' : 'text-muted-foreground'}>
              {noteLength}/{TOPUP_NOTE_MAX}
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
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Adding…' : 'Add top-up'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string
  label: string
  error: string | null
  hint: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      <p
        id={`${id}-hint`}
        className={`text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}
        role={error ? 'alert' : undefined}
      >
        {error ?? hint}
      </p>
    </div>
  )
}

function DeleteTopupDialog({ topup, onClose }: { topup: AiCreditTopup | null; onClose: () => void }) {
  const refresh = useRefreshCredit()
  const mutation = useMutation({
    mutationFn: deleteTopup,
    onSuccess: () => toast.success('Top-up deleted.'),
    onError: (err) =>
      toast.error(
        err instanceof ApiError && err.status === 404 ? 'This top-up was already deleted.' : 'Could not delete the top-up.',
        { description: err instanceof ApiError && err.status !== 404 ? err.message : undefined },
      ),
    onSettled: () => {
      void refresh()
      onClose()
    },
  })

  return (
    <Dialog open={topup !== null} onOpenChange={(open) => !open && onClose()}>
      {topup && (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this top-up?</DialogTitle>
            <DialogDescription>
              {formatUsd(topup.amountUsd)} on {formatBucketLabel(topup.toppedUpOn)} comes off the credit added. Use this
              for a mistaken entry; the deletion is audit-logged.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(topup.id)}
            >
              {mutation.isPending ? 'Deleting…' : 'Delete top-up'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}

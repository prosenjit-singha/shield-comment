import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Users } from 'lucide-react'
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDhakaDate } from '@/lib/admin-clients'
import { formatCount, formatPlanPrice } from '@/lib/admin-plans'
import {
  type AdminPromotion,
  adminPromotionsKey,
  redemptionsQueryOptions,
  stopPromotion,
} from '@/lib/admin-promotions'
import { ApiError } from '@/lib/api'

/** Stop confirm (PR-D2, D15): blocks new claims only; there is no restart. */
export function StopPromotionDialog({ promotion, onClose }: { promotion: AdminPromotion | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: stopPromotion,
    onSuccess: ({ promotion: stopped }) => {
      toast.success(`${stopped.name} is stopped.`)
      onClose()
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError && err.status === 404 ? 'This promotion no longer exists.' : 'Could not stop the promotion.',
        { description: err instanceof ApiError && err.status !== 404 ? err.message : undefined },
      )
      onClose()
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: adminPromotionsKey }),
  })

  return (
    <Dialog open={promotion !== null} onOpenChange={(open) => !open && onClose()}>
      {promotion && (
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Stop {promotion.name}?</DialogTitle>
            <DialogDescription>
              New clients can't claim it any more. Clients who already claimed it keep what they got. A stopped
              promotion can't be started again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="rounded-b-2xl">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(promotion.id)}
            >
              {mutation.isPending ? 'Stopping…' : 'Stop promotion'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}

/** Who claimed the promotion (oldest first, as the API returns them). */
export function RedemptionsSheet({ promotion, onClose }: { promotion: AdminPromotion | null; onClose: () => void }) {
  return (
    <Sheet open={promotion !== null} onOpenChange={(open) => !open && onClose()}>
      {promotion && (
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Claims · {promotion.name}</SheetTitle>
            <SheetDescription>Every client account that claimed it. Dates are Bangladesh time.</SheetDescription>
          </SheetHeader>
          <RedemptionList promotion={promotion} />
        </SheetContent>
      )}
    </Sheet>
  )
}

function RedemptionList({ promotion }: { promotion: AdminPromotion }) {
  const query = useQuery(redemptionsQueryOptions(promotion.id))
  if (query.isPending) {
    return (
      <div className="grid gap-3 px-4" aria-label="Loading claims">
        <Skeleton className="h-16 rounded-2xl" />
        <Skeleton className="h-16 rounded-2xl" />
      </div>
    )
  }
  if (query.isError) {
    return (
      <p role="alert" className="px-4 text-sm text-destructive">
        Could not load the claims.{' '}
        <button type="button" className="underline underline-offset-2" onClick={() => void query.refetch()}>
          Retry
        </button>
      </p>
    )
  }
  if (query.data.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Users className="size-6" aria-hidden />
        </span>
        <p className="text-sm text-muted-foreground">No client has claimed this promotion yet.</p>
      </div>
    )
  }
  const trial = promotion.kind === 'TRIAL'
  return (
    <ul className="grid gap-3 px-4 pb-4" aria-label="Claims">
      {query.data.items.map((r) => (
        <li key={r.id} className="grid gap-1 rounded-2xl border bg-card px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate font-medium">{r.client.name}</span>
            <time dateTime={r.redeemedAt} className="shrink-0 text-xs text-muted-foreground">
              {formatDhakaDate(r.redeemedAt)}
            </time>
          </div>
          <span className="truncate text-xs text-muted-foreground">{r.client.email}</span>
          <span className="text-xs text-muted-foreground">
            {r.workspace?.name ?? 'No workspace'} · {r.plan?.name ?? 'No plan'}
          </span>
          {!trial && (
            <span className="text-xs">
              Saved {formatPlanPrice(r.discountBdtFirstTerm)} on the first bill ·{' '}
              {formatCount(r.monthsUsed)} {r.monthsUsed === 1 ? 'month' : 'months'} used
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

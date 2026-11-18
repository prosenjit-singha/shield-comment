import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useBlocker } from '@tanstack/react-router'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '@/components/placeholder-page'
import { PlanEditorCard } from '@/components/settings/plan-editor-card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { isDraftDirty, type PlanDraft, plansQueryOptions } from '@/lib/admin-plans'

export const Route = createFileRoute('/_authed/admin/settings')({
  // Warm the cache without blocking the screen; the cards show skeletons meanwhile.
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(plansQueryOptions())
  },
  component: SettingsPage,
})

/**
 * A7 (M2-T12): one editor card per plan, saved one plan at a time (`PATCH …/plans/:planId`).
 * Drafts live here, keyed by plan id, so leaving the page with unsaved changes can be blocked.
 */
function SettingsPage() {
  const query = useQuery(plansQueryOptions())
  const [drafts, setDrafts] = useState<Record<string, PlanDraft>>({})
  const items = query.data?.items
  const dirtyCount = items?.filter((plan) => isDraftDirty(plan, drafts[plan.id])).length ?? 0

  const blocker = useBlocker({
    shouldBlockFn: () => dirtyCount > 0,
    enableBeforeUnload: () => dirtyCount > 0,
    withResolver: true,
  })

  const setDraft = (planId: string, draft: PlanDraft | undefined) =>
    setDrafts((current) => {
      const next = { ...current }
      if (draft) next[planId] = draft
      else delete next[planId]
      return next
    })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Plan prices in ৳, offer badges, limits and features. Each plan saves on its own."
      />

      {query.isError && !query.data ? (
        <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
      ) : !items ? (
        <div className="grid gap-4 xl:grid-cols-2" aria-busy="true" aria-label="Loading plans">
          {Array.from({ length: 4 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <section className="flex flex-col items-center gap-2 rounded-2xl border bg-card px-6 py-16 text-center">
          <h2 className="text-base font-semibold">No plans</h2>
          <p className="max-w-md text-sm text-balance text-muted-foreground">
            Plans come from the database seed. Run the migrations to create Free, Starter, Growth and Pro.
          </p>
        </section>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {items.map((plan) => (
            <PlanEditorCard
              key={plan.id}
              plan={plan}
              draft={drafts[plan.id]}
              onDraftChange={(draft) => setDraft(plan.id, draft)}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Prices are monthly, in whole taka. The pricing page shows the original price struck through when an
        offer is set.
      </p>

      <Dialog open={blocker.status === 'blocked'} onOpenChange={(open) => !open && blocker.reset?.()}>
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Leave without saving?</DialogTitle>
            <DialogDescription>
              {dirtyCount === 1
                ? 'One plan has unsaved changes. They will be lost.'
                : `${dirtyCount} plans have unsaved changes. They will be lost.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="rounded-b-2xl">
            <Button type="button" variant="outline" onClick={() => blocker.reset?.()}>
              Stay
            </Button>
            <Button type="button" variant="destructive" onClick={() => blocker.proceed?.()}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CardSkeleton() {
  return (
    <div data-testid="plan-skeleton" className="flex flex-col gap-5 rounded-2xl border bg-card p-4 md:p-5" aria-hidden>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-28 rounded-full" />
          <Skeleton className="h-4 w-16 rounded-full" />
        </div>
        <Skeleton className="h-14 w-28 rounded-2xl" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-9 rounded-full" />
        <Skeleton className="h-9 rounded-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-9 rounded-full" />
        <Skeleton className="h-9 rounded-full" />
        <Skeleton className="h-9 rounded-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-4 rounded-full" />
        ))}
      </div>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border bg-card px-6 py-16 text-center">
      <h2 className="text-base font-semibold">Couldn't load plans</h2>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        <RotateCcw data-icon="inline-start" />
        Try again
      </Button>
    </div>
  )
}

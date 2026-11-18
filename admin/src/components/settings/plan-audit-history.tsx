import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ChevronLeft, ChevronRight, History, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  formatPlanAuditValue,
  PLAN_AUDIT_PAGE_SIZE,
  type PlanAuditEntry,
  planAuditActionLabels,
  planAuditFieldLabel,
  planAuditQueryOptions,
} from '@/lib/admin-plan-audit'
import type { AdminPlan } from '@/lib/admin-plans'
import { formatDhakaDateTime } from '@/lib/admin-system'

/**
 * A7 plan audit history (M2-T16): one panel for every plan, newest first, with a plan filter.
 * Page and filter are component state, not URL search params: the settings page blocks every
 * navigation while a plan card is dirty, so URL paging would pop "Leave without saving?".
 */
export function PlanAuditHistory({ plans }: { plans: readonly AdminPlan[] }) {
  const [page, setPage] = useState(1)
  const [planId, setPlanId] = useState<string | undefined>(undefined)
  const query = useQuery(planAuditQueryOptions({ page, planId }))
  const data = query.data
  const pageCount = data ? Math.max(1, Math.ceil(data.total / PLAN_AUDIT_PAGE_SIZE)) : 1
  const empty = data !== undefined && data.items.length === 0
  const filterName = plans.find((p) => p.id === planId)?.name

  const choosePlan = (id: string | undefined) => {
    setPlanId(id)
    setPage(1)
  }

  return (
    <section aria-labelledby="plan-audit-title" className="flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card">
      <div className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 id="plan-audit-title" className="text-base font-semibold">
            Change history
          </h2>
          <p className="text-xs text-muted-foreground">Every plan save, newest first · times in Bangladesh time</p>
        </div>
        {plans.length > 0 && (
          <div role="group" aria-label="Filter by plan" className="flex flex-wrap gap-2">
            <FilterPill pressed={planId === undefined} onClick={() => choosePlan(undefined)}>
              All plans
            </FilterPill>
            {plans.map((plan) => (
              <FilterPill key={plan.id} pressed={planId === plan.id} onClick={() => choosePlan(plan.id)}>
                {plan.name}
              </FilterPill>
            ))}
          </div>
        )}
      </div>

      {query.isError && !data ? (
        <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <ol aria-busy="true" aria-label="Loading change history" className="flex flex-col">
          {Array.from({ length: 3 }, (_, i) => (
            <EntrySkeleton key={i} />
          ))}
        </ol>
      ) : empty ? (
        <EmptyState page={page} planName={filterName} onFirstPage={() => setPage(1)} />
      ) : (
        <ol
          aria-label="Plan changes"
          aria-busy={query.isFetching && query.isPlaceholderData ? true : undefined}
          className="flex flex-col transition-opacity aria-busy:opacity-60"
        >
          {data.items.map((entry) => (
            <AuditEntry key={entry.id} entry={entry} />
          ))}
        </ol>
      )}

      {data && data.total > 0 && !empty && (
        <Pagination
          page={page}
          pageCount={pageCount}
          total={data.total}
          shown={data.items.length}
          skip={data.skip}
          onPage={setPage}
        />
      )}
    </section>
  )
}

function FilterPill({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) {
  return (
    <Button type="button" size="sm" variant={pressed ? 'default' : 'outline'} aria-pressed={pressed} onClick={onClick}>
      {children}
    </Button>
  )
}

function AuditEntry({ entry }: { entry: PlanAuditEntry }) {
  const who = entry.admin.name.trim() || entry.admin.email
  return (
    <li data-testid="audit-entry" className="flex min-w-0 flex-col gap-3 border-t px-4 py-4 md:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            {planAuditActionLabels[entry.action] ?? entry.action}
          </span>
          <span className="font-medium">{entry.plan.name}</span>
          <span className="min-w-0 text-sm text-muted-foreground">
            by <span className="text-foreground">{who}</span>{' '}
            <span className="break-all">{entry.admin.email}</span>
          </span>
        </div>
        <time dateTime={entry.createdAt} className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDhakaDateTime(entry.createdAt)}
        </time>
      </div>

      <ul aria-label="Changed fields" className="flex flex-col gap-2 rounded-2xl bg-muted px-3 py-2.5 text-sm">
        {entry.changes.map((change) => (
          <li
            key={change.field}
            data-testid="audit-change"
            className="grid min-w-0 gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]"
          >
            <span className="min-w-0 text-muted-foreground">{planAuditFieldLabel(change.field)}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 tabular-nums">
              <span data-testid="audit-before" className="text-muted-foreground">
                {formatPlanAuditValue(change.field, change.before)}
              </span>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="sr-only">changed to</span>
              <span data-testid="audit-after" className="font-medium">
                {formatPlanAuditValue(change.field, change.after)}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {(entry.ip || entry.userAgent) && (
        <p data-testid="audit-client" className="min-w-0 truncate text-xs text-muted-foreground" title={entry.userAgent ?? undefined}>
          {entry.ip && <span>IP {entry.ip}</span>}
          {entry.ip && entry.userAgent && <span aria-hidden> · </span>}
          {entry.userAgent && <span>{entry.userAgent}</span>}
        </p>
      )}
    </li>
  )
}

function EntrySkeleton() {
  return (
    <li data-testid="audit-skeleton" className="flex flex-col gap-3 border-t px-4 py-4 md:px-5" aria-hidden>
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-5 w-64 max-w-full rounded-full" />
        <Skeleton className="h-4 w-28 rounded-full" />
      </div>
      <Skeleton className="h-14 rounded-2xl" />
      <Skeleton className="h-3 w-48 rounded-full" />
    </li>
  )
}

function EmptyState({
  page,
  planName,
  onFirstPage,
}: {
  page: number
  planName: string | undefined
  onFirstPage: () => void
}) {
  const pastEnd = page > 1
  return (
    <div className="flex flex-col items-center gap-3 border-t px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <History className="size-6" aria-hidden />
      </span>
      <h3 className="text-base font-semibold">
        {pastEnd ? 'No changes on this page' : planName ? `No changes to ${planName} yet` : 'No plan changes yet'}
      </h3>
      <p className="max-w-md text-sm text-balance text-muted-foreground">
        {pastEnd
          ? 'This page is past the last change.'
          : 'Each save on this screen is recorded here with who made it, when, and every field before and after.'}
      </p>
      {pastEnd && (
        <Button variant="outline" onClick={onFirstPage}>
          Go to first page
        </Button>
      )}
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 border-t px-6 py-12 text-center">
      <h3 className="text-base font-semibold">Couldn't load the change history</h3>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        <RotateCcw data-icon="inline-start" />
        Try again
      </Button>
    </div>
  )
}

function Pagination({
  page,
  pageCount,
  total,
  shown,
  skip,
  onPage,
}: {
  page: number
  pageCount: number
  total: number
  shown: number
  skip: number
  onPage: (page: number) => void
}) {
  return (
    <nav aria-label="Change history pages" className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 md:px-5">
      <p className="text-sm text-muted-foreground">
        {skip + 1}–{skip + shown} of {total} {total === 1 ? 'change' : 'changes'}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft />
        </Button>
        <span className="text-sm tabular-nums">
          {page} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </nav>
  )
}

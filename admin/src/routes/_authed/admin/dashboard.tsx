import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import {
  CommentsChart,
  GatewaysChart,
  GrowthChart,
  PlanTiersChart,
} from '@/components/dashboard/dashboard-charts'
import { KpiCards } from '@/components/dashboard/kpi-cards'
import { RangePicker } from '@/components/dashboard/range-picker'
import { PageHeader } from '@/components/placeholder-page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError } from '@/lib/api'
import {
  type DashboardSearch,
  dashboardQueryOptions,
  formatRangeLabel,
  validateDashboardSearch,
} from '@/lib/admin-dashboard'

export const Route = createFileRoute('/_authed/admin/dashboard')({
  validateSearch: validateDashboardSearch,
  loaderDeps: ({ search }) => search,
  // Warm the cache without blocking the screen; the page shows skeletons.
  loader: ({ context, deps }) => {
    void context.queryClient.prefetchQuery(dashboardQueryOptions(deps))
  },
  component: DashboardPage,
})

function DashboardPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const query = useQuery(dashboardQueryOptions(search))
  const data = query.data
  const setRange = (next: DashboardSearch) => navigate({ search: next })
  const failed = query.isError && !data

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader title="Dashboard" description="Clients, revenue and moderation across ShieldComment." />
        <RangePicker search={search} shown={data} onChange={setRange} />
      </div>

      {failed ? (
        <DashboardError
          error={query.error}
          onRetry={() => void query.refetch()}
          onReset={() => setRange({})}
        />
      ) : (
        <div
          className="flex flex-col gap-4 transition-opacity aria-busy:opacity-60"
          aria-busy={query.isFetching && query.isPlaceholderData ? true : undefined}
        >
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            {data ? (
              <>
                <span data-testid="resolved-range">
                  {formatRangeLabel(data.from, data.to)} · Dhaka time
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium ring-1 ring-border">
                  {data.granularity === 'day' ? 'Daily' : 'Monthly'}
                </span>
              </>
            ) : (
              <Skeleton className="h-4 w-56 rounded-full" />
            )}
          </div>
          <KpiCards
            kpis={data?.kpis}
            newClients={data?.series.growth.reduce((sum, p) => sum + p.newClients, 0) ?? 0}
          />
          <div className="grid gap-4 lg:grid-cols-5">
            <GrowthChart data={data?.series.growth} />
            <PlanTiersChart data={data?.series.planTiers} />
            <CommentsChart data={data?.series.comments} />
            <GatewaysChart data={data?.series.gateways} />
          </div>
        </div>
      )}
    </div>
  )
}

function DashboardError({
  error,
  onRetry,
  onReset,
}: {
  error: Error
  onRetry: () => void
  onReset: () => void
}) {
  const badRange = error instanceof ApiError && error.status === 400
  return (
    <section
      role="alert"
      className="flex flex-col items-center gap-3 rounded-3xl border bg-card px-6 py-16 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert className="size-6" aria-hidden />
      </span>
      <h2 className="text-base font-semibold">
        {badRange ? 'This date range can’t be shown' : 'Couldn’t load the dashboard'}
      </h2>
      <p className="max-w-md text-sm text-balance text-muted-foreground">{error.message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {badRange && <Button onClick={onReset}>Show last 30 days</Button>}
        <Button variant="outline" onClick={onRetry}>
          <RotateCcw data-icon="inline-start" />
          Try again
        </Button>
      </div>
    </section>
  )
}

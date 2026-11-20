import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ActivityChart, DashboardError, FlaggedChart, IntentsChart, KpiCards } from '@/components/dashboard/dashboard-charts'
import { useLanguage } from '@/hooks/use-language'
import { toApiError } from '@/lib/api'
import {
  dashboardLoadErrorMessage,
  dashboardSummaryQueryOptions,
  DEFAULT_SUMMARY_RANGE,
  rangeSearch,
  SUMMARY_RANGES,
  type SummaryRange,
  validateDashboardSearch,
} from '@/lib/dashboard-summary'

/** C4 `/dashboard` (M6-T8, D10 a): range pills, 4 KPIs, Line / Bar / Donut. */
export const Route = createFileRoute('/_app/dashboard')({
  head: () => ({ meta: [{ title: 'Dashboard | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  validateSearch: validateDashboardSearch,
  component: DashboardPage,
})

function DashboardPage() {
  const { session } = Route.useRouteContext()
  const { content } = useLanguage()
  const workspaceId = session.session.activeOrganizationId

  return (
    <div className="flex flex-col gap-6">
      {workspaceId ? (
        <DashboardView workspaceId={workspaceId} />
      ) : (
        <>
          <h1 className="text-2xl font-semibold">{content('Dashboard', 'ড্যাশবোর্ড')}</h1>
          <p className="rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
            {content('No workspace is selected for this account yet.', 'এই অ্যাকাউন্টে এখনো কোনো ওয়ার্কস্পেস বেছে নেওয়া হয়নি।')}
          </p>
        </>
      )}
    </div>
  )
}

function DashboardView({ workspaceId }: { workspaceId: string }) {
  const { content } = useLanguage()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const range = search.range ?? DEFAULT_SUMMARY_RANGE
  const query = useQuery(dashboardSummaryQueryOptions(workspaceId, range))
  const data = query.data
  const failed = query.isError && !data

  const labels: Record<SummaryRange, string> = {
    '7d': content('7 days', '৭ দিন'),
    '30d': content('30 days', '৩০ দিন'),
    '90d': content('90 days', '৯০ দিন'),
  }

  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{content('Dashboard', 'ড্যাশবোর্ড')}</h1>
          <p className="text-sm text-muted-foreground">
            {content('How the AI kept your ad comments clean.', 'AI কীভাবে আপনার অ্যাডের কমেন্ট পরিষ্কার রেখেছে।')}
          </p>
        </div>
        <div role="group" aria-label={content('Date range', 'সময়সীমা')} className="flex gap-1 self-start rounded-full border bg-card p-1">
          {SUMMARY_RANGES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={value === range}
              onClick={() => void navigate({ search: rangeSearch(value) })}
              className="rounded-full px-3.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground"
            >
              {labels[value]}
            </button>
          ))}
        </div>
      </div>

      {failed ? (
        <DashboardError
          message={dashboardLoadErrorMessage(toApiError(query.error), content)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <div
          className="flex flex-col gap-4 transition-opacity aria-busy:opacity-60"
          aria-busy={query.isFetching && query.isPlaceholderData ? true : undefined}
        >
          <KpiCards kpis={data?.kpis} />
          <ActivityChart data={data?.daily} />
          <div className="grid gap-4 lg:grid-cols-2">
            <FlaggedChart data={data?.flagged} />
            <IntentsChart data={data?.intents} />
          </div>
        </div>
      )}
    </>
  )
}

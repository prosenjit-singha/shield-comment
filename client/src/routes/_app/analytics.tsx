import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { CsvDownloads, FlaggedHistoryChart, TotalsTable } from '@/components/analytics/analytics-panels'
import { ActivityChart, DashboardError, IntentsChart } from '@/components/dashboard/dashboard-charts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLanguage } from '@/hooks/use-language'
import {
  type AnalyticsSearch,
  analyticsLoadErrorMessage,
  analyticsQueryOptions,
  dhakaToday,
  formatBucket,
  formatDate,
  isValidRange,
  MIN_ANALYTICS_DAY,
  rangeErrorMessage,
  validateAnalyticsSearch,
} from '@/lib/analytics'
import { toApiError } from '@/lib/api'
import { workspacePagesQueryOptions } from '@/lib/meta-pages'

/** C9 `/analytics` (M6-T12; D11 a, D12 b, D13 a): every member, impersonated ok. History by day / month + CSV. */
export const Route = createFileRoute('/_app/analytics')({
  head: () => ({ meta: [{ title: 'Analytics | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  validateSearch: (raw: Record<string, unknown>): AnalyticsSearch => validateAnalyticsSearch(raw),
  component: AnalyticsPage,
})

function AnalyticsPage() {
  const { session } = Route.useRouteContext()
  const { content } = useLanguage()
  const workspaceId = session.session.activeOrganizationId

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{content('Analytics', 'অ্যানালিটিক্স')}</h1>
        <p className="text-sm text-muted-foreground">
          {content(
            'Your moderation history by day or month, with CSV downloads.',
            'দিন বা মাস অনুযায়ী আপনার মডারেশনের ইতিহাস, CSV ডাউনলোডসহ।',
          )}
        </p>
      </div>
      {workspaceId ? (
        <AnalyticsView workspaceId={workspaceId} />
      ) : (
        <p className="rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
          {content('No workspace is selected for this account yet.', 'এই অ্যাকাউন্টে এখনো কোনো ওয়ার্কস্পেস বেছে নেওয়া হয়নি।')}
        </p>
      )}
    </div>
  )
}

function AnalyticsView({ workspaceId }: { workspaceId: string }) {
  const { content, language } = useLanguage()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const filters: AnalyticsSearch = { from: search.from, to: search.to, pageId: search.pageId }
  const query = useQuery(analyticsQueryOptions(workspaceId, filters))
  const pages = useQuery(workspacePagesQueryOptions(workspaceId))
  const data = query.data
  const failed = query.isError && !data

  const setFilters = (patch: AnalyticsSearch) => void navigate({ search: (prev) => ({ ...prev, ...patch }) })
  const formatKey = (key: string) => formatBucket(key, data?.granularity ?? 'day', language)
  const byMonth = data?.granularity === 'month'
  const bucketText = byMonth
    ? content('Every month of the range, Dhaka time.', 'বেছে নেওয়া সময়ের প্রতি মাস, ঢাকা সময়।')
    : content('Every day of the range, Dhaka time.', 'বেছে নেওয়া সময়ের প্রতিদিন, ঢাকা সময়।')

  return (
    <>
      <div className="flex flex-col gap-3 rounded-3xl border bg-card p-4 md:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <RangeForm
            key={`${search.from ?? data?.from ?? ''}|${search.to ?? data?.to ?? ''}`}
            initialFrom={search.from ?? data?.from ?? ''}
            initialTo={search.to ?? data?.to ?? ''}
            onApply={(from, to) => setFilters({ from, to })}
          />
          <label className="flex flex-col gap-1 text-sm font-medium md:ml-auto">
            {content('Page', 'পেজ')}
            <select
              value={search.pageId ?? ''}
              onChange={(event) => setFilters({ pageId: event.target.value || undefined })}
              className="h-10 rounded-full border border-input bg-transparent px-4 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="">{content('All Pages', 'সব পেজ')}</option>
              {pages.data?.items.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.igUsername ? `${page.pageName} · @${page.igUsername}` : page.pageName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {data ? (
            <span data-testid="range-summary">
              {`${formatDate(data.from, language)} – ${formatDate(data.to, language)} · `}
              {byMonth ? content('by month', 'মাস অনুযায়ী') : content('by day', 'দিন অনুযায়ী')}
              {data.page ? ` · ${data.page.name}` : ''}
            </span>
          ) : null}
          {search.from ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters({ from: undefined, to: undefined })}>
              {content('Back to the last 30 days', 'শেষ ৩০ দিনে ফিরুন')}
            </Button>
          ) : null}
        </div>
      </div>

      {failed ? (
        <DashboardError
          title={content('Couldn’t load analytics', 'অ্যানালিটিক্স লোড করা যায়নি')}
          message={analyticsLoadErrorMessage(toApiError(query.error), Boolean(search.pageId), content)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <div
          className="flex flex-col gap-4 transition-opacity aria-busy:opacity-60"
          aria-busy={query.isFetching && query.isPlaceholderData ? true : undefined}
        >
          <ActivityChart
            data={data?.series.map((b) => ({ day: b.bucket, scanned: b.scanned, autoHidden: b.autoHidden }))}
            formatKey={formatKey}
            description={bucketText}
          />
          <FlaggedHistoryChart data={data?.series} formatKey={formatKey} description={bucketText} />
          <div className="grid gap-4 lg:grid-cols-2">
            <TotalsTable totals={data?.totals} />
            <IntentsChart data={data?.intents} />
          </div>
        </div>
      )}

      <CsvDownloads workspaceId={workspaceId} search={filters} />
    </>
  )
}

function RangeForm({ initialFrom, initialTo, onApply }: { initialFrom: string; initialTo: string; onApply: (from: string, to: string) => void }) {
  const { content } = useLanguage()
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(initialTo)
  const [invalid, setInvalid] = useState(false)
  const today = dhakaToday()
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const ok = Boolean(from && to) && isValidRange(from, to)
        setInvalid(!ok)
        if (ok) onApply(from, to)
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {content('From', 'শুরু')}
          <Input type="date" value={from} min={MIN_ANALYTICS_DAY} max={today} onChange={(e) => setFrom(e.target.value)} className="h-10 px-4" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {content('To', 'শেষ')}
          <Input type="date" value={to} min={MIN_ANALYTICS_DAY} max={today} onChange={(e) => setTo(e.target.value)} className="h-10 px-4" />
        </label>
        <Button type="submit" variant="outline" className="h-10 px-4">
          {content('Apply', 'প্রয়োগ করুন')}
        </Button>
      </div>
      {invalid ? (
        <p role="alert" className="text-sm text-destructive">
          {rangeErrorMessage(content)}
        </p>
      ) : null}
    </form>
  )
}

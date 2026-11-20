import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Download, LoaderCircle, ShieldCheck } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisProps, CATEGORY_COLORS, CHART_HEIGHT } from '@/components/dashboard/chart-theme'
import { ChartCard, ChartSkeleton, ChartTooltip, EmptyOverlay, LegendItem } from '@/components/dashboard/dashboard-charts'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import {
  type AnalyticsBucket,
  type AnalyticsCounts,
  type AnalyticsSearch,
  CSV_MAX_DAYS,
  csvErrorMessage,
  csvPath,
  type CsvKind,
  csvTooLongMessage,
  downloadCsv,
  rangeDays,
} from '@/lib/analytics'
import { toApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import { categoryLabel, formatCount } from '@/lib/dashboard-summary'
import type { ModerationCategory } from '@/lib/moderation-policy'

/* C9 `/analytics` pieces (M6-T12) on top of the C4 chart parts (`dashboard-charts.tsx`). */

const FLAGGED: { category: ModerationCategory; key: 'competitorPoach' | 'scamPhishing' | 'spamIrrelevant' | 'abusiveToxic' }[] = [
  { category: 'SCAM_PHISHING', key: 'scamPhishing' },
  { category: 'COMPETITOR_POACH', key: 'competitorPoach' },
  { category: 'SPAM_IRRELEVANT', key: 'spamIrrelevant' },
  { category: 'ABUSIVE_TOXIC', key: 'abusiveToxic' },
]

/** Bar: flagged comments per bucket, stacked by category. */
export function FlaggedHistoryChart({
  data,
  formatKey,
  description,
}: {
  data: AnalyticsBucket[] | undefined
  formatKey: (key: string) => string
  description: string
}) {
  const { content, language } = useLanguage()
  const empty = data !== undefined && data.every((b) => FLAGGED.every(({ key }) => b[key] === 0))
  return (
    <ChartCard
      title={content('Flagged comments over time', 'সময়ের সাথে চিহ্নিত কমেন্ট')}
      description={description}
      legend={
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {FLAGGED.map(({ category }) => (
            <LegendItem key={category} color={CATEGORY_COLORS[category]} label={categoryLabel(category, content)} />
          ))}
        </div>
      }
    >
      {data === undefined ? (
        <ChartSkeleton />
      ) : (
        <div className="relative h-64" data-testid="flagged-history-chart">
          <div className={empty ? 'opacity-40' : undefined} aria-hidden={empty || undefined}>
            <ResponsiveContainer width="100%" height={CHART_HEIGHT} initialDimension={{ width: 560, height: CHART_HEIGHT }}>
              <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="bucket" {...axisProps} tickFormatter={formatKey} interval="preserveStartEnd" minTickGap={24} />
                <YAxis
                  {...axisProps}
                  width={44}
                  allowDecimals={false}
                  tickFormatter={(v: number) => formatCount(v, language)}
                  domain={[0, (max: number) => Math.max(max, 4)]}
                />
                {!empty && <Tooltip cursor={{ fill: 'var(--muted)' }} content={<ChartTooltip title={(key) => formatKey(String(key))} />} />}
                {FLAGGED.map(({ category, key }) => (
                  <Bar key={key} dataKey={key} stackId="flagged" name={categoryLabel(category, content)} fill={CATEGORY_COLORS[category]} maxBarSize={28} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          {empty && (
            <EmptyOverlay
              icon={ShieldCheck}
              title={content('Nothing flagged in this range', 'এই সময়ে কিছু চিহ্নিত হয়নি')}
              body={content('Scams, spam, abuse and poaching show up here.', 'স্ক্যাম, স্প্যাম, গালিগালাজ ও প্রতিযোগীর প্রচার এখানে দেখা যাবে।')}
            />
          )}
        </div>
      )}
    </ChartCard>
  )
}

const TOTAL_ROWS: { key: keyof AnalyticsCounts; label: (c: ContentFn) => string }[] = [
  { key: 'received', label: (c) => c('Comments received', 'প্রাপ্ত কমেন্ট') },
  { key: 'scanned', label: (c) => c('Scanned (AI + rules)', 'স্ক্যান (AI + নিয়ম)') },
  { key: 'classified', label: (c) => c('Checked by the AI', 'AI যাচাই করেছে') },
  { key: 'ruleMatched', label: (c) => c('Matched a rule', 'নিয়মে মিলেছে') },
  { key: 'autoHidden', label: (c) => c('Auto-hidden or deleted', 'অটো-হাইড বা ডিলিট') },
  { key: 'hidden', label: (c) => c('Hidden', 'হাইড') },
  { key: 'deleted', label: (c) => c('Deleted', 'ডিলিট') },
  { key: 'unhidden', label: (c) => c('Unhidden', 'আনহাইড') },
  { key: 'replied', label: (c) => c('Auto-replied', 'অটো-রিপ্লাই') },
  { key: 'edited', label: (c) => c('Edited by the author', 'লেখক এডিট করেছেন') },
  { key: 'removed', label: (c) => c('Removed on Facebook / Instagram', 'ফেসবুক / ইনস্টাগ্রামে মুছে ফেলা') },
  { key: 'skipped', label: (c) => c('Skipped (no plan or limit reached)', 'বাদ পড়েছে (প্ল্যান নেই বা লিমিট শেষ)') },
  { key: 'failed', label: (c) => c('Failed', 'ব্যর্থ') },
]

export function TotalsTable({ totals }: { totals: AnalyticsCounts | undefined }) {
  const { content, language } = useLanguage()
  const title = content('Totals', 'মোট হিসাব')
  return (
    <ChartCard title={title} description={content('Automatic moderation in this range.', 'এই সময়ের স্বয়ংক্রিয় মডারেশন।')}>
      {totals ? (
        <table className="w-full text-sm" data-testid="analytics-totals">
          <caption className="sr-only">{title}</caption>
          <tbody>
            {TOTAL_ROWS.map(({ key, label }) => (
              <tr key={key} className="border-b last:border-0">
                <th scope="row" className="py-2 pr-4 text-left font-normal text-muted-foreground">
                  {label(content)}
                </th>
                <td className="py-2 text-right font-medium tabular-nums" data-testid={`total-${key}`}>
                  {formatCount(totals[key], language)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="flex flex-col gap-3" aria-hidden data-testid="totals-skeleton">
          {TOTAL_ROWS.map(({ key }) => (
            <Skeleton key={key} className="h-5 w-full rounded-full" />
          ))}
        </div>
      )}
    </ChartCard>
  )
}

/** The two CSV downloads (D12 b) with the page's filters. */
export function CsvDownloads({ workspaceId, search }: { workspaceId: string; search: AnalyticsSearch }) {
  const { content } = useLanguage()
  return (
    <ChartCard
      title={content('Download CSV', 'CSV ডাউনলোড')}
      description={content(
        'Same range and Page as above. Opens in Excel or Google Sheets.',
        'উপরের একই সময়সীমা ও পেজ। Excel বা Google Sheets-এ খোলা যায়।',
      )}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <CsvLink
          workspaceId={workspaceId}
          search={search}
          kind="daily"
          title={content('Daily totals', 'দৈনিক হিসাব')}
          body={content('One row per day, Page and platform. No comment text.', 'প্রতিদিন, পেজ ও প্ল্যাটফর্মের জন্য এক সারি। কমেন্টের লেখা নেই।')}
        />
        <CsvLink
          workspaceId={workspaceId}
          search={search}
          kind="comments"
          title={content('Every comment', 'প্রতিটি কমেন্ট')}
          body={content(
            'Time, Page, text, status, category and last action. Up to 92 days.',
            'সময়, পেজ, লেখা, স্ট্যাটাস, ক্যাটাগরি ও শেষ অ্যাকশন। সর্বোচ্চ ৯২ দিন।',
          )}
          pro
        />
      </div>
    </ChartCard>
  )
}

const linkClass =
  'inline-flex h-9 items-center gap-1.5 self-start rounded-full border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted aria-disabled:pointer-events-none aria-disabled:opacity-50'

function CsvLink({
  workspaceId,
  search,
  kind,
  title,
  body,
  pro = false,
}: {
  workspaceId: string
  search: AnalyticsSearch
  kind: CsvKind
  title: string
  body: string
  pro?: boolean
}) {
  const { content } = useLanguage()
  const href = csvPath(workspaceId, kind, search)
  const download = useMutation({ mutationFn: () => downloadCsv(href) })
  const tooLong = rangeDays(search) > CSV_MAX_DAYS[kind]
  const failure = download.error ? csvErrorMessage(toApiError(download.error), kind, Boolean(search.pageId), content) : null

  return (
    <div className="flex flex-col gap-2 rounded-2xl border p-4" data-testid={`csv-${kind}`}>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {pro ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Pro</span> : null}
      </div>
      <p className="text-sm text-muted-foreground">{body}</p>
      {tooLong ? (
        <>
          <span role="link" aria-disabled="true" className={linkClass}>
            <Download className="size-4" aria-hidden />
            {content('Download', 'ডাউনলোড')}
          </span>
          <p className="text-sm text-muted-foreground">{csvTooLongMessage(kind, content)}</p>
        </>
      ) : (
        <a
          href={href}
          download
          className={linkClass}
          aria-disabled={download.isPending || undefined}
          onClick={(event) => {
            // Fetch first so a 409 / 400 shows a message instead of a broken file.
            event.preventDefault()
            if (!download.isPending) download.mutate()
          }}
        >
          {download.isPending ? (
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <Download className="size-4" aria-hidden />
          )}
          {content('Download', 'ডাউনলোড')}
        </a>
      )}
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure.message}{' '}
          {failure.plan ? (
            <Link to="/plans" className="font-medium text-primary underline underline-offset-4">
              {content('See plans', 'প্ল্যান দেখুন')}
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}

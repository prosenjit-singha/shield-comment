import type { LucideIcon } from 'lucide-react'
import { ChartPie, EyeOff, MessageSquareText, RotateCcw, ScanSearch, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import { categoryLabel, type CategoryCount, type DashboardSummary, formatCount, formatDay, type SummaryDay } from '@/lib/dashboard-summary'
import type { ModerationCategory } from '@/lib/moderation-policy'
import { axisProps, CATEGORY_COLORS, CHART_HEIGHT } from './chart-theme'

/*
 * C4 charts (M6-T8): Recharts with shadcn tokens only (`var(--primary)`, `--secondary`, `--chart-*`,
 * `--border`, `--muted-foreground`), the admin M2-T6 pattern without the shadcn `chart` component.
 * `undefined` data = skeleton; all-zero data keeps the chart slot and lays an empty overlay on top.
 */

/** Recharts measures its parent with ResizeObserver; this is the size before the first measure. */
const INITIAL_SIZE = { width: 560, height: CHART_HEIGHT }

const LINE_COLORS = { scanned: 'var(--primary)', autoHidden: 'var(--secondary)' }

// ---------------------------------------------------------------------------------------------
// KPI cards

type KpiKey = keyof DashboardSummary['kpis']

export function KpiCards({ kpis }: { kpis: DashboardSummary['kpis'] | undefined }) {
  const { content, language } = useLanguage()
  const cards: { key: KpiKey; icon: LucideIcon; label: string; caption: string }[] = [
    {
      key: 'scanned',
      icon: ScanSearch,
      label: content('Comments scanned', 'স্ক্যান করা কমেন্ট'),
      caption: content('AI checks + rule matches', 'AI যাচাই + রুল মিল'),
    },
    {
      key: 'autoHidden',
      icon: EyeOff,
      label: content('Auto-hidden', 'অটো-হাইড'),
      caption: content('Hidden or deleted for you', 'আপনার হয়ে হাইড বা ডিলিট'),
    },
    {
      key: 'needsReview',
      icon: MessageSquareText,
      label: content('Needs review', 'রিভিউ দরকার'),
      caption: content('Waiting right now', 'এই মুহূর্তে অপেক্ষায়'),
    },
    {
      key: 'scamsBlocked',
      icon: ShieldAlert,
      label: content('Scams blocked', 'স্ক্যাম ঠেকানো হয়েছে'),
      caption: content('bKash / Nagad scams and phishing', 'বিকাশ / নগদ স্ক্যাম ও ফিশিং'),
    },
  ]
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map(({ key, icon: Icon, label, caption }) => (
        <section key={key} aria-label={label} className="flex min-w-0 flex-col gap-3 rounded-2xl border bg-card p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="truncate text-sm text-muted-foreground">{label}</h2>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Icon className="size-4" aria-hidden />
            </span>
          </div>
          {kpis ? (
            <>
              <p className="truncate text-3xl font-semibold tracking-tight tabular-nums" data-testid={`kpi-${key}`}>
                {formatCount(kpis[key], language)}
              </p>
              <p className="truncate text-xs text-muted-foreground">{caption}</p>
            </>
          ) : (
            <div aria-hidden className="flex flex-col gap-2.5 py-1" data-testid="kpi-skeleton">
              <Skeleton className="h-8 w-24 rounded-full" />
              <Skeleton className="h-3 w-36 rounded-full" />
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Shared pieces

export function ChartCard({
  title,
  description,
  legend,
  className,
  children,
}: {
  title: string
  description: string
  legend?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section aria-label={title} className={`flex min-w-0 flex-col gap-4 rounded-3xl border bg-card p-4 md:p-6 ${className ?? ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {legend}
      </div>
      {children}
    </section>
  )
}

export function ChartSkeleton() {
  return (
    <div className="flex h-64 items-end gap-2 px-2 pb-6" aria-hidden data-testid="chart-skeleton">
      {[40, 65, 50, 80, 55, 70, 90, 60, 75, 45, 85, 68].map((h, i) => (
        <Skeleton key={i} className="flex-1 rounded-full" style={{ height: `${h}%` }} />
      ))}
    </div>
  )
}

export function EmptyOverlay({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-xs text-xs text-balance text-muted-foreground">{body}</p>
    </div>
  )
}

export function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
  )
}

interface TooltipRow {
  name?: string | number
  value?: unknown
  color?: string
  dataKey?: unknown
  payload?: { fill?: string }
}

/** Tooltip body. Recharts clones it with `active`, `payload` and `label`. */
export function ChartTooltip({
  active,
  payload,
  label,
  title,
}: {
  active?: boolean
  payload?: ReadonlyArray<TooltipRow>
  label?: string | number
  title?: (label: string | number | undefined) => string
}) {
  const { language } = useLanguage()
  if (!active || !payload?.length) return null
  return (
    <div className="flex min-w-36 flex-col gap-1.5 rounded-2xl border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      {title ? <p className="font-medium">{title(label)}</p> : null}
      {payload.map((row) => (
        <div key={String(row.dataKey ?? row.name)} className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-full" style={{ backgroundColor: row.color ?? row.payload?.fill }} aria-hidden />
            {row.name}
          </span>
          <span className="font-medium tabular-nums">{formatCount(Number(row.value ?? 0), language)}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Line: scanned vs auto-hidden per day (or per month on `/analytics`)

export function ActivityChart({
  data,
  formatKey,
  description,
}: {
  data: SummaryDay[] | undefined
  /** X-axis + tooltip label of a `day` key (default `formatDay`; `/analytics` passes months too). */
  formatKey?: (key: string) => string
  description?: string
}) {
  const { content, language } = useLanguage()
  const label = formatKey ?? ((day: string) => formatDay(day, language))
  const empty = data !== undefined && data.every((d) => d.scanned === 0 && d.autoHidden === 0)
  const scanned = content('Scanned', 'স্ক্যান')
  const autoHidden = content('Auto-hidden', 'অটো-হাইড')
  const count = (value: number) => formatCount(value, language)
  return (
    <ChartCard
      title={content('Comments scanned vs. auto-hidden', 'স্ক্যান করা বনাম অটো-হাইড কমেন্ট')}
      description={description ?? content('Every day of the range, Dhaka time.', 'বেছে নেওয়া সময়ের প্রতিদিন, ঢাকা সময়।')}
      legend={
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <LegendItem color={LINE_COLORS.scanned} label={scanned} />
          <LegendItem color={LINE_COLORS.autoHidden} label={autoHidden} />
        </div>
      }
    >
      {data === undefined ? (
        <ChartSkeleton />
      ) : (
        <div className="relative h-64" data-testid="activity-chart">
          <div className={empty ? 'opacity-40' : undefined} aria-hidden={empty || undefined}>
            <ResponsiveContainer width="100%" height={CHART_HEIGHT} initialDimension={INITIAL_SIZE}>
              <LineChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="day"
                  {...axisProps}
                  tickFormatter={label}
                  interval="preserveStartEnd"
                  minTickGap={24}
                />
                <YAxis {...axisProps} width={44} allowDecimals={false} tickFormatter={count} domain={[0, (max: number) => Math.max(max, 4)]} />
                {!empty && (
                  <Tooltip
                    cursor={{ stroke: 'var(--border)' }}
                    content={<ChartTooltip title={(day) => label(String(day))} />}
                  />
                )}
                <Line type="monotone" dataKey="scanned" name={scanned} stroke={LINE_COLORS.scanned} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                <Line
                  type="monotone"
                  dataKey="autoHidden"
                  name={autoHidden}
                  stroke={LINE_COLORS.autoHidden}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {empty && (
            <EmptyOverlay
              icon={ScanSearch}
              title={content('No comments scanned in this range', 'এই সময়ে কোনো কমেন্ট স্ক্যান হয়নি')}
              body={content(
                'Numbers appear once moderation runs on your connected Pages.',
                'কানেক্টেড পেজে মডারেশন চালু হলে এখানে সংখ্যা দেখা যাবে।',
              )}
            />
          )}
        </div>
      )}
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------------------------
// Bar: flagged (non-SAFE) categories

export function FlaggedChart({ data }: { data: CategoryCount[] | undefined }) {
  const { content, language } = useLanguage()
  const empty = data !== undefined && data.every((c) => c.count === 0)
  const rows = (data ?? []).map((c) => ({ ...c, label: categoryLabel(c.category, content) }))
  return (
    <ChartCard
      title={content('Blocked categories', 'ব্লক করা ক্যাটাগরি')}
      description={content('Flagged comments by type in this range.', 'এই সময়ে ধরন অনুযায়ী চিহ্নিত কমেন্ট।')}
    >
      {data === undefined ? (
        <ChartSkeleton />
      ) : (
        <div className="relative h-64" data-testid="flagged-chart">
          <div className={empty ? 'opacity-40' : undefined} aria-hidden={empty || undefined}>
            <ResponsiveContainer width="100%" height={CHART_HEIGHT} initialDimension={{ width: 320, height: CHART_HEIGHT }}>
              <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid horizontal={false} stroke="var(--border)" />
                <XAxis
                  type="number"
                  {...axisProps}
                  allowDecimals={false}
                  tickFormatter={(v: number) => formatCount(v, language)}
                  domain={[0, (max: number) => Math.max(max, 4)]}
                />
                <YAxis type="category" dataKey="label" {...axisProps} width={112} />
                {!empty && <Tooltip cursor={{ fill: 'var(--muted)' }} content={<ChartTooltip />} />}
                <Bar dataKey="count" name={content('Comments', 'কমেন্ট')} radius={[0, 8, 8, 0]} maxBarSize={28}>
                  {rows.map((c) => (
                    <Cell key={c.category} fill={CATEGORY_COLORS[c.category]} />
                  ))}
                </Bar>
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

// ---------------------------------------------------------------------------------------------
// Donut: all five intents

export function IntentsChart({ data }: { data: CategoryCount[] | undefined }) {
  const { content, language } = useLanguage()
  const total = data?.reduce((sum, c) => sum + c.count, 0) ?? 0
  const empty = data !== undefined && total === 0
  const slices = (data ?? []).map((c) => ({ ...c, label: categoryLabel(c.category, content) }))
  const ring = empty ? [{ category: 'none', count: 1, label: '' }] : slices
  return (
    <ChartCard
      title={content('Comment intent breakdown', 'কমেন্টের ধরন বিশ্লেষণ')}
      description={content('Every classified comment in this range.', 'এই সময়ে যাচাই করা সব কমেন্ট।')}
    >
      {data === undefined ? (
        <div className="flex h-64 items-center justify-center" aria-hidden data-testid="chart-skeleton">
          <Skeleton className="size-44 rounded-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="intents-chart">
          <div className="relative h-52">
            <ResponsiveContainer width="100%" height={208} initialDimension={{ width: 320, height: 208 }}>
              <PieChart>
                <Pie
                  data={ring}
                  dataKey="count"
                  nameKey="label"
                  innerRadius="68%"
                  outerRadius="92%"
                  paddingAngle={empty ? 0 : 2}
                  cornerRadius={empty ? 0 : 6}
                  stroke="none"
                  isAnimationActive={!empty}
                >
                  {ring.map((slice) => (
                    <Cell
                      key={slice.category}
                      fill={slice.category === 'none' ? 'var(--muted)' : CATEGORY_COLORS[slice.category as ModerationCategory]}
                    />
                  ))}
                </Pie>
                {!empty && <Tooltip content={<ChartTooltip />} />}
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              {empty ? (
                <>
                  <ChartPie className="mb-1 size-5 text-muted-foreground" aria-hidden />
                  <p className="text-sm font-semibold">{content('No comments yet', 'এখনো কোনো কমেন্ট নেই')}</p>
                </>
              ) : (
                <>
                  <p className="text-2xl font-semibold tabular-nums">{formatCount(total, language)}</p>
                  <p className="text-xs text-muted-foreground">{content('comments', 'কমেন্ট')}</p>
                </>
              )}
            </div>
          </div>
          <ul className="flex flex-col gap-1.5">
            {slices.map((slice) => (
              <li key={slice.category} className="flex items-center justify-between gap-3 text-sm">
                <LegendItem color={CATEGORY_COLORS[slice.category]} label={slice.label} />
                <span className="tabular-nums">
                  {formatCount(slice.count, language)}
                  {total > 0 ? (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {formatCount(Math.round((slice.count / total) * 100), language)}%
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  )
}

/** Load failure with retry (keeps the page header and range pills above it). */
export function DashboardError({
  message,
  onRetry,
  retrying,
  title,
}: {
  message: string
  onRetry: () => void
  retrying: boolean
  /** Default: the dashboard's heading (`/comments` passes its own). */
  title?: string
}) {
  const { content } = useLanguage()
  return (
    <section role="alert" className="flex flex-col items-center gap-3 rounded-3xl border bg-card px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert className="size-6" aria-hidden />
      </span>
      <h2 className="text-base font-semibold">{title ?? content('Couldn’t load your dashboard', 'আপনার ড্যাশবোর্ড লোড করা যায়নি')}</h2>
      <p className="max-w-md text-sm text-balance text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry} disabled={retrying}>
        <RotateCcw aria-hidden />
        {content('Try again', 'আবার চেষ্টা করুন')}
      </Button>
    </section>
  )
}

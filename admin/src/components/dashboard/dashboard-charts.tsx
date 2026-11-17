import type { LucideIcon } from 'lucide-react'
import { CreditCard, MessageSquareText, PieChart as PieIcon, Users } from 'lucide-react'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  type CommentsPoint,
  formatBdt,
  formatBdtCompact,
  formatBucketLabel,
  formatBucketTick,
  formatCount,
  type GatewaySlice,
  type GrowthPoint,
  type PlanTierSlice,
} from '@/lib/admin-dashboard'

/*
 * Recharts paired with shadcn tokens only (`--primary`, `--secondary`, `--chart-*`, `--muted`,
 * `--border`, `--muted-foreground`). Empty data keeps the same card + chart slot and lays an
 * overlay on top, so real data later swaps in without a layout change.
 */

const CHART_HEIGHT = 256
/** Recharts measures its parent with ResizeObserver; this is the size before the first measure. */
const INITIAL_SIZE = { width: 560, height: CHART_HEIGHT }
const SLICE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

const axisTick = { fill: 'var(--muted-foreground)', fontSize: 12 }
const axisProps = { tickLine: false, axisLine: false, tick: axisTick } as const

const COLORS = {
  mrr: 'var(--primary)',
  totalClients: 'var(--chart-3)',
  newClients: 'var(--chart-4)',
  scanned: 'var(--primary)',
  blocked: 'var(--secondary)',
}

/** A dashboard panel: `rounded-3xl` card with a title row and a fixed-height body. */
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
    <section
      aria-label={title}
      className={`flex min-w-0 flex-col gap-4 rounded-3xl border bg-card p-4 md:p-6 ${className ?? ''}`}
    >
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

/** Centered empty-state message on top of a chart slot. */
function EmptyOverlay({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
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

export function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {dashed ? (
        // Same dash as the chart line (`strokeDasharray="4 4"`), drawn rather than bordered.
        <svg width="14" height="4" viewBox="0 0 14 4" aria-hidden>
          <line x1="0" y1="2" x2="14" y2="2" stroke={color} strokeWidth="2" strokeDasharray="4 3" />
        </svg>
      ) : (
        <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      )}
      {label}
    </span>
  )
}

interface TooltipRow {
  name?: string | number
  value?: unknown
  color?: string
  dataKey?: unknown
}

/** Tooltip body. Recharts clones it with `active`, `payload` and `label`. */
function ChartTooltip({
  active,
  payload,
  label,
  formatValue,
  formatTitle = (l) => formatBucketLabel(String(l)),
}: {
  active?: boolean
  payload?: ReadonlyArray<TooltipRow>
  label?: string | number
  formatValue: (value: number, row: TooltipRow) => string
  formatTitle?: (label: string | number | undefined, rows: ReadonlyArray<TooltipRow>) => string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="flex min-w-36 flex-col gap-1.5 rounded-2xl border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="font-medium">{formatTitle(label, payload)}</p>
      {payload.map((row) => (
        <div key={String(row.dataKey ?? row.name)} className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-full" style={{ backgroundColor: row.color }} aria-hidden />
            {row.name}
          </span>
          <span className="font-medium tabular-nums">{formatValue(Number(row.value ?? 0), row)}</span>
        </div>
      ))}
    </div>
  )
}

const tooltipCursor = { fill: 'var(--muted)', stroke: 'var(--border)' }

/** Dual-axis line chart: MRR ৳ (left) and client total/new (right). */
export function GrowthChart({ data }: { data: GrowthPoint[] | undefined }) {
  const noClients = data !== undefined && data.every((p) => p.totalClients === 0 && p.newClients === 0)
  return (
    <ChartCard
      title="Revenue & client growth"
      description="MRR in taka against total and new clients."
      className="lg:col-span-3"
      legend={
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <LegendItem color={COLORS.mrr} label="MRR ৳" />
          <LegendItem color={COLORS.totalClients} label="Total clients" />
          <LegendItem color={COLORS.newClients} label="New clients" dashed />
        </div>
      }
    >
      {data === undefined ? (
        <ChartSkeleton />
      ) : (
        <div className="relative h-64" data-testid="growth-chart">
          <ResponsiveContainer width="100%" height={CHART_HEIGHT} initialDimension={INITIAL_SIZE}>
            <LineChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="bucket"
                {...axisProps}
                tickFormatter={formatBucketTick}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                yAxisId="mrr"
                {...axisProps}
                width={52}
                tickFormatter={formatBdtCompact}
                domain={[0, (max: number) => Math.max(max, 1000)]}
              />
              <YAxis
                yAxisId="clients"
                orientation="right"
                {...axisProps}
                width={36}
                allowDecimals={false}
                tickFormatter={formatCount}
                domain={[0, (max: number) => Math.max(max, 4)]}
              />
              <Tooltip
                cursor={{ stroke: 'var(--border)' }}
                content={
                  <ChartTooltip
                    formatValue={(v, row) => (row.dataKey === 'mrrBdt' ? formatBdt(v) : formatCount(v))}
                  />
                }
              />
              <Line
                yAxisId="mrr"
                type="monotone"
                dataKey="mrrBdt"
                name="MRR"
                stroke={COLORS.mrr}
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                yAxisId="clients"
                type="monotone"
                dataKey="totalClients"
                name="Total clients"
                stroke={COLORS.totalClients}
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                yAxisId="clients"
                type="monotone"
                dataKey="newClients"
                name="New clients"
                stroke={COLORS.newClients}
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
          {noClients && (
            <EmptyOverlay
              icon={Users}
              title="No clients in this range yet"
              body="Growth shows up here as brands sign up."
            />
          )}
        </div>
      )}
    </ChartCard>
  )
}

/** Grouped bars with rounded tops: scanned (`--primary`) vs blocked (`--secondary`). */
export function CommentsChart({ data }: { data: CommentsPoint[] | undefined }) {
  const empty = data !== undefined && data.every((p) => p.scanned === 0 && p.blocked === 0)
  return (
    <ChartCard
      title="Comments scanned vs. spam blocked"
      description="Every Facebook and Instagram ad comment the AI checked."
      className="lg:col-span-3"
      legend={
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <LegendItem color={COLORS.scanned} label="Scanned" />
          <LegendItem color={COLORS.blocked} label="Blocked" />
        </div>
      }
    >
      {data === undefined ? (
        <ChartSkeleton />
      ) : (
        <div className="relative h-64" data-testid="comments-chart">
          <div className={empty ? 'opacity-40' : undefined} aria-hidden={empty || undefined}>
            <ResponsiveContainer width="100%" height={CHART_HEIGHT} initialDimension={INITIAL_SIZE}>
              <BarChart data={data} barGap={2} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="bucket"
                  {...axisProps}
                  tickFormatter={formatBucketTick}
                  interval="preserveStartEnd"
                  minTickGap={24}
                />
                <YAxis
                  {...axisProps}
                  width={44}
                  allowDecimals={false}
                  tickFormatter={formatCount}
                  domain={[0, (max: number) => Math.max(max, 4)]}
                />
                {!empty && (
                  <Tooltip
                    cursor={tooltipCursor}
                    content={<ChartTooltip formatValue={(v) => formatCount(v)} />}
                  />
                )}
                <Bar dataKey="scanned" name="Scanned" fill={COLORS.scanned} radius={[6, 6, 0, 0]} maxBarSize={16} />
                <Bar dataKey="blocked" name="Blocked" fill={COLORS.blocked} radius={[6, 6, 0, 0]} maxBarSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {empty && (
            <EmptyOverlay
              icon={MessageSquareText}
              title="No comments scanned yet"
              body="Numbers appear once moderation runs on connected pages."
            />
          )}
        </div>
      )}
    </ChartCard>
  )
}

/** Donut of clients per plan tier. Empty = a muted ring with the message in the hole. */
export function PlanTiersChart({ data }: { data: PlanTierSlice[] | undefined }) {
  const total = data?.reduce((sum, s) => sum + s.clients, 0) ?? 0
  const empty = data !== undefined && total === 0
  const ring = empty ? [{ tier: 'none', clients: 1 }] : (data ?? [])
  return (
    <ChartCard
      title="Plan tiers"
      description="Paying clients per plan right now."
      className="lg:col-span-2"
    >
      {data === undefined ? (
        <div className="flex h-64 items-center justify-center" aria-hidden data-testid="chart-skeleton">
          <Skeleton className="size-44 rounded-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="plan-tiers-chart">
          <div className="relative h-52">
            <ResponsiveContainer width="100%" height={208} initialDimension={{ width: 320, height: 208 }}>
              <PieChart>
                <Pie
                  data={ring}
                  dataKey="clients"
                  nameKey="tier"
                  innerRadius="68%"
                  outerRadius="92%"
                  paddingAngle={empty || ring.length < 2 ? 0 : 2}
                  cornerRadius={empty ? 0 : 6}
                  stroke="none"
                  isAnimationActive={!empty}
                >
                  {ring.map((slice, i) => (
                    <Cell
                      key={slice.tier}
                      fill={empty ? 'var(--muted)' : SLICE_COLORS[i % SLICE_COLORS.length]}
                    />
                  ))}
                </Pie>
                {!empty && (
                  <Tooltip
                    content={
                      <ChartTooltip
                        formatTitle={(_, rows) => String(rows[0]?.name ?? '')}
                        formatValue={(v) => `${formatCount(v)} ${v === 1 ? 'client' : 'clients'}`}
                      />
                    }
                  />
                )}
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              {empty ? (
                <>
                  <PieIcon className="mb-1 size-5 text-muted-foreground" aria-hidden />
                  <p className="text-sm font-semibold">No plans yet</p>
                </>
              ) : (
                <>
                  <p className="text-2xl font-semibold tabular-nums">{formatCount(total)}</p>
                  <p className="text-xs text-muted-foreground">clients</p>
                </>
              )}
            </div>
          </div>
          {empty ? (
            <p className="text-center text-xs text-balance text-muted-foreground">
              The tier split appears here once paid plans launch.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {ring.map((slice, i) => (
                <li key={slice.tier} className="flex items-center justify-between gap-3 text-sm">
                  <LegendItem color={SLICE_COLORS[i % SLICE_COLORS.length]!} label={slice.tier} />
                  <span className="tabular-nums">
                    {formatCount(slice.clients)}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {Math.round((slice.clients / total) * 100)}%
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ChartCard>
  )
}

/** Horizontal bars of payment volume (৳) per gateway inside the range. */
export function GatewaysChart({ data }: { data: GatewaySlice[] | undefined }) {
  const empty = data !== undefined && data.every((g) => g.amountBdt === 0)
  return (
    <ChartCard
      title="Payment gateways"
      description="Volume by gateway through SSLCommerz."
      className="lg:col-span-2"
    >
      {data === undefined ? (
        <ChartSkeleton />
      ) : empty ? (
        <div className="relative h-64" data-testid="gateways-chart">
          <div className="flex h-full flex-col justify-center gap-5 px-2 opacity-60" aria-hidden>
            {['w-4/5', 'w-3/5', 'w-2/5'].map((w) => (
              <div key={w} className={`h-6 rounded-full bg-muted ${w}`} />
            ))}
          </div>
          <EmptyOverlay
            icon={CreditCard}
            title="No payments yet"
            body="bKash, Nagad and card volume shows here once billing is live."
          />
        </div>
      ) : (
        <div className="relative h-64" data-testid="gateways-chart">
          <ResponsiveContainer width="100%" height={CHART_HEIGHT} initialDimension={{ width: 320, height: CHART_HEIGHT }}>
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid horizontal={false} stroke="var(--border)" />
              <XAxis type="number" {...axisProps} tickFormatter={formatBdtCompact} />
              <YAxis type="category" dataKey="gateway" {...axisProps} width={84} />
              <Tooltip
                cursor={tooltipCursor}
                content={
                  <ChartTooltip
                    formatValue={(v) => formatBdt(v)}
                    formatTitle={(label, rows) => {
                      const slice = data.find((g) => g.gateway === label)
                      const n = slice?.transactions ?? 0
                      return `${String(label ?? rows[0]?.name ?? '')} · ${formatCount(n)} ${n === 1 ? 'payment' : 'payments'}`
                    }}
                  />
                }
              />
              <Bar dataKey="amountBdt" name="Volume" radius={[0, 8, 8, 0]} maxBarSize={28}>
                {data.map((g, i) => (
                  <Cell key={g.gateway} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  )
}

import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import { Cpu, Database, GitBranch, Layers, RefreshCw, RotateCcw, Server, Sparkles } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { PageHeader } from '@/components/placeholder-page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { aiProviderLabels } from '@/lib/admin-ai-settings'
import { formatRangeLabel } from '@/lib/admin-dashboard'
import {
  type AiUsageReport,
  type AiUsageWindow,
  type DependencyProbe,
  formatBdtAmount,
  formatCallLatency,
  formatFailureKind,
  formatModelPrice,
  formatTokens,
  formatUsd,
  sortedFailures,
  formatBytes,
  formatDhakaClock,
  formatDhakaDateTime,
  formatLatency,
  formatUptime,
  type MigrationState,
  migrationState,
  type MigrationStatus,
  type QueueStats,
  SYSTEM_POLL_INTERVAL_MS,
  type SystemProcessInfo,
  systemHealthQueryOptions,
} from '@/lib/admin-system'

export const Route = createFileRoute('/_authed/admin/system')({
  component: SystemPage,
})

/**
 * A6 (M2-T10, user decision 2026-11-18): DB + Redis with response times, process info, BullMQ
 * queue counts, the latest Drizzle migration and AI moderation usage (M5-T14, D14). Polls every 30 s only while the tab is visible:
 * the endpoint queries the DB, and Neon's free compute should be allowed to sleep.
 */
function SystemPage() {
  const query = useQuery(systemHealthQueryOptions())
  const data = query.data

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <PageHeader
          title="System"
          description="Live health of the database, Redis, the API process, queues, migrations and AI moderation."
        />
        <div className="flex items-center gap-3 sm:shrink-0">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {data ? (
              <>
                Last checked{' '}
                <time dateTime={data.checkedAt} className="tabular-nums" data-testid="last-checked">
                  {formatDhakaClock(data.checkedAt)}
                </time>
              </>
            ) : (
              'Checking…'
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw
              data-icon="inline-start"
              className={query.isFetching ? 'animate-spin motion-reduce:animate-none' : undefined}
              aria-hidden
            />
            Refresh
          </Button>
        </div>
      </div>

      {query.isError && !data ? (
        <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
      ) : (
        <>
          {query.isError && (
            <p
              role="status"
              className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              Couldn't refresh: {query.error.message}. Showing the last result.
            </p>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <ProbeCard title="Database" detail="PostgreSQL · select 1" icon={Database} probe={data?.database} />
            <ProbeCard title="Redis" detail="Sessions & queues · PING" icon={Server} probe={data?.redis} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ProcessCard info={data?.process} />
            <MigrationCard migrations={data?.migrations} />
          </div>

          <QueuesCard queues={data?.queues} />

          {/* An older backend without `ai` reads as unavailable, not as loading forever. */}
          <AiUsageCard ai={data ? (data.ai ?? null) : undefined} />
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Refreshes every {SYSTEM_POLL_INTERVAL_MS / 1000} s while this tab is visible and pauses when it's
        hidden. Times are in Bangladesh time.
      </p>
    </div>
  )
}

function Panel({
  title,
  icon: Icon,
  aside,
  children,
}: {
  title: string
  icon: LucideIcon
  aside?: ReactNode
  children: ReactNode
}) {
  const id = `panel-${title.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4 rounded-xl bg-card p-4 md:p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Icon className="size-4" aria-hidden />
          </span>
          <h2 id={id} className="truncate text-base font-semibold">
            {title}
          </h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

type PillTone = 'good' | 'bad' | 'warn' | 'muted'

const pillTones: Record<PillTone, string> = {
  good: 'bg-primary/10 text-primary',
  bad: 'bg-destructive/10 text-destructive',
  warn: 'bg-chart-4/15 text-foreground',
  muted: 'bg-muted text-muted-foreground',
}

function Pill({ tone, children, testId }: { tone: PillTone; children: ReactNode; testId?: string }) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${pillTones[tone]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  )
}

function ProbeCard({
  title,
  detail,
  icon,
  probe,
}: {
  title: string
  detail: string
  icon: LucideIcon
  probe: DependencyProbe | undefined
}) {
  const up = probe?.status === 'up'
  return (
    <Panel
      title={title}
      icon={icon}
      aside={
        probe ? (
          <Pill tone={up ? 'good' : 'bad'} testId={`${title.toLowerCase()}-status`}>
            {up ? 'Up' : 'Down'}
          </Pill>
        ) : (
          <Skeleton className="h-5 w-12 rounded-full" />
        )
      }
    >
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">Response time</p>
        {probe ? (
          <p
            data-testid={`${title.toLowerCase()}-latency`}
            className={`text-2xl font-semibold tracking-tight tabular-nums ${up ? '' : 'text-destructive'}`}
          >
            {formatLatency(probe.latencyMs)}
          </p>
        ) : (
          <Skeleton className="h-8 w-24 rounded-full" />
        )}
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </Panel>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  )
}

function FactSkeletons({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-2 gap-4" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-16 rounded-full" />
          <Skeleton className="h-4 w-24 rounded-full" />
        </div>
      ))}
    </div>
  )
}

function ProcessCard({ info }: { info: SystemProcessInfo | undefined }) {
  return (
    <Panel title="API process" icon={Cpu} aside={info && <Pill tone="muted">{info.environment}</Pill>}>
      {info ? (
        <dl className="grid grid-cols-2 gap-4">
          <Fact label="Uptime">
            <span data-testid="process-uptime">{formatUptime(info.uptimeSeconds)}</span>
          </Fact>
          <Fact label="Started">
            <time dateTime={info.startedAt}>{formatDhakaDateTime(info.startedAt)}</time>
          </Fact>
          <Fact label="Version">
            <span data-testid="process-version">v{info.version}</span>
          </Fact>
          <Fact label="Node.js">{info.nodeVersion}</Fact>
          <Fact label="Memory (RSS)">
            <span data-testid="process-rss">{formatBytes(info.memory.rssBytes)}</span>
          </Fact>
          {/* V8 grows the heap on demand, so used/total near 100% is normal: no gauge. */}
          <Fact label="Heap used / allocated">
            {formatBytes(info.memory.heapUsedBytes)} / {formatBytes(info.memory.heapTotalBytes)}
          </Fact>
        </dl>
      ) : (
        <FactSkeletons count={6} />
      )}
    </Panel>
  )
}

const migrationPills: Record<MigrationState, { tone: PillTone; label: (m: MigrationStatus) => string }> = {
  current: { tone: 'good', label: () => 'Up to date' },
  pending: { tone: 'warn', label: (m) => `${m.pending} pending` },
  ahead: { tone: 'warn', label: () => 'Not in this build' },
  none: { tone: 'muted', label: () => 'None applied' },
  unknown: { tone: 'bad', label: () => 'Unknown' },
}

function MigrationCard({ migrations }: { migrations: MigrationStatus | undefined }) {
  const state = migrations ? migrationState(migrations) : undefined
  const latest = migrations?.latest
  return (
    <Panel
      title="Migrations"
      icon={GitBranch}
      aside={
        migrations && state ? (
          <Pill tone={migrationPills[state].tone} testId="migration-status">
            {migrationPills[state].label(migrations)}
          </Pill>
        ) : (
          <Skeleton className="h-5 w-20 rounded-full" />
        )
      }
    >
      {!migrations ? (
        <FactSkeletons count={4} />
      ) : !migrations.known ? (
        <p className="text-sm text-muted-foreground">
          The migration journal can't be read while the database is down.
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-4">
          <div className="col-span-2 flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Latest applied</dt>
            <dd className="truncate font-mono text-sm font-medium" data-testid="migration-latest">
              {latest ? (latest.tag ?? 'Unknown to this build') : 'None yet'}
            </dd>
          </div>
          <Fact label="Applied">
            <span data-testid="migration-count">
              {migrations.applied} of {migrations.shipped}
            </span>
          </Fact>
          <Fact label="Generated">
            {latest ? <time dateTime={latest.createdAt}>{formatDhakaDateTime(latest.createdAt)}</time> : '—'}
          </Fact>
          {latest && (
            <div className="col-span-2 flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">Hash</dt>
              <dd className="truncate font-mono text-xs text-muted-foreground" title={latest.hash}>
                {latest.hash.slice(0, 16)}
              </dd>
            </div>
          )}
        </dl>
      )}
    </Panel>
  )
}

function QueuesCard({ queues }: { queues: QueueStats[] | undefined }) {
  return (
    <Panel title="Queues" icon={Layers} aside={<span className="text-xs text-muted-foreground">BullMQ</span>}>
      {!queues ? (
        <div className="flex flex-col gap-2" aria-hidden>
          <Skeleton className="h-4 w-full rounded-full" />
          <Skeleton className="h-4 w-2/3 rounded-full" />
        </div>
      ) : queues.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-muted px-6 py-10 text-center">
          <h3 className="text-sm font-semibold">No queues yet</h3>
          <p className="max-w-md text-sm text-balance text-muted-foreground">
            Waiting, active and failed jobs per queue show here once the comment moderation pipeline is running.
          </p>
        </div>
      ) : (
        <div className="-mx-4 overflow-x-auto md:-mx-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium md:px-5">
                  Queue
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Waiting
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Active
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium md:px-5">
                  Failed
                </th>
              </tr>
            </thead>
            <tbody>
              {queues.map((q) => (
                <tr key={q.name} data-testid="queue-row" className="border-b last:border-b-0">
                  <th scope="row" className="px-4 py-2.5 text-left font-mono text-xs font-medium md:px-5">
                    {q.name}
                  </th>
                  <td className="px-2 py-2.5 text-right tabular-nums">{q.waiting.toLocaleString('en-US')}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums">{q.active.toLocaleString('en-US')}</td>
                  <td
                    className={`px-4 py-2.5 text-right tabular-nums md:px-5 ${q.failed > 0 ? 'font-semibold text-destructive' : ''}`}
                  >
                    {q.failed.toLocaleString('en-US')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

type AiWindowKey = 'today' | 'last7Days'

const aiWindowLabels: Record<AiWindowKey, string> = { today: 'Today', last7Days: 'Last 7 days' }

const count = (n: number) => n.toLocaleString('en-US')

/**
 * A6 "AI moderation" (M5-T14, D14): platform-wide classification calls, tokens, cost estimate
 * (USD + ৳), latency and failures for today or the last 7 Dhaka days, per provider + model (no
 * credits since PW-T6b/PW-T7: the limit is monthly comments, shown per client on A3). `ai` undefined = loading, `null` = the backend couldn't read the usage.
 */
function AiUsageCard({ ai }: { ai: AiUsageReport | null | undefined }) {
  const [windowKey, setWindowKey] = useState<AiWindowKey>('today')
  return (
    <Panel
      title="AI moderation"
      icon={Sparkles}
      aside={
        ai ? (
          <Tabs value={windowKey} onValueChange={(v) => setWindowKey(v === 'last7Days' ? 'last7Days' : 'today')}>
            <TabsList aria-label="AI usage window" className="rounded-full">
              {(['today', 'last7Days'] as const).map((key) => (
                <TabsTrigger key={key} value={key} className="rounded-full px-3">
                  {aiWindowLabels[key]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : ai === undefined ? (
          <Skeleton className="h-8 w-40 rounded-full" />
        ) : undefined
      }
    >
      {ai === undefined ? (
        <FactSkeletons count={6} />
      ) : ai === null ? (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-muted px-6 py-10 text-center" data-testid="ai-unavailable">
          <h3 className="text-sm font-semibold">AI usage unavailable</h3>
          <p className="max-w-md text-sm text-balance text-muted-foreground">
            The usage numbers couldn't be read just now. The rest of the system check is unaffected; it tries
            again on the next refresh.
          </p>
        </div>
      ) : (
        <AiWindowView window={ai[windowKey]} rate={ai.usdToBdtRate} />
      )}
    </Panel>
  )
}

function AiWindowView({ window: w, rate }: { window: AiUsageWindow; rate: number }) {
  const t = w.totals
  const failures = sortedFailures(t.failuresByKind)
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground" data-testid="ai-window-range">
        {formatRangeLabel(w.from, w.to)} · Dhaka time
      </p>
      {t.calls === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-muted px-6 py-10 text-center">
          <h3 className="text-sm font-semibold">No AI calls yet</h3>
          <p className="max-w-md text-sm text-balance text-muted-foreground">
            Classification calls, tokens and cost show here once moderation runs on connected pages.
          </p>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Fact label="Calls">
              <span data-testid="ai-calls">{count(t.calls)}</span>
            </Fact>
            <Fact label="Failed calls">
              <span data-testid="ai-failed" className={t.failedCalls > 0 ? 'text-destructive' : undefined}>
                {count(t.failedCalls)}
              </span>
            </Fact>
            <Fact label="Tokens in / out">
              <span data-testid="ai-tokens" title={`${count(t.inputTokens)} / ${count(t.outputTokens)}`}>
                {formatTokens(t.inputTokens)} / {formatTokens(t.outputTokens)}
              </span>
            </Fact>
            <Fact label="Estimated cost">
              <span data-testid="ai-cost">
                {formatUsd(t.estimatedCostUsd)}
                {t.estimatedCostBdt !== null && (
                  <span className="text-muted-foreground"> · {formatBdtAmount(t.estimatedCostBdt)}</span>
                )}
              </span>
            </Fact>
            <Fact label="Latency avg / max">
              <span data-testid="ai-latency">
                {formatCallLatency(t.avgLatencyMs)} / {formatCallLatency(t.maxLatencyMs)}
              </span>
            </Fact>
          </dl>

          {t.unpricedModels > 0 && (
            <p
              role="note"
              data-testid="ai-unpriced"
              className="rounded-xl bg-chart-4/15 px-4 py-2.5 text-xs text-foreground"
            >
              The cost total leaves out {t.unpricedModels} {t.unpricedModels === 1 ? 'model' : 'models'} without a
              list price (shown as n/a below).
            </p>
          )}

          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Failures by kind</h3>
            {failures.length === 0 ? (
              <p className="text-sm text-muted-foreground">No failed calls.</p>
            ) : (
              <ul className="flex flex-wrap gap-2" aria-label="Failures by kind">
                {failures.map(([kind, n]) => (
                  <li key={kind} data-testid="ai-failure">
                    <Pill tone="bad">
                      {formatFailureKind(kind)} · {count(n)}
                    </Pill>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="-mx-4 overflow-x-auto md:-mx-5">
            <table className="w-full text-sm" aria-label="AI usage per provider and model">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-4 py-2 font-medium md:px-5">
                    Provider · model
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Calls
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Failed
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium whitespace-nowrap">
                    Tokens in / out
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium whitespace-nowrap">
                    Avg / max
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Cost
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium whitespace-nowrap md:px-5">
                    Price / 1M in · out
                  </th>
                </tr>
              </thead>
              <tbody>
                {w.models.map((m) => (
                  <tr key={`${m.provider}:${m.model}`} data-testid="ai-model-row" className="border-b last:border-b-0">
                    <th scope="row" className="px-4 py-2.5 text-left font-normal md:px-5">
                      <span className="block text-xs text-muted-foreground">
                        {aiProviderLabels[m.provider] ?? m.provider}
                      </span>
                      <span className="block font-mono text-xs font-medium">{m.model}</span>
                    </th>
                    <td className="px-2 py-2.5 text-right tabular-nums">{count(m.calls)}</td>
                    <td
                      className={`px-2 py-2.5 text-right tabular-nums ${m.failedCalls > 0 ? 'font-semibold text-destructive' : ''}`}
                    >
                      {count(m.failedCalls)}
                    </td>
                    <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">
                      {formatTokens(m.inputTokens)} / {formatTokens(m.outputTokens)}
                    </td>
                    <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">
                      {formatCallLatency(m.avgLatencyMs)} / {formatCallLatency(m.maxLatencyMs)}
                    </td>
                    <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">
                      {formatUsd(m.estimatedCostUsd)}
                      {m.estimatedCostBdt !== null && (
                        <span className="block text-xs text-muted-foreground">{formatBdtAmount(m.estimatedCostBdt)}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap text-muted-foreground tabular-nums md:px-5">
                      {formatModelPrice(m.priceUsdPer1M)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            Costs are estimates at list prices per 1M tokens; taka at ৳{rate.toLocaleString('en-US')} per US$.
          </p>
        </>
      )}
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl bg-card px-6 py-16 text-center"
    >
      <h2 className="text-base font-semibold">Couldn't load system health</h2>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        <RotateCcw data-icon="inline-start" />
        Try again
      </Button>
    </div>
  )
}

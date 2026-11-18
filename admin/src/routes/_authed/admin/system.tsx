import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import { Cpu, Database, GitBranch, Layers, RefreshCw, RotateCcw, Server } from 'lucide-react'
import type { ReactNode } from 'react'
import { PageHeader } from '@/components/placeholder-page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  type DependencyProbe,
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
 * queue counts and the latest Drizzle migration. Polls every 30 s only while the tab is visible:
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
          description="Live health of the database, Redis, the API process, queues and migrations."
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
              className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
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
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-4 md:p-5">
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
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-muted px-6 py-10 text-center">
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

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-2xl border bg-card px-6 py-16 text-center"
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

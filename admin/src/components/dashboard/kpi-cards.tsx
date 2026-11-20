import { CountingNumber } from '@animate-ui/react/primitives/texts/counting-number'
import type { LucideIcon } from 'lucide-react'
import { Banknote, Building2, LifeBuoy, ScanSearch } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { type DashboardKpis, formatCount } from '@/lib/admin-dashboard'

interface KpiSpec {
  key: keyof DashboardKpis
  label: string
  icon: LucideIcon
  currency?: boolean
  /** Caption under the number; zero = an honest "nothing yet" line. */
  caption: (value: number, newClients: number) => string
}

const KPIS: KpiSpec[] = [
  {
    key: 'activeClients',
    label: 'Active clients',
    icon: Building2,
    caption: (_, added) => (added > 0 ? `+${formatCount(added)} new in this range` : 'No new clients in this range'),
  },
  {
    key: 'mrrBdt',
    label: 'Monthly recurring revenue',
    icon: Banknote,
    currency: true,
    caption: (v) => (v > 0 ? 'Current MRR in taka' : 'No paid plans yet'),
  },
  {
    key: 'commentsScanned',
    label: 'Comments scanned',
    icon: ScanSearch,
    caption: (v) => (v > 0 ? 'In this range' : 'None scanned in this range'),
  },
  {
    key: 'openTickets',
    label: 'Open tickets',
    icon: LifeBuoy,
    caption: (v) => (v > 0 ? 'Waiting on support' : 'Support inbox is clear'),
  },
]

/** The four KPI cards. `kpis` undefined = loading skeletons in the same slots. */
export function KpiCards({ kpis, newClients }: { kpis: DashboardKpis | undefined; newClients: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {KPIS.map(({ key, label, icon: Icon, currency, caption }) => (
        <section
          key={key}
          aria-label={label}
          className="flex min-w-0 flex-col gap-3 rounded-3xl bg-card p-5"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="truncate text-sm text-muted-foreground">{label}</h2>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Icon className="size-4" aria-hidden />
            </span>
          </div>
          {kpis ? (
            <>
              <p className="truncate text-3xl font-semibold tracking-tight tabular-nums">
                {currency && <span className="mr-0.5">৳</span>}
                <CountingNumber number={kpis[key]} thousandSeparator="," data-testid={`kpi-${key}`} />
              </p>
              <p className="truncate text-xs text-muted-foreground">{caption(kpis[key], newClients)}</p>
            </>
          ) : (
            <div aria-hidden className="flex flex-col gap-2.5 py-1">
              <Skeleton className="h-8 w-28 rounded-full" />
              <Skeleton className="h-3 w-36 rounded-full" />
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

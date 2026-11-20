import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus, RotateCcw, SearchX, TicketPercent } from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '@/components/placeholder-page'
import { RedemptionsSheet, StopPromotionDialog } from '@/components/promotions/promotion-actions'
import { PromotionFormDialog, type PromotionFormTarget } from '@/components/promotions/promotion-form-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  type AdminPromotion,
  endsLabel,
  kindLabels,
  plansLabel,
  PROMOTION_KINDS,
  PROMOTION_STATUSES,
  type PromotionKind,
  type PromotionStatus,
  promotionsQueryOptions,
  promotionValue,
  statusLabels,
  usedLabel,
  validatePromotionsSearch,
} from '@/lib/admin-promotions'

export const Route = createFileRoute('/_authed/admin/promotions')({
  validateSearch: validatePromotionsSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    void context.queryClient.prefetchQuery(promotionsQueryOptions(deps))
  },
  component: PromotionsPage,
})

const ALL = 'ALL'

function PromotionsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const query = useQuery(promotionsQueryOptions(search))
  const [form, setForm] = useState<PromotionFormTarget>(null)
  const [stopping, setStopping] = useState<AdminPromotion | null>(null)
  const [claims, setClaims] = useState<AdminPromotion | null>(null)
  const filtered = Boolean(search.kind || search.status)
  const data = query.data

  const setFilter = (patch: Partial<typeof search>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Promotions"
          description="Trials, discounts and coupons. Stopping one or its end date blocks new claims only."
        />
        <Button onClick={() => setForm({ promotion: null })}>
          <Plus data-icon="inline-start" />
          New promotion
        </Button>
      </div>

      <section aria-label="Promotions" className="flex min-w-0 flex-col overflow-hidden rounded-xl bg-card">
        <div className="flex flex-wrap items-center gap-2 p-4 md:p-5">
          <Tabs
            value={search.kind ?? ALL}
            onValueChange={(v) => setFilter({ kind: v === ALL ? undefined : (v as PromotionKind) })}
          >
            <TabsList aria-label="Kind" className="rounded-full">
              <TabsTrigger value={ALL} className="rounded-full px-3">
                All kinds
              </TabsTrigger>
              {PROMOTION_KINDS.map((k) => (
                <TabsTrigger key={k} value={k} className="rounded-full px-3">
                  {kindLabels[k]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Tabs
            value={search.status ?? ALL}
            onValueChange={(v) => setFilter({ status: v === ALL ? undefined : (v as PromotionStatus) })}
          >
            <TabsList aria-label="Status" className="rounded-full">
              <TabsTrigger value={ALL} className="rounded-full px-3">
                Any status
              </TabsTrigger>
              {PROMOTION_STATUSES.map((s) => (
                <TabsTrigger key={s} value={s} className="rounded-full px-3">
                  {statusLabels[s]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {query.isError && !data ? (
          <div role="alert" className="flex flex-col items-center gap-3 border-t px-6 py-16 text-center">
            <h2 className="text-base font-semibold">Couldn't load promotions</h2>
            <p className="max-w-md text-sm text-muted-foreground">{query.error.message}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              <RotateCcw data-icon="inline-start" />
              Try again
            </Button>
          </div>
        ) : data && data.items.length === 0 ? (
          <EmptyState filtered={filtered} onClear={() => setFilter({ kind: undefined, status: undefined })} />
        ) : (
          <div className="min-w-0 border-t">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Kind</TableHead>
                  <TableHead>Promotion</TableHead>
                  <TableHead>Plans</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Ends</TableHead>
                  <TableHead>Used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data
                  ? data.items.map((p) => (
                      <PromotionRow
                        key={p.id}
                        promotion={p}
                        onEdit={() => setForm({ promotion: p })}
                        onClaims={() => setClaims(p)}
                        onStop={() => setStopping(p)}
                      />
                    ))
                  : Array.from({ length: 4 }, (_, i) => (
                      <TableRow key={i} className="hover:bg-transparent" aria-hidden>
                        {Array.from({ length: 8 }, (_, j) => (
                          <TableCell key={j} className={j === 0 ? 'pl-4' : undefined}>
                            <Skeleton className="h-4 w-20 rounded-full" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <PromotionFormDialog target={form} onClose={() => setForm(null)} />
      <StopPromotionDialog promotion={stopping} onClose={() => setStopping(null)} />
      <RedemptionsSheet promotion={claims} onClose={() => setClaims(null)} />
    </div>
  )
}

const statusClass: Record<PromotionStatus, string> = {
  LIVE: 'bg-primary/10 text-primary',
  ENDED: 'bg-muted text-muted-foreground',
  STOPPED: 'bg-destructive/10 text-destructive',
  USED_UP: 'bg-chart-4/15 text-foreground',
}

function PromotionRow({
  promotion: p,
  onEdit,
  onClaims,
  onStop,
}: {
  promotion: AdminPromotion
  onEdit: () => void
  onClaims: () => void
  onStop: () => void
}) {
  const value = promotionValue(p)
  return (
    <TableRow className="hover:bg-muted">
      <TableCell className="pl-4">
        <span className="inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium">{kindLabels[p.kind]}</span>
      </TableCell>
      <TableCell>
        <div className="flex max-w-48 flex-col">
          <span className="truncate font-medium" title={p.name}>
            {p.name}
          </span>
          {p.code && <span className="font-mono text-xs text-muted-foreground">{p.code}</span>}
        </div>
      </TableCell>
      <TableCell className="max-w-40 truncate" title={plansLabel(p)}>
        {plansLabel(p)}
      </TableCell>
      <TableCell>
        <div className="flex flex-col whitespace-nowrap">
          <span className="font-medium tabular-nums">{value.main}</span>
          <span className="text-xs text-muted-foreground">{value.detail}</span>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">{endsLabel(p)}</TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">{usedLabel(p)}</TableCell>
      <TableCell>
        <span
          data-testid="promotion-status"
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${statusClass[p.status]}`}
        >
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {statusLabels[p.status]}
        </span>
      </TableCell>
      <TableCell className="pr-4">
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClaims} aria-label={`Claims: ${p.name}`}>
            Claims
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit} aria-label={`Edit ${p.name}`}>
            Edit
          </Button>
          {!p.stoppedAt && (
            <Button variant="outline" size="sm" onClick={onStop} aria-label={`Stop ${p.name}`}>
              Stop
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function EmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  const Icon = filtered ? SearchX : TicketPercent
  return (
    <div className="flex flex-col items-center gap-3 border-t px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-6" aria-hidden />
      </span>
      <h2 className="text-base font-semibold">{filtered ? 'No promotions match these filters' : 'No promotions yet'}</h2>
      <p className="max-w-md text-sm text-balance text-muted-foreground">
        {filtered ? 'Try another kind or status.' : 'Create a trial, a discount or a coupon to get started.'}
      </p>
      {filtered && (
        <Button variant="outline" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  )
}

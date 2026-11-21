import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CreditCard,
  ListFilter,
  RotateCcw,
  SearchX,
  ShieldAlert,
  Wallet,
} from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { TransactionSheet } from '@/components/billing/transaction-sheet'
import { PageHeader } from '@/components/placeholder-page'
import { SearchInput } from '@/components/search-input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  type AdminPaymentEventItem,
  type AdminTransaction,
  type BillingSearch,
  EVENTS_PAGE_SIZE,
  eventSourceLabels,
  failedEventsQueryOptions,
  formatDhakaTime,
  GATEWAY_LABELS,
  outcomeLabel,
  TRANSACTION_STATUSES,
  type TransactionStatus,
  TRANSACTIONS_PAGE_SIZE,
  transactionStatusLabels,
  transactionsQueryOptions,
  validateBillingSearch,
} from '@/lib/admin-billing'
import { formatDhakaDate } from '@/lib/admin-clients'
import { formatBdt } from '@/lib/admin-dashboard'

export const Route = createFileRoute('/_authed/admin/billing')({
  validateSearch: validateBillingSearch,
  loaderDeps: ({ search }) => search,
  // Warm the cache without blocking the screen; the tables show skeleton rows meanwhile.
  loader: ({ context, deps }) => {
    if (deps.tab === 'failed') void context.queryClient.prefetchQuery(failedEventsQueryOptions(deps.page))
    else void context.queryClient.prefetchQuery(transactionsQueryOptions(deps))
  },
  component: BillingPage,
})

const ALL = 'ALL'

/** Clears every transaction filter. */
const noFilters: Partial<BillingSearch> = {
  status: undefined,
  gateway: undefined,
  q: undefined,
  from: undefined,
  to: undefined,
}

/** A4 (M2-T9; M8-T9 filters, transaction sheet, D9 refunds, D10 risk flag, failed IPNs). */
function BillingPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [openId, setOpenId] = useState<string | null>(null)
  const failedTab = search.tab === 'failed'

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Billing"
        description="Subscription payments collected through SSLCommerz (bKash, Nagad, cards) in BDT ৳."
      />

      <Tabs
        value={failedTab ? 'failed' : 'transactions'}
        onValueChange={(value) =>
          navigate({ search: (prev) => ({ ...prev, tab: value === 'failed' ? 'failed' : undefined, page: undefined }) })
        }
      >
        <TabsList aria-label="Billing view" className="rounded-full">
          <TabsTrigger value="transactions" className="rounded-full px-3">
            Transactions
          </TabsTrigger>
          <TabsTrigger value="failed" className="rounded-full px-3">
            Failed IPNs
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {failedTab ? <FailedEvents search={search} onOpen={setOpenId} /> : <Transactions search={search} onOpen={setOpenId} />}

      <TransactionSheet id={openId} onClose={() => setOpenId(null)} />
    </div>
  )
}

function Transactions({ search, onOpen }: { search: BillingSearch; onOpen: (id: string) => void }) {
  const navigate = Route.useNavigate()
  const query = useQuery(transactionsQueryOptions(search))
  const page = search.page ?? 1
  const data = query.data
  const pageCount = data ? Math.max(1, Math.ceil(data.total / TRANSACTIONS_PAGE_SIZE)) : 1
  const hasFilters = Boolean(search.status || search.gateway || search.q || search.from || search.to)

  /** Any filter change goes back to page 1; `replace` keeps typing out of the history stack. */
  const setFilters = (patch: Partial<BillingSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: undefined }), replace: true })

  return (
    <section
      aria-labelledby="transactions-title"
      className="flex min-w-0 flex-col overflow-hidden rounded-3xl bg-card"
    >
      <div className="flex flex-col gap-1 px-4 pt-4 sm:flex-row sm:items-baseline sm:justify-between md:px-5 md:pt-5">
        <h2 id="transactions-title" className="text-base font-semibold">
          Transactions
        </h2>
        <p className="text-xs text-muted-foreground">Newest first · dates in Bangladesh time · click a row for details</p>
      </div>
      <Toolbar search={search} setFilters={setFilters} hasFilters={hasFilters} />

      {query.isError && !data ? (
        <ErrorState title="Couldn't load transactions" message={query.error.message} onRetry={() => void query.refetch()} />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          icon={hasFilters ? SearchX : CreditCard}
          title={hasFilters ? 'No payments match these filters' : page > 1 ? 'No payments on this page' : 'No payments yet'}
          text={
            hasFilters
              ? 'Try a shorter search, another status or gateway, or a wider date range.'
              : page > 1
                ? 'This page is past the last payment.'
                : 'Each SSLCommerz payment shows here with its client, plan, amount in ৳, gateway, status and invoice.'
          }
          action={
            hasFilters ? (
              <Button variant="outline" onClick={() => setFilters(noFilters)}>
                Clear filters
              </Button>
            ) : page > 1 ? (
              <Button variant="outline" onClick={() => setFilters({})}>
                Go to first page
              </Button>
            ) : null
          }
        />
      ) : (
        <div
          className="min-w-0 border-t transition-opacity aria-busy:opacity-60"
          aria-busy={query.isFetching && query.isPlaceholderData ? true : undefined}
        >
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Date</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Gateway</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead className="pr-5">Transaction ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data
                ? data.items.map((tx) => <TransactionRow key={tx.id} tx={tx} onOpen={() => onOpen(tx.id)} />)
                : Array.from({ length: 5 }, (_, i) => <SkeletonRow key={i} cells={8} />)}
            </TableBody>
          </Table>
        </div>
      )}

      {data && data.total > 0 && (
        <Pagination
          page={page}
          pageCount={pageCount}
          total={data.total}
          shown={data.items.length}
          skip={data.skip}
          noun={['payment', 'payments']}
          onPage={(next) => navigate({ search: (prev) => ({ ...prev, page: next > 1 ? next : undefined }) })}
        />
      )}
    </section>
  )
}

function Toolbar({
  search,
  setFilters,
  hasFilters,
}: {
  search: BillingSearch
  setFilters: (patch: Partial<BillingSearch>) => void
  hasFilters: boolean
}) {
  const fromId = useId()
  const toId = useId()
  const statusLabel = search.status ? transactionStatusLabels[search.status] : 'All statuses'
  const gateways: readonly string[] =
    search.gateway && !GATEWAY_LABELS.some((g) => g === search.gateway) ? [...GATEWAY_LABELS, search.gateway] : GATEWAY_LABELS

  return (
    <div className="flex flex-col gap-3 p-4 md:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <SearchInput
          value={search.q ?? ''}
          onSearch={(q) => setFilters({ q: q || undefined })}
          label="Search transactions"
          placeholder="Search client, payer name or email, transaction ID"
        />
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" aria-label={`Status: ${statusLabel}`}>
                <ListFilter data-icon="inline-start" />
                {statusLabel}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Filter by status</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={search.status ?? ALL}
                onValueChange={(value) =>
                  setFilters({ status: value === ALL ? undefined : (value as TransactionStatus) })
                }
              >
                <DropdownMenuRadioItem value={ALL}>All statuses</DropdownMenuRadioItem>
                {TRANSACTION_STATUSES.map((status) => (
                  <DropdownMenuRadioItem key={status} value={status}>
                    {transactionStatusLabels[status]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" aria-label={`Gateway: ${search.gateway ?? 'All gateways'}`}>
                <Wallet data-icon="inline-start" />
                {search.gateway ?? 'All gateways'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Filter by gateway</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={search.gateway ?? ALL}
                onValueChange={(value) => setFilters({ gateway: value === ALL ? undefined : value })}
              >
                <DropdownMenuRadioItem value={ALL}>All gateways</DropdownMenuRadioItem>
                {gateways.map((gateway) => (
                  <DropdownMenuRadioItem key={gateway} value={gateway}>
                    {gateway}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={fromId} className="text-xs text-muted-foreground">
            Created from
          </Label>
          <Input
            id={fromId}
            type="date"
            className="w-40"
            value={search.from ?? ''}
            max={search.to}
            onChange={(e) => setFilters({ from: e.target.value || undefined })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={toId} className="text-xs text-muted-foreground">
            Created to
          </Label>
          <Input
            id={toId}
            type="date"
            className="w-40"
            value={search.to ?? ''}
            min={search.from}
            onChange={(e) => setFilters({ to: e.target.value || undefined })}
          />
        </div>
        <p className="pb-2 text-xs text-muted-foreground">Dates are Bangladesh time.</p>
        {hasFilters && (
          <Button variant="ghost" className="ml-auto" onClick={() => setFilters(noFilters)}>
            <RotateCcw data-icon="inline-start" />
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}

function TransactionRow({ tx, onOpen }: { tx: AdminTransaction; onOpen: () => void }) {
  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell className="pl-4 whitespace-nowrap">
        <DateTime iso={tx.createdAt} />
      </TableCell>
      <TableCell>
        <button
          type="button"
          className="block max-w-44 truncate text-left font-medium hover:underline"
          title={tx.workspace.name}
          aria-label={`Open transaction ${tx.tranId}`}
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
        >
          {tx.workspace.name}
        </button>
      </TableCell>
      <TableCell>
        <Badge variant="outline">{tx.plan.name}</Badge>
      </TableCell>
      <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">{formatBdt(tx.amountBdt)}</TableCell>
      <TableCell className="whitespace-nowrap">{tx.gateway}</TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <StatusPill status={tx.status} />
          {tx.riskFlagged && (
            <Badge variant="destructive" title="SSLCommerz risk level 1: activated anyway (D10)">
              <ShieldAlert data-icon="inline-start" />
              High risk
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">{tx.invoiceNumber ?? '—'}</TableCell>
      <TableCell className="pr-5">
        <code className="block max-w-48 truncate font-mono text-xs text-muted-foreground" title={tx.tranId}>
          {tx.tranId}
        </code>
      </TableCell>
    </TableRow>
  )
}

function FailedEvents({ search, onOpen }: { search: BillingSearch; onOpen: (id: string) => void }) {
  const navigate = Route.useNavigate()
  const query = useQuery(failedEventsQueryOptions(search.page))
  const page = search.page ?? 1
  const data = query.data
  const pageCount = data ? Math.max(1, Math.ceil(data.total / EVENTS_PAGE_SIZE)) : 1

  return (
    <section aria-labelledby="events-title" className="flex min-w-0 flex-col overflow-hidden rounded-3xl bg-card">
      <div className="flex flex-col gap-1 p-4 sm:flex-row sm:items-baseline sm:justify-between md:p-5">
        <h2 id="events-title" className="text-base font-semibold">
          Failed IPNs
        </h2>
        <p className="text-xs text-muted-foreground">
          SSLCommerz callbacks that did not settle cleanly · newest first · Bangladesh time
        </p>
      </div>

      {query.isError && !data ? (
        <ErrorState title="Couldn't load failed IPNs" message={query.error.message} onRetry={() => void query.refetch()} />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          icon={CircleCheck}
          title={page > 1 ? 'No failed IPNs on this page' : 'No failed IPNs'}
          text={page > 1 ? 'This page is past the last event.' : 'Every SSLCommerz callback so far settled cleanly.'}
          action={
            page > 1 ? (
              <Button variant="outline" onClick={() => navigate({ search: (prev) => ({ ...prev, page: undefined }) })}>
                Go to first page
              </Button>
            ) : null
          }
        />
      ) : (
        <div
          className="min-w-0 border-t transition-opacity aria-busy:opacity-60"
          aria-busy={query.isFetching && query.isPlaceholderData ? true : undefined}
        >
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Received</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Transaction ID</TableHead>
                <TableHead className="pr-5">Client</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data
                ? data.items.map((event) => <EventRow key={event.id} event={event} onOpen={onOpen} />)
                : Array.from({ length: 5 }, (_, i) => <SkeletonRow key={i} cells={5} />)}
            </TableBody>
          </Table>
        </div>
      )}

      {data && data.total > 0 && (
        <Pagination
          page={page}
          pageCount={pageCount}
          total={data.total}
          shown={data.items.length}
          skip={data.skip}
          noun={['event', 'events']}
          onPage={(next) => navigate({ search: (prev) => ({ ...prev, page: next > 1 ? next : undefined }) })}
        />
      )}
    </section>
  )
}

function EventRow({ event, onOpen }: { event: AdminPaymentEventItem; onOpen: (id: string) => void }) {
  const { transaction } = event
  return (
    <TableRow>
      <TableCell className="pl-4 whitespace-nowrap">
        <DateTime iso={event.receivedAt} />
      </TableCell>
      <TableCell>
        <span className="flex flex-col">
          <span className="font-medium">{outcomeLabel(event.outcome)}</span>
          <code className="font-mono text-xs text-muted-foreground">{event.outcome}</code>
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap">{eventSourceLabels[event.source]}</TableCell>
      <TableCell>
        {event.tranId ? (
          <code className="block max-w-48 truncate font-mono text-xs text-muted-foreground" title={event.tranId}>
            {event.tranId}
          </code>
        ) : (
          <span className="text-muted-foreground">No transaction ID</span>
        )}
      </TableCell>
      <TableCell className="pr-5">
        {transaction ? (
          <Button
            variant="link"
            className="h-auto px-0"
            aria-label={`Open transaction ${event.tranId ?? transaction.id}`}
            onClick={() => onOpen(transaction.id)}
          >
            {transaction.workspace.name}
          </Button>
        ) : (
          <span className="text-muted-foreground">Unknown transaction</span>
        )}
      </TableCell>
    </TableRow>
  )
}

function DateTime({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} className="flex flex-col">
      <span>{formatDhakaDate(iso)}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{formatDhakaTime(iso)}</span>
    </time>
  )
}

const statusStyles: Record<TransactionStatus, string> = {
  PAID: 'bg-primary/10 text-primary',
  PENDING: 'bg-chart-4/15 text-foreground',
  FAILED: 'bg-destructive/10 text-destructive',
  CANCELLED: 'bg-muted text-muted-foreground',
  REFUNDED: 'bg-accent/25 text-accent-foreground',
}

function StatusPill({ status }: { status: TransactionStatus }) {
  return (
    <span
      data-testid="transaction-status"
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${statusStyles[status]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {transactionStatusLabels[status]}
    </span>
  )
}

function SkeletonRow({ cells }: { cells: number }) {
  return (
    <TableRow className="hover:bg-transparent" aria-hidden>
      {Array.from({ length: cells }, (_, i) => (
        <TableCell key={i} className={i === 0 ? 'pl-4' : i === cells - 1 ? 'pr-5' : undefined}>
          <Skeleton className="h-4 w-20 rounded-full" />
        </TableCell>
      ))}
    </TableRow>
  )
}

function EmptyState({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon: typeof CreditCard
  title: string
  text: string
  action: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 border-t px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-6" aria-hidden />
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-balance text-muted-foreground">{text}</p>
      {action}
    </div>
  )
}

function ErrorState({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 border-t px-6 py-16 text-center">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        <RotateCcw data-icon="inline-start" />
        Try again
      </Button>
    </div>
  )
}

function Pagination({
  page,
  pageCount,
  total,
  shown,
  skip,
  noun,
  onPage,
}: {
  page: number
  pageCount: number
  total: number
  shown: number
  skip: number
  noun: [string, string]
  onPage: (page: number) => void
}) {
  const first = shown > 0 ? skip + 1 : 0
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 md:px-5">
      <p className="text-sm text-muted-foreground">
        {first}–{skip + shown} of {total} {total === 1 ? noun[0] : noun[1]}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft />
        </Button>
        <span className="text-sm tabular-nums">
          {page} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </nav>
  )
}

import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, CreditCard, RotateCcw } from 'lucide-react'
import { PageHeader } from '@/components/placeholder-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  type AdminTransaction,
  formatDhakaTime,
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
  // Warm the cache without blocking the screen; the table shows skeleton rows meanwhile.
  loader: ({ context, deps }) => {
    void context.queryClient.prefetchQuery(transactionsQueryOptions(deps))
  },
  component: BillingPage,
})

/**
 * A4. Final columns from day one (user decision 2026-11-18): the list is empty until Module 8
 * stores SSLCommerz payments, so the header row stays visible above the "No payments yet" state.
 */
function BillingPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const query = useQuery(transactionsQueryOptions(search))
  const page = search.page ?? 1
  const data = query.data
  const pageCount = data ? Math.max(1, Math.ceil(data.total / TRANSACTIONS_PAGE_SIZE)) : 1
  const empty = data !== undefined && data.items.length === 0

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Billing"
        description="Subscription payments collected through SSLCommerz (bKash, Nagad, cards) in BDT ৳."
      />

      <section
        aria-labelledby="transactions-title"
        className="flex min-w-0 flex-col overflow-hidden rounded-3xl bg-card"
      >
        <div className="flex flex-col gap-1 p-4 sm:flex-row sm:items-baseline sm:justify-between md:p-5">
          <h2 id="transactions-title" className="text-base font-semibold">
            Transactions
          </h2>
          <p className="text-xs text-muted-foreground">Newest first · dates in Bangladesh time</p>
        </div>

        {query.isError && !data ? (
          <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : (
          <>
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
                    <TableHead className="pr-5">Transaction ID</TableHead>
                  </TableRow>
                </TableHeader>
                {!empty && (
                  <TableBody>
                    {data
                      ? data.items.map((tx) => <TransactionRow key={tx.id} tx={tx} />)
                      : Array.from({ length: 5 }, (_, i) => <SkeletonRow key={i} />)}
                  </TableBody>
                )}
              </Table>
            </div>
            {empty && <EmptyState filtered={page > 1} onFirstPage={() => navigate({ search: {} })} />}
          </>
        )}

        {data && data.total > 0 && (
          <Pagination
            page={page}
            pageCount={pageCount}
            total={data.total}
            shown={data.items.length}
            skip={data.skip}
            onPage={(next) => navigate({ search: { page: next > 1 ? next : undefined } })}
          />
        )}
      </section>
    </div>
  )
}

function TransactionRow({ tx }: { tx: AdminTransaction }) {
  return (
    <TableRow>
      <TableCell className="pl-4 whitespace-nowrap">
        <time dateTime={tx.createdAt} className="flex flex-col">
          <span>{formatDhakaDate(tx.createdAt)}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatDhakaTime(tx.createdAt)}
          </span>
        </time>
      </TableCell>
      <TableCell>
        <span className="block max-w-44 truncate font-medium" title={tx.workspace.name}>
          {tx.workspace.name}
        </span>
      </TableCell>
      <TableCell>
        <Badge variant="outline">{tx.plan.name}</Badge>
      </TableCell>
      <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
        {formatBdt(tx.amountBdt)}
      </TableCell>
      <TableCell className="whitespace-nowrap">{tx.gateway}</TableCell>
      <TableCell>
        <StatusPill status={tx.status} />
      </TableCell>
      <TableCell className="pr-5">
        <code
          className="block max-w-48 truncate font-mono text-xs text-muted-foreground"
          title={tx.tranId}
        >
          {tx.tranId}
        </code>
      </TableCell>
    </TableRow>
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

function SkeletonRow() {
  return (
    <TableRow className="hover:bg-transparent" aria-hidden>
      <TableCell className="pl-4">
        <Skeleton className="mb-1.5 h-4 w-24 rounded-full" />
        <Skeleton className="h-3 w-12 rounded-full" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-4 w-32 rounded-full" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-5 w-16 rounded-full" />
      </TableCell>
      <TableCell>
        <Skeleton className="ml-auto h-4 w-16 rounded-full" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-4 w-14 rounded-full" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-5 w-16 rounded-full" />
      </TableCell>
      <TableCell className="pr-5">
        <Skeleton className="h-4 w-36 rounded-full" />
      </TableCell>
    </TableRow>
  )
}

function EmptyState({ filtered, onFirstPage }: { filtered: boolean; onFirstPage: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 border-t px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <CreditCard className="size-6" aria-hidden />
      </span>
      <h3 className="text-base font-semibold">
        {filtered ? 'No payments on this page' : 'No payments yet'}
      </h3>
      <p className="max-w-md text-sm text-balance text-muted-foreground">
        {filtered
          ? 'This page is past the last payment.'
          : 'Payments arrive with the SSLCommerz integration. Each one shows here with its client, plan, amount in ৳, gateway, status and transaction ID.'}
      </p>
      {filtered && (
        <Button variant="outline" onClick={onFirstPage}>
          Go to first page
        </Button>
      )}
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 border-t px-6 py-16 text-center">
      <h3 className="text-base font-semibold">Couldn't load transactions</h3>
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
  onPage,
}: {
  page: number
  pageCount: number
  total: number
  shown: number
  skip: number
  onPage: (page: number) => void
}) {
  const first = shown > 0 ? skip + 1 : 0
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 md:px-5"
    >
      <p className="text-sm text-muted-foreground">
        {first}–{skip + shown} of {total} {total === 1 ? 'payment' : 'payments'}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
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

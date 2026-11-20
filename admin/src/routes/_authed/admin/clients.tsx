import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowDownUp,
  Building2,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Layers,
  LogIn,
  RotateCcw,
  SearchX,
} from 'lucide-react'
import { useId, useState } from 'react'
import { ActivatePlanDialog } from '@/components/clients/activate-plan-dialog'
import { ClientStatusDialog, type StatusChange } from '@/components/clients/client-status-dialog'
import { useLoginAsClient } from '@/components/clients/use-login-as-client'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
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
  type AdminClient,
  type ClientComments,
  type ClientSort,
  type ClientStatus,
  CLIENTS_PAGE_SIZE,
  type ClientsSearch,
  clientsQueryOptions,
  commentUsage,
  formatDhakaDate,
  NO_PLAN,
  type SubscriptionTone,
  subscriptionBadge,
  subscriptionIntervalLabels,
  validateClientsSearch,
} from '@/lib/admin-clients'
import { plansQueryOptions } from '@/lib/admin-plans'

export const Route = createFileRoute('/_authed/admin/clients')({
  validateSearch: validateClientsSearch,
  loaderDeps: ({ search }) => search,
  // Warm the cache (hover preload, first load) without blocking the screen; the page shows skeletons.
  loader: ({ context, deps }) => {
    void context.queryClient.prefetchQuery(clientsQueryOptions(deps))
  },
  component: ClientsPage,
})

/**
 * The actions column stays pinned to the right edge while the table scrolls inside its card, so
 * Login as Client is always in view (from `sm` up; on phones the whole row scrolls).
 */
const stickyActions = 'bg-card sm:sticky sm:right-0 sm:border-l'

/** Clears every filter (sort is kept). */
const noFilters: Partial<ClientsSearch> = {
  q: undefined,
  status: undefined,
  plan: undefined,
  from: undefined,
  to: undefined,
}

const ANY_PLAN = 'any'

const sortLabels: Record<ClientSort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  name: 'Name (A–Z)',
}

function ClientsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const query = useQuery(clientsQueryOptions(search))
  const loginAs = useLoginAsClient()
  const [statusChange, setStatusChange] = useState<StatusChange | null>(null)
  const [activating, setActivating] = useState<AdminClient | null>(null)

  /** Any filter change goes back to page 1; `replace` keeps typing out of the history stack. */
  const setFilters = (patch: Partial<ClientsSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: undefined }), replace: true })

  const hasFilters = Boolean(search.q || search.status || search.plan || search.from || search.to)
  const page = search.page ?? 1
  const data = query.data
  const pageCount = data ? Math.max(1, Math.ceil(data.total / CLIENTS_PAGE_SIZE)) : 1

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Clients"
        description="Every F-commerce workspace on ShieldComment, with plan, subscription status, monthly comments and status."
      />

      <section
        aria-label="Clients"
        className="flex min-w-0 flex-col overflow-hidden rounded-xl bg-card"
      >
        <Toolbar search={search} setFilters={setFilters} hasFilters={hasFilters} />

        {query.isError && !data ? (
          <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            filtered={hasFilters || page > 1}
            onClear={() => setFilters(noFilters)}
          />
        ) : (
          <div
            className="min-w-0 border-t transition-opacity aria-busy:opacity-60"
            aria-busy={query.isFetching && query.isPlaceholderData ? true : undefined}
          >
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Client</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Comments</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className={`${stickyActions} pr-4 text-right`}>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data
                  ? data.items.map((client) => (
                      <ClientRow
                        key={client.id}
                        client={client}
                        loggingIn={loginAs.pendingId === client.id}
                        onLoginAs={() => loginAs.start(client)}
                        onChangeStatus={(status) => setStatusChange({ client, status })}
                        onActivatePlan={() => setActivating(client)}
                      />
                    ))
                  : Array.from({ length: 6 }, (_, i) => <SkeletonRow key={i} />)}
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
            onPage={(next) =>
              navigate({ search: (prev) => ({ ...prev, page: next > 1 ? next : undefined }) })
            }
          />
        )}
      </section>

      <ClientStatusDialog change={statusChange} onClose={() => setStatusChange(null)} />
      <ActivatePlanDialog client={activating} onClose={() => setActivating(null)} />
    </div>
  )
}

function Toolbar({
  search,
  setFilters,
  hasFilters,
}: {
  search: ClientsSearch
  setFilters: (patch: Partial<ClientsSearch>) => void
  hasFilters: boolean
}) {
  const fromId = useId()
  const toId = useId()
  const sort = search.sort ?? 'newest'
  const plans = useQuery({ ...plansQueryOptions(), select: (data) => data.items })
  const planValue = search.plan ?? ANY_PLAN
  const planLabel =
    planValue === ANY_PLAN
      ? 'All plans'
      : planValue === NO_PLAN
        ? 'No active plan'
        : (plans.data?.find((p) => p.slug === planValue)?.name ?? planValue)

  return (
    <div className="flex flex-col gap-3 p-4 md:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <SearchInput
          value={search.q ?? ''}
          onSearch={(q) => setFilters({ q: q || undefined })}
          label="Search clients"
          placeholder="Search name, slug, owner email or name"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={search.status ?? 'ALL'}
            onValueChange={(value) =>
              setFilters({ status: value === 'ALL' ? undefined : (value as ClientStatus) })
            }
          >
            <TabsList aria-label="Status" className="rounded-full">
              <TabsTrigger value="ALL" className="rounded-full px-3">
                All
              </TabsTrigger>
              <TabsTrigger value="ACTIVE" className="rounded-full px-3">
                Active
              </TabsTrigger>
              <TabsTrigger value="SUSPENDED" className="rounded-full px-3">
                Suspended
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" aria-label={`Plan: ${planLabel}`}>
                <Layers data-icon="inline-start" />
                {planLabel}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Filter by plan</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={planValue}
                onValueChange={(value) => setFilters({ plan: value === ANY_PLAN ? undefined : value })}
              >
                <DropdownMenuRadioItem value={ANY_PLAN}>All plans</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value={NO_PLAN}>No active plan</DropdownMenuRadioItem>
                {plans.data && plans.data.length > 0 && <DropdownMenuSeparator />}
                {plans.data?.map((plan) => (
                  <DropdownMenuRadioItem key={plan.id} value={plan.slug}>
                    {plan.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {plans.isError && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Couldn't load plans.</p>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" aria-label={`Sort: ${sortLabels[sort]}`}>
                <ArrowDownUp data-icon="inline-start" />
                {sortLabels[sort]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Sort clients</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sort}
                onValueChange={(value) =>
                  setFilters({ sort: value === 'newest' ? undefined : (value as 'oldest' | 'name') })
                }
              >
                {(Object.keys(sortLabels) as ClientSort[]).map((value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {sortLabels[value]}
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
          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() => setFilters(noFilters)}
          >
            <RotateCcw data-icon="inline-start" />
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}

function ClientRow({
  client,
  loggingIn,
  onLoginAs,
  onChangeStatus,
  onActivatePlan,
}: {
  client: AdminClient
  loggingIn: boolean
  onLoginAs: () => void
  onChangeStatus: (status: ClientStatus) => void
  onActivatePlan: () => void
}) {
  const suspended = client.status === 'SUSPENDED'
  const loginBlocked = suspended
    ? 'Activate this client before logging in as it.'
    : client.owner
      ? undefined
      : 'This client has no owner to log in as.'

  return (
    <TableRow className="group/row hover:bg-muted">
      <TableCell className="pl-4">
        <div className="flex max-w-44 flex-col">
          <span className="truncate font-medium" title={client.name}>
            {client.name}
          </span>
          <span className="truncate text-xs text-muted-foreground" title={client.slug}>
            {client.slug} · {client.memberCount} {client.memberCount === 1 ? 'member' : 'members'}
          </span>
        </div>
      </TableCell>
      <TableCell>
        {client.owner ? (
          <div className="flex max-w-40 flex-col">
            <span className="truncate">{client.owner.name}</span>
            <span className="truncate text-xs text-muted-foreground" title={client.owner.email}>
              {client.owner.email}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">No owner</span>
        )}
      </TableCell>
      <TableCell>
        <PlanCell client={client} />
      </TableCell>
      <TableCell>
        <CommentsBar comments={client.comments} />
      </TableCell>
      <TableCell>
        <StatusPill status={client.status} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        <time dateTime={client.createdAt}>{formatDhakaDate(client.createdAt)}</time>
      </TableCell>
      <TableCell className={`${stickyActions} pr-4 transition-colors group-hover/row:bg-muted`}>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onActivatePlan}
            title={client.owner ? undefined : 'This client has no owner, so it has no billing account.'}
            aria-label={`Activate plan: ${client.name}`}
          >
            <CreditCard data-icon="inline-start" />
            Activate plan
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChangeStatus(suspended ? 'ACTIVE' : 'SUSPENDED')}
            aria-label={`${suspended ? 'Activate' : 'Suspend'} ${client.name}`}
          >
            {suspended ? 'Activate' : 'Suspend'}
          </Button>
          <Button
            onClick={onLoginAs}
            disabled={loggingIn || loginBlocked !== undefined}
            title={loginBlocked}
            aria-label={`Login as Client: ${client.name}`}
            className="px-3.5"
          >
            <LogIn data-icon="inline-start" />
            {loggingIn ? 'Opening…' : 'Login as Client'}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

const subscriptionToneClass: Record<SubscriptionTone, string> = {
  trial: 'bg-chart-4/15 text-foreground',
  active: 'bg-primary/10 text-primary',
  ended: 'bg-destructive/10 text-destructive',
  none: 'bg-muted text-muted-foreground',
}

/**
 * Plan · interval · subscription badge (PW-T7, plan §3.7). `plan` is the live plan only (a trial
 * = Starter), so an ended subscription shows a muted dash + Expired / Canceled. The interval
 * shows for a paid live plan (a trial has no billing interval yet).
 */
function PlanCell({ client }: { client: AdminClient }) {
  const { plan, subscription } = client
  const badge = subscriptionBadge(subscription)
  const interval =
    plan && subscription?.status === 'ACTIVE' ? subscriptionIntervalLabels[subscription.interval] : null
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        {plan ? (
          <Badge variant="outline" className="max-w-28" title={plan.name} aria-label={`Plan: ${plan.name}`}>
            <span className="truncate">{plan.name}</span>
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground" aria-label="Plan: no active plan">
            —
          </Badge>
        )}
        {interval && (
          <span data-testid="plan-interval" className="text-xs text-muted-foreground">
            {interval}
          </span>
        )}
      </div>
      <span
        data-testid="subscription-badge"
        data-tone={badge.tone}
        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${subscriptionToneClass[badge.tone]}`}
      >
        {badge.label}
      </span>
    </div>
  )
}

/**
 * Monthly comments this wallet period (PW-T7, plan §3.7): `used / limit · resets 15 Dec` (Dhaka
 * day), bar capped at 100 %. No live plan → "No active plan" instead of a bar; `null` (the backend
 * couldn't read the wallet) → "Usage unavailable".
 */
function CommentsBar({ comments }: { comments: ClientComments | null }) {
  const usage = commentUsage(comments)
  if (usage.kind !== 'bar') {
    return (
      <span data-testid="comments-bar" className="text-xs whitespace-nowrap text-muted-foreground">
        {usage.label}
      </span>
    )
  }
  const text = usage.resets ? `${usage.label} · ${usage.resets}` : usage.label
  return (
    <div className="flex w-32 flex-col gap-1.5" data-testid="comments-bar" title={`${text} (Dhaka time)`}>
      <Progress
        value={usage.percent}
        aria-label="Monthly comments used"
        aria-valuenow={Math.round(usage.percent)}
        aria-valuetext={`${usage.label} comments${usage.resets ? `, ${usage.resets}` : ''}`}
        className={`h-1.5 ${usage.over ? '[&>[data-slot=progress-indicator]]:bg-destructive' : ''}`}
      />
      <span data-testid="comments-text" className="text-xs whitespace-nowrap">
        <span className={`tabular-nums ${usage.over ? 'text-destructive' : ''}`}>{usage.label}</span>
        {usage.resets && <span className="text-muted-foreground"> · {usage.resets}</span>}
      </span>
    </div>
  )
}

function StatusPill({ status }: { status: ClientStatus }) {
  const active = status === 'ACTIVE'
  return (
    <span
      className={
        active
          ? 'inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary'
          : 'inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive'
      }
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {active ? 'Active' : 'Suspended'}
    </span>
  )
}

function SkeletonRow() {
  return (
    <TableRow className="hover:bg-transparent" aria-hidden>
      <TableCell className="pl-4">
        <Skeleton className="mb-1.5 h-4 w-36 rounded-full" />
        <Skeleton className="h-3 w-24 rounded-full" />
      </TableCell>
      <TableCell>
        <Skeleton className="mb-1.5 h-4 w-28 rounded-full" />
        <Skeleton className="h-3 w-40 rounded-full" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-5 w-10 rounded-full" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-1.5 w-24 rounded-full" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-5 w-16 rounded-full" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-4 w-20 rounded-full" />
      </TableCell>
      <TableCell className={`${stickyActions} pr-4`}>
        <div className="flex justify-end gap-2">
          <Skeleton className="h-7 w-16 rounded-full" />
          <Skeleton className="h-8 w-32 rounded-full" />
        </div>
      </TableCell>
    </TableRow>
  )
}

function EmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  const Icon = filtered ? SearchX : Building2
  return (
    <div className="flex flex-col items-center gap-3 border-t px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-6" aria-hidden />
      </span>
      <h2 className="text-base font-semibold">
        {filtered ? 'No clients match these filters' : 'No clients yet'}
      </h2>
      <p className="max-w-md text-sm text-balance text-muted-foreground">
        {filtered
          ? 'Try a shorter search, another status or a wider date range.'
          : 'Workspaces appear here as soon as a brand signs up.'}
      </p>
      {filtered && (
        <Button variant="outline" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 border-t px-6 py-16 text-center">
      <h2 className="text-base font-semibold">Couldn't load clients</h2>
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
        {first}–{skip + shown} of {total} {total === 1 ? 'client' : 'clients'}
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

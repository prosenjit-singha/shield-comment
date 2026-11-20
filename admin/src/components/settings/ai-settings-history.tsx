import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ChevronLeft, ChevronRight, History, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AI_AUDIT_PAGE_SIZE,
  type AiSettingsAuditEntry,
  aiAuditFieldLabel,
  aiAuditQueryOptions,
  formatAiAuditValue,
} from '@/lib/admin-ai-settings'
import { formatDhakaDateTime } from '@/lib/admin-system'

/**
 * A7 "AI settings history" (M5-T4): one row per changed field (provider, Text model, Text + Image
 * model + switch (M5-T15c), `key.<p>` as set/cleared), newest first, 20 per page. The page is component state (the settings page blocks
 * navigation while a draft is dirty), like the plan history.
 */
export function AiSettingsHistory() {
  const [page, setPage] = useState(1)
  const query = useQuery(aiAuditQueryOptions(page))
  const data = query.data
  const pageCount = data ? Math.max(1, Math.ceil(data.total / AI_AUDIT_PAGE_SIZE)) : 1
  const empty = data !== undefined && data.items.length === 0

  return (
    <section aria-labelledby="ai-audit-title" className="flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card">
      <div className="flex flex-col gap-1 p-4 sm:flex-row sm:items-baseline sm:justify-between md:p-5">
        <h2 id="ai-audit-title" className="text-base font-semibold">
          AI settings history
        </h2>
        <p className="text-xs text-muted-foreground">Provider, model, switch and key changes, newest first · Bangladesh time</p>
      </div>

      {query.isError && !data ? (
        <div role="alert" className="flex flex-col items-center gap-3 border-t px-6 py-12 text-center">
          <h3 className="text-base font-semibold">Couldn't load the AI settings history</h3>
          <p className="max-w-md text-sm text-muted-foreground">{query.error.message}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
        </div>
      ) : !data ? (
        <ol aria-busy="true" aria-label="Loading AI settings history" className="flex flex-col">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} data-testid="ai-audit-skeleton" className="flex items-center justify-between gap-3 border-t px-4 py-4 md:px-5" aria-hidden>
              <Skeleton className="h-5 w-72 max-w-full rounded-full" />
              <Skeleton className="h-4 w-28 rounded-full" />
            </li>
          ))}
        </ol>
      ) : empty ? (
        <div className="flex flex-col items-center gap-3 border-t px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <History className="size-6" aria-hidden />
          </span>
          <h3 className="text-base font-semibold">{page > 1 ? 'No changes on this page' : 'No AI settings changes yet'}</h3>
          <p className="max-w-md text-sm text-balance text-muted-foreground">
            {page > 1
              ? 'This page is past the last change.'
              : 'Each provider, model or key change is recorded here with who made it and when. Keys show only as set or cleared.'}
          </p>
          {page > 1 && (
            <Button variant="outline" onClick={() => setPage(1)}>
              Go to first page
            </Button>
          )}
        </div>
      ) : (
        <ol
          aria-label="AI settings changes"
          aria-busy={query.isFetching && query.isPlaceholderData ? true : undefined}
          className="flex flex-col transition-opacity aria-busy:opacity-60"
        >
          {data.items.map((entry) => (
            <AuditRow key={entry.id} entry={entry} />
          ))}
        </ol>
      )}

      {data && data.total > 0 && !empty && (
        <nav
          aria-label="AI settings history pages"
          className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 md:px-5"
        >
          <p className="text-sm text-muted-foreground">
            {data.skip + 1}–{data.skip + data.items.length} of {data.total} {data.total === 1 ? 'change' : 'changes'}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
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
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </nav>
      )}
    </section>
  )
}

function AuditRow({ entry }: { entry: AiSettingsAuditEntry }) {
  const who = entry.admin.name.trim() || entry.admin.email
  return (
    <li data-testid="ai-audit-entry" className="flex min-w-0 flex-col gap-2 border-t px-4 py-3 md:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
          <span data-testid="ai-audit-field" className="font-medium">
            {aiAuditFieldLabel(entry.field)}
          </span>
          <span data-testid="ai-audit-before" className="text-muted-foreground">
            {formatAiAuditValue(entry.field, entry.before)}
          </span>
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="sr-only">changed to</span>
          <span data-testid="ai-audit-after" className="font-medium">
            {formatAiAuditValue(entry.field, entry.after)}
          </span>
        </span>
        <time dateTime={entry.createdAt} className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDhakaDateTime(entry.createdAt)}
        </time>
      </div>
      <p className="min-w-0 text-xs text-muted-foreground">
        by <span className="text-foreground">{who}</span> <span className="break-all">{entry.admin.email}</span>
        {entry.ip && <span> · IP {entry.ip}</span>}
      </p>
    </li>
  )
}

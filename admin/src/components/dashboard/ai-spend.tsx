import { useQuery } from '@tanstack/react-query'
import { Bot, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  type AiAnalysis,
  aiAnalysesQueryOptions,
  aiSummaryQueryOptions,
  analysisNote,
  categoryLabels,
  commentPreview,
  decisionLabels,
  decisionPillClass,
  formatConfidence,
  formatTokenPair,
} from '@/lib/admin-ai'
import { formatCount } from '@/lib/admin-dashboard'
import { formatCallLatency, formatDhakaDateTime, formatUsd } from '@/lib/admin-system'

/** Inline error for one AI block; the rest of the dashboard keeps working. */
export function BlockError({ title, error, onRetry }: { title: string; error: Error; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{error.message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RotateCcw data-icon="inline-start" />
        Try again
      </Button>
    </div>
  )
}

function SpendCard({ label, value, caption, tone }: { label: string; value: string; caption: string; tone?: string }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2 rounded-2xl border bg-card p-5">
      <h3 className="truncate text-sm text-muted-foreground">{label}</h3>
      <p className={`truncate text-2xl font-semibold tracking-tight tabular-nums ${tone ?? ''}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{caption}</p>
    </section>
  )
}

/** D26 cards: credit added, estimated spend, estimated remaining, comments analyzed. */
export function AiSpendCards() {
  const query = useQuery(aiSummaryQueryOptions())
  const s = query.data

  if (query.isError) {
    return (
      <div className="rounded-2xl border bg-card">
        <BlockError title="Couldn’t load AI spend" error={query.error} onRetry={() => void query.refetch()} />
      </div>
    )
  }
  if (!s) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Loading AI spend">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
    )
  }

  const negative = s.estimatedRemainingUsd < 0
  const { today, last7Days, total } = s.commentsAnalyzed
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SpendCard label="Credit added" value={formatUsd(s.creditAddedUsd)} caption="Sum of the top-ups below" />
        <SpendCard
          label="Estimated spend"
          value={formatUsd(s.estimatedSpendUsd)}
          caption={`${formatTokenPair(s.tokens.input, s.tokens.output)} tokens`}
        />
        <SpendCard
          label="Estimated remaining"
          value={formatUsd(s.estimatedRemainingUsd)}
          tone={negative ? 'text-destructive' : undefined}
          caption={negative ? 'Spend is above the credit added: top up on Neon' : 'Credit added − estimated spend'}
        />
        <SpendCard
          label="Comments analyzed"
          value={formatCount(today)}
          caption={`today · ${formatCount(last7Days)} in 7 days · ${formatCount(total)} total`}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Estimate from our token counts; exact balance: Neon Console → Billing.
        {s.unpricedCalls > 0 &&
          ` ${formatCount(s.unpricedCalls)} ${s.unpricedCalls === 1 ? 'call' : 'calls'} on models without a price are not counted.`}
      </p>
    </div>
  )
}

/** D25: the last 20 analyzed comments across all clients. */
export function RecentAnalyses() {
  const query = useQuery(aiAnalysesQueryOptions())
  const items = query.data?.items

  return (
    <section aria-label="Recent AI analyses" className="min-w-0 rounded-3xl border bg-card">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-base font-semibold">Recent AI analyses</h2>
        <p className="text-sm text-muted-foreground">Last 20 comments the AI judged, all clients. Bangladesh time.</p>
      </div>
      {query.isError ? (
        <BlockError title="Couldn’t load the analyses" error={query.error} onRetry={() => void query.refetch()} />
      ) : items && items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 border-t px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Bot className="size-6" aria-hidden />
          </span>
          <p className="text-sm text-muted-foreground">No comments analyzed yet.</p>
        </div>
      ) : (
        <div className="min-w-0 border-t">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Time</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead className="pr-5">Latency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items
                ? items.map((a) => <AnalysisRow key={a.id} analysis={a} />)
                : Array.from({ length: 3 }, (_, i) => (
                    <TableRow key={i} className="hover:bg-transparent" aria-hidden>
                      {Array.from({ length: 9 }, (_, j) => (
                        <TableCell key={j} className={j === 0 ? 'pl-5' : undefined}>
                          <Skeleton className="h-4 w-16 rounded-full" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

function AnalysisRow({ analysis: a }: { analysis: AiAnalysis }) {
  const note = analysisNote(a)
  return (
    <TableRow data-testid="analysis-row" className="align-top hover:bg-muted">
      <TableCell className="pl-5 whitespace-nowrap tabular-nums">{formatDhakaDateTime(a.classifiedAt)}</TableCell>
      <TableCell>
        <div className="flex max-w-44 flex-col">
          <span className="truncate font-medium" title={a.workspace.name}>
            {a.workspace.name}
          </span>
          <span className="truncate text-xs text-muted-foreground" title={a.page?.name}>
            {a.page ? a.page.name : 'Disconnected Page'}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <CommentText message={a.message} />
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <span className={`inline-flex w-fit rounded-full px-2.5 py-0.5 text-xs font-medium ${decisionPillClass[a.decision]}`}>
            {decisionLabels[a.decision]}
          </span>
          {note && <span className="max-w-40 text-xs text-destructive">{note}</span>}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col whitespace-nowrap">
          <span>{categoryLabels[a.category]}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{formatConfidence(a.confidence)}</span>
        </div>
      </TableCell>
      <TableCell className="max-w-36 truncate font-mono text-xs" title={a.model}>
        {a.model}
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">{formatTokenPair(a.inputTokens, a.outputTokens)}</TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">{formatUsd(a.estimatedCostUsd)}</TableCell>
      <TableCell className="pr-5 whitespace-nowrap tabular-nums">{formatCallLatency(a.latencyMs)}</TableCell>
    </TableRow>
  )
}

/** Untrusted client text: plain text only, truncated with a toggle (full text also on hover). */
function CommentText({ message }: { message: string | null }) {
  const [open, setOpen] = useState(false)
  if (message === null) return <span className="text-xs text-muted-foreground italic">No text</span>
  const preview = commentPreview(message)
  const long = preview !== message
  return (
    <div className="flex max-w-72 min-w-48 flex-col items-start gap-0.5">
      <p className="text-sm break-words whitespace-pre-wrap" title={message} data-testid="comment-text">
        {open ? message : preview}
      </p>
      {long && (
        <button
          type="button"
          className="text-xs text-primary underline-offset-2 hover:underline"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Show less' : 'Show full comment'}
        </button>
      )}
    </div>
  )
}

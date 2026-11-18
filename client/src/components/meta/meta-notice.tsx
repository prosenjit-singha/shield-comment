import { CircleAlert, CircleCheck, Info, RotateCw, TriangleAlert, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { toApiError } from '@/lib/api'
import { metaReturnNotices, pagesLoadErrorMessage, type NoticeTone } from '@/lib/meta-messages'
import type { MetaReturnSearch } from '@/lib/meta-pages'
import { cn } from '@/lib/utils'

const TONE_CLASS: Record<NoticeTone, string> = {
  success: 'border-primary/30 bg-primary/10',
  info: 'border-border bg-muted',
  warning: 'border-accent bg-accent/25',
  error: 'border-destructive/30 bg-destructive/10',
}

const TONE_ICON: Record<NoticeTone, string> = {
  success: 'text-primary',
  info: 'text-muted-foreground',
  warning: 'text-accent-foreground',
  error: 'text-destructive',
}

/**
 * Inline message box (`rounded-2xl`, same frame as `AuthAlert`). Errors are `role="alert"`, the rest
 * `role="status"`; `data-kind` names the case for tests.
 */
export function MetaNotice({
  tone,
  kind,
  network = false,
  children,
  action,
  className,
}: {
  tone: NoticeTone
  kind: string
  network?: boolean
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  const Icon = network ? WifiOff : tone === 'success' ? CircleCheck : tone === 'warning' ? TriangleAlert : tone === 'info' ? Info : CircleAlert
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-kind={kind}
      data-tone={tone}
      className={cn('flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm text-foreground', TONE_CLASS[tone], className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', TONE_ICON[tone])} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-pretty">{children}</p>
        {action}
      </div>
    </div>
  )
}

/** The notices for `?meta=connected[&skipped=N]` / `?meta=error&reason=` (D6 callback return). */
export function MetaReturnNotices({ search }: { search: MetaReturnSearch }) {
  const { content } = useLanguage()
  return metaReturnNotices(search, content).map((notice) => (
    <MetaNotice key={notice.kind} tone={notice.tone} kind={notice.kind}>
      {notice.text}
    </MetaNotice>
  ))
}

/** `GET …/pages` failed: message + Try again (refetch). */
export function PagesLoadErrorNotice({
  error,
  retrying,
  onRetry,
}: {
  error: unknown
  retrying: boolean
  onRetry: () => void
}) {
  const { content } = useLanguage()
  const apiError = toApiError(error)
  return (
    <MetaNotice
      tone="error"
      kind="pages-load"
      network={apiError.isNetwork}
      action={
        <Button variant="outline" size="sm" className="h-9 shrink-0 px-4" onClick={onRetry} disabled={retrying}>
          <RotateCw aria-hidden />
          {content('Try again', 'আবার চেষ্টা করুন')}
        </Button>
      }
    >
      {pagesLoadErrorMessage(apiError, content)}
    </MetaNotice>
  )
}

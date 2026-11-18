import { LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { Switch } from '@/components/ui/switch'
import { useLanguage } from '@/hooks/use-language'
import type { ApiError } from '@/lib/api'
import { pageToggleErrorMessage } from '@/lib/meta-messages'
import { pageToggleFailure, type WorkspacePage } from '@/lib/meta-pages'
import { MetaNotice } from './meta-notice'
import { PageIdentity, PageStatusPill } from './page-identity'

/** A toggle that failed: the error and the state the user asked for. */
export interface PageToggleError {
  error: ApiError
  target: boolean
}

/**
 * One Page (`<li>`): identity, pills, protection `Switch`, then an optional hint and the failed toggle's
 * message (409 `PAGE_LIMIT_REACHED` / `PAGE_TOKEN_MISSING` / other). Used by `/onboarding` and `/pages`.
 */
export function PageToggleRow({
  page,
  disabled,
  pending,
  failure,
  pills,
  hint,
  onToggle,
}: {
  page: WorkspacePage
  disabled: boolean
  pending: boolean
  failure: PageToggleError | null
  /** Extra pills after the status pill. */
  pills?: ReactNode
  hint?: ReactNode
  onToggle: (isActive: boolean) => void
}) {
  const { content } = useLanguage()
  const reason = failure ? pageToggleFailure(failure.error) : null
  return (
    <li className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-3 sm:flex-nowrap sm:p-4">
        <PageIdentity page={page} />
        <div className="flex items-center gap-2">
          <PageStatusPill page={page} />
          {pills}
          {pending ? (
            <LoaderCircle className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
          ) : null}
          <Switch
            checked={page.isActive}
            disabled={disabled}
            aria-busy={pending || undefined}
            aria-label={content(`Protect ${page.pageName}`, `${page.pageName} সুরক্ষিত রাখুন`)}
            onCheckedChange={(checked) => onToggle(checked)}
          />
        </div>
      </div>
      {hint}
      {reason && failure ? (
        <MetaNotice
          tone="error"
          kind={reason.kind === 'other' ? `toggle:${failure.error.status}` : reason.kind}
          network={failure.error.isNetwork}
        >
          {pageToggleErrorMessage(reason, failure.target, content)}
        </MetaNotice>
      ) : null}
    </li>
  )
}

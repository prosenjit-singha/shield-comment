import { Badge } from '@/components/ui/badge'
import { useLanguage } from '@/hooks/use-language'
import { bnNumber } from '@/lib/language'
import type { WorkspacePage, WorkspacePageLimit } from '@/lib/meta-pages'
import { cn } from '@/lib/utils'
import { FacebookIcon, InstagramIcon } from './brand-icons'

/** Facebook Page name + its linked Instagram account (D4: IG comes through the Page). */
export function PageIdentity({ page }: { page: WorkspacePage }) {
  const { content } = useLanguage()
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <FacebookIcon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate font-medium">{page.pageName}</p>
        <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {page.igBusinessId ? (
            <>
              <InstagramIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                {page.igUsername ? `@${page.igUsername}` : content('Instagram account linked', 'ইনস্টাগ্রাম অ্যাকাউন্ট যুক্ত')}
              </span>
            </>
          ) : (
            content('No Instagram account linked', 'কোনো ইনস্টাগ্রাম অ্যাকাউন্ট যুক্ত নেই')
          )}
        </p>
      </div>
    </div>
  )
}

/** On / Off / Reconnect needed (no stored Page token). */
export function PageStatusPill({ page }: { page: WorkspacePage }) {
  const { content } = useLanguage()
  if (!page.hasToken) {
    return (
      <Badge variant="destructive" data-status="needs-reconnect">
        {content('Reconnect needed', 'আবার কানেক্ট দরকার')}
      </Badge>
    )
  }
  return page.isActive ? (
    <Badge data-status="on">{content('Protected', 'সুরক্ষিত')}</Badge>
  ) : (
    <Badge variant="outline" data-status="off">
      {content('Off', 'বন্ধ')}
    </Badge>
  )
}

/** Instagram linked / not linked (D4: the IG Business account comes through the Page). */
export function InstagramPill({ page }: { page: WorkspacePage }) {
  const { content } = useLanguage()
  return page.igBusinessId ? (
    <Badge variant="secondary" data-instagram="linked">
      <InstagramIcon data-icon="inline-start" />
      {content('Instagram linked', 'ইনস্টাগ্রাম যুক্ত')}
    </Badge>
  ) : (
    <Badge variant="outline" data-instagram="none" className="text-muted-foreground">
      <InstagramIcon data-icon="inline-start" />
      {content('No Instagram', 'ইনস্টাগ্রাম নেই')}
    </Badge>
  )
}

/** `activeCount / limit` of the plan's `connectedPages` (D10). */
export function PageLimitPill({ pageLimit, className }: { pageLimit: WorkspacePageLimit; className?: string }) {
  const { content } = useLanguage()
  return (
    <span
      data-testid="page-limit"
      className={cn('rounded-full border bg-muted px-3 py-1 text-xs font-medium whitespace-nowrap text-foreground', className)}
    >
      {content(
        `${pageLimit.activeCount} / ${pageLimit.limit} Pages on`,
        `${bnNumber(pageLimit.activeCount)} / ${bnNumber(pageLimit.limit)}টি পেজ চালু`,
      )}
    </span>
  )
}

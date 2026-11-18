import { Badge } from '@/components/ui/badge'
import { useLanguage } from '@/hooks/use-language'
import type { WorkspacePage } from '@/lib/meta-pages'
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

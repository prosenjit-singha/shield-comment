import { Link, useLocation } from '@tanstack/react-router'
import {
  ChartLine,
  Ellipsis,
  FlaskConical,
  Gem,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  MessagesSquare,
  PanelsTopLeft,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import type { ContentFn } from '@/lib/auth-errors'
import { useLanguage } from '@/hooks/use-language'

/**
 * `_app` navigation (M6-T8, D16 c): a sidebar from `md` up, a fixed bottom bar below it. Both are in
 * the DOM and CSS picks one (no JS breakpoint, no flash of the wrong one).
 * Order: Dashboard, Comments, Pages, Rules, Playground, Analytics, Plans, Support, Settings (M7-T11, D16 a).
 * The bottom bar shows `BOTTOM_BAR` + a "More" sheet with the rest. Only routes that exist are listed
 * (a `<Link>` to a missing route breaks the router types). Settings links `/settings` (→ `/settings/team`)
 * so it stays active on every settings tab.
 */
interface NavItem {
  to: '/dashboard' | '/comments' | '/pages' | '/rules' | '/playground' | '/analytics' | '/plans' | '/support' | '/settings'
  icon: LucideIcon
  label: (content: ContentFn) => string
}

const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', icon: LayoutDashboard, label: (c) => c('Dashboard', 'ড্যাশবোর্ড') },
  { to: '/comments', icon: MessagesSquare, label: (c) => c('Comments', 'কমেন্ট') },
  { to: '/pages', icon: PanelsTopLeft, label: (c) => c('Pages', 'পেজ') },
  { to: '/rules', icon: ListChecks, label: (c) => c('Rules', 'নিয়ম') },
  { to: '/playground', icon: FlaskConical, label: (c) => c('Playground', 'প্লেগ্রাউন্ড') },
  { to: '/analytics', icon: ChartLine, label: (c) => c('Analytics', 'অ্যানালিটিক্স') },
  { to: '/plans', icon: Gem, label: (c) => c('Plans', 'প্ল্যান') },
  { to: '/support', icon: LifeBuoy, label: (c) => c('Support', 'সাপোর্ট') },
  { to: '/settings', icon: Settings, label: (c) => c('Settings', 'সেটিংস') },
]

const BOTTOM_BAR: NavItem['to'][] = ['/dashboard', '/comments', '/rules', '/analytics']
const MORE_ITEMS = NAV_ITEMS.filter((item) => !BOTTOM_BAR.includes(item.to))

export function AppSidebar() {
  const { content } = useLanguage()
  return (
    <nav
      aria-label={content('Main', 'প্রধান মেনু')}
      data-testid="app-sidebar"
      className="sticky top-6 hidden w-52 shrink-0 flex-col gap-1 self-start rounded-3xl border bg-card p-2 md:flex"
    >
      {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ includeSearch: false }}
          className="flex items-center gap-3 rounded-full px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[status=active]:bg-primary/10 data-[status=active]:text-primary"
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          {label(content)}
        </Link>
      ))}
    </nav>
  )
}

export function AppBottomBar() {
  const { content } = useLanguage()
  const pathname = useLocation({ select: (location) => location.pathname })
  const moreActive = MORE_ITEMS.some(({ to }) => pathname === to || pathname.startsWith(`${to}/`))
  const itemClass =
    'flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-full px-2 py-1.5 text-[0.7rem] font-medium text-muted-foreground transition-colors data-[status=active]:bg-primary/10 data-[status=active]:text-primary'

  return (
    <nav
      aria-label={content('Main', 'প্রধান মেনু')}
      data-testid="app-bottom-bar"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="mx-auto flex max-w-md items-stretch justify-around gap-1 px-2 py-1.5">
        {NAV_ITEMS.filter(({ to }) => BOTTOM_BAR.includes(to)).map(({ to, icon: Icon, label }) => (
          <Link key={to} to={to} activeOptions={{ includeSearch: false }} className={itemClass}>
            <Icon className="size-5 shrink-0" aria-hidden />
            <span className="max-w-full truncate">{label(content)}</span>
          </Link>
        ))}
        <Sheet>
          <SheetTrigger className={itemClass} data-status={moreActive ? 'active' : undefined}>
            <Ellipsis className="size-5 shrink-0" aria-hidden />
            <span className="max-w-full truncate">{content('More', 'আরও')}</span>
          </SheetTrigger>
          <SheetContent side="bottom" from="bottom" className="rounded-t-3xl pb-[env(safe-area-inset-bottom)]">
            <SheetHeader>
              <SheetTitle>{content('More', 'আরও')}</SheetTitle>
              <SheetDescription className="sr-only">{content('Other pages', 'অন্যান্য পেজ')}</SheetDescription>
            </SheetHeader>
            <nav aria-label={content('More pages', 'আরও পেজ')} className="flex flex-col gap-1 px-2 pb-4">
              {MORE_ITEMS.map(({ to, icon: Icon, label }) => (
                <SheetClose key={to} asChild>
                  <Link
                    to={to}
                    activeOptions={{ includeSearch: false }}
                    className="flex items-center gap-3 rounded-full px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[status=active]:bg-primary/10 data-[status=active]:text-primary"
                  >
                    <Icon className="size-5 shrink-0" aria-hidden />
                    {label(content)}
                  </Link>
                </SheetClose>
              ))}
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </nav>
  )
}

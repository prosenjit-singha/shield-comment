import { Link } from '@tanstack/react-router'
import { Gem, LayoutDashboard, PanelsTopLeft, type LucideIcon } from 'lucide-react'
import type { ContentFn } from '@/lib/auth-errors'
import { useLanguage } from '@/hooks/use-language'

/**
 * `_app` navigation (M6-T8, D16 c): a sidebar from `md` up, a fixed bottom bar below it. Both are in
 * the DOM and CSS picks one (no JS breakpoint, no flash of the wrong one).
 * D16 order: Dashboard, Comments, Pages, Rules, Playground, Analytics, Plans. Only routes that exist
 * are listed (a `<Link>` to a missing route breaks the router types); M6-T9…T12 add Comments, Rules,
 * Playground and Analytics here as they ship.
 */
interface NavItem {
  to: '/dashboard' | '/pages' | '/plans'
  icon: LucideIcon
  label: (content: ContentFn) => string
}

const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', icon: LayoutDashboard, label: (c) => c('Dashboard', 'ড্যাশবোর্ড') },
  { to: '/pages', icon: PanelsTopLeft, label: (c) => c('Pages', 'পেজ') },
  { to: '/plans', icon: Gem, label: (c) => c('Plans', 'প্ল্যান') },
]

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
  return (
    <nav
      aria-label={content('Main', 'প্রধান মেনু')}
      data-testid="app-bottom-bar"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="mx-auto flex max-w-md items-stretch justify-around gap-1 px-2 py-1.5">
        {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ includeSearch: false }}
            className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-full px-2 py-1.5 text-[0.7rem] font-medium text-muted-foreground transition-colors data-[status=active]:bg-primary/10 data-[status=active]:text-primary"
          >
            <Icon className="size-5 shrink-0" aria-hidden />
            <span className="max-w-full truncate">{label(content)}</span>
          </Link>
        ))}
      </div>
    </nav>
  )
}

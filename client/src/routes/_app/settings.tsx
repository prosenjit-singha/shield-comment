import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { useLanguage } from '@/hooks/use-language'

/** `/settings` layout (M7-T11, D16 a): Team (C11) and Alerts (C12) as route tabs. */
export const Route = createFileRoute('/_app/settings')({
  head: () => ({ meta: [{ title: 'Settings | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: SettingsLayout,
})

const TABS = [
  { to: '/settings/team', en: 'Team', bn: 'টিম' },
  { to: '/settings/alerts', en: 'Alerts', bn: 'অ্যালার্ট' },
] as const

function SettingsLayout() {
  const { content } = useLanguage()
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{content('Settings', 'সেটিংস')}</h1>
      <nav aria-label={content('Settings', 'সেটিংস')} className="flex w-fit gap-1 rounded-full border bg-card p-1">
        {TABS.map(({ to, en, bn }) => (
          <Link
            key={to}
            to={to}
            className="rounded-full px-4 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-primary/10 data-[status=active]:text-primary"
          >
            {content(en, bn)}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}

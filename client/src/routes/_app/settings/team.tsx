import { createFileRoute } from '@tanstack/react-router'
import { useLanguage } from '@/hooks/use-language'

/** C11 `/settings/team` (M7-T11 placeholder; M7-T13 builds it). */
export const Route = createFileRoute('/_app/settings/team')({
  head: () => ({ meta: [{ title: 'Team | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: TeamSettings,
})

function TeamSettings() {
  const { content } = useLanguage()
  return (
    <p className="rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
      {content('Team management is coming soon.', 'টিম ম্যানেজমেন্ট শিগগিরই আসছে।')}
    </p>
  )
}

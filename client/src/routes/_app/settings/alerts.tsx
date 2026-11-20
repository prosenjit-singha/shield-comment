import { createFileRoute } from '@tanstack/react-router'
import { useLanguage } from '@/hooks/use-language'

/** C12 `/settings/alerts` (M7-T11 placeholder; M7-T15 builds it). */
export const Route = createFileRoute('/_app/settings/alerts')({
  head: () => ({ meta: [{ title: 'Alerts | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: AlertSettings,
})

function AlertSettings() {
  const { content } = useLanguage()
  return (
    <p className="rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
      {content('Scam-spike alerts are coming soon.', 'স্ক্যাম-স্পাইক অ্যালার্ট শিগগিরই আসছে।')}
    </p>
  )
}

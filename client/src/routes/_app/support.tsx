import { createFileRoute } from '@tanstack/react-router'
import { useLanguage } from '@/hooks/use-language'

/** C13 `/support` (M7-T11 placeholder; M7-T12 builds the tickets). */
export const Route = createFileRoute('/_app/support')({
  head: () => ({ meta: [{ title: 'Support | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: SupportPage,
})

function SupportPage() {
  const { content } = useLanguage()
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{content('Support', 'সাপোর্ট')}</h1>
        <p className="text-sm text-muted-foreground">
          {content('Ask our team for help and follow the replies.', 'আমাদের টিমের কাছে সাহায্য চান এবং উত্তরগুলো দেখুন।')}
        </p>
      </div>
      <p className="rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
        {content('Support tickets are coming soon.', 'সাপোর্ট টিকিট শিগগিরই আসছে।')}
      </p>
    </div>
  )
}

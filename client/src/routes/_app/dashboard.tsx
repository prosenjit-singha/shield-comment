import { createFileRoute } from '@tanstack/react-router'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useLanguage } from '@/hooks/use-language'

/** Placeholder logged-in page (SW-T7). Charts and KPIs arrive with Module 6. */
export const Route = createFileRoute('/_app/dashboard')({
  head: () => ({ meta: [{ title: 'Dashboard | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: DashboardPage,
})

function DashboardPage() {
  const { session } = Route.useRouteContext()
  const { content } = useLanguage()

  const kpis = [
    content('Comments scanned', 'স্ক্যান করা কমেন্ট'),
    content('Auto-hidden', 'অটো-হাইড'),
    content('Connected pages', 'কানেক্টেড পেজ'),
  ]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{content('Dashboard', 'ড্যাশবোর্ড')}</h1>
        <p className="text-sm text-muted-foreground">
          {content('Signed in as', 'লগ ইন করেছেন')} {session.user.name}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {kpis.map((label) => (
          <Card key={label} className="rounded-2xl">
            <CardHeader>
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-3xl">—</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card className="rounded-3xl">
        <CardContent className="text-sm text-muted-foreground">
          {content('Charts and live numbers arrive in Module 6.', 'চার্ট ও লাইভ সংখ্যা মডিউল ৬-এ আসবে।')}
        </CardContent>
      </Card>
    </div>
  )
}

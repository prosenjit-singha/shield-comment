import { createFileRoute } from '@tanstack/react-router'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const Route = createFileRoute('/_authed/admin/dashboard')({
  component: DashboardPage,
})

const kpis = ['Active clients', 'Monthly revenue (৳)', 'Comments scanned', 'Open tickets'] as const

function DashboardPage() {
  const { session } = Route.useRouteContext()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Signed in as {session.user.name}.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          Charts and live numbers arrive in Module 2.
        </CardContent>
      </Card>
    </div>
  )
}

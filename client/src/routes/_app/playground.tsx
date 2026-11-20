import { createFileRoute } from '@tanstack/react-router'
import { PlaygroundForm } from '@/components/playground/playground-form'
import { useLanguage } from '@/hooks/use-language'

/** C8 `/playground` (M6-T11, D9/D7): every member, impersonated ok; free, daily limit set by the admin. */
export const Route = createFileRoute('/_app/playground')({
  head: () => ({ meta: [{ title: 'Playground | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: PlaygroundPage,
})

function PlaygroundPage() {
  const { session } = Route.useRouteContext()
  const { content } = useLanguage()
  const workspaceId = session.session.activeOrganizationId

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{content('Playground', 'প্লেগ্রাউন্ড')}</h1>
        <p className="text-sm text-muted-foreground">
          {content(
            'Try a comment and see what your rules and the AI would do with it.',
            'একটি কমেন্ট লিখে দেখুন আপনার নিয়ম ও AI এটির সাথে কী করত।',
          )}
        </p>
      </div>
      {workspaceId ? (
        <PlaygroundForm workspaceId={workspaceId} />
      ) : (
        <p className="rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
          {content('No workspace is selected for this account yet.', 'এই অ্যাকাউন্টে এখনো কোনো ওয়ার্কস্পেস বেছে নেওয়া হয়নি।')}
        </p>
      )}
    </div>
  )
}

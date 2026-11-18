import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { LoaderCircle, RotateCw } from 'lucide-react'
import { AuthScreen } from '@/components/auth/auth-screen'
import { MetaNotice } from '@/components/meta/meta-notice'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import {
  dataDeletionFailure,
  formatDhakaDateTime,
  validateDataDeletionSearch,
  type DataDeletionStatus,
} from '@/lib/data-deletion'
import { dataDeletionStatusQueryOptions } from '@/lib/data-deletion-query'

/**
 * Meta Data Deletion status page (D6, M4-T12): the `url` the backend gives Meta
 * (`CLIENT_APP_URL/data-deletion?code=<22 chars>`). Public, no session, server-rendered: the server
 * loader runs the lookup so the status is in the first HTML; a failed server lookup (429 / 5xx / network)
 * renders the loading state and the browser tries once more on mount.
 */
export const Route = createFileRoute('/data-deletion')({
  validateSearch: validateDataDeletionSearch,
  loaderDeps: ({ search }) => ({ code: search.code }),
  loader: async ({ context, deps }) => {
    // Browser navigations fetch from the component (one request, no loader + mount double fetch).
    if (deps.code && typeof window === 'undefined') {
      await context.queryClient.prefetchQuery(dataDeletionStatusQueryOptions(deps.code))
    }
  },
  head: () => ({
    meta: [{ title: 'Data deletion status | ShieldComment BD' }, { name: 'robots', content: 'noindex' }],
  }),
  component: DataDeletionPage,
})

function DataDeletionPage() {
  const { code } = Route.useSearch()
  const { content } = useLanguage()
  return (
    <AuthScreen
      title={content('Data deletion request', 'ডেটা মুছে ফেলার অনুরোধ')}
      description={content(
        'The status of your request to delete your Facebook data from ShieldComment BD.',
        'ShieldComment BD থেকে আপনার ফেসবুক ডেটা মুছে ফেলার অনুরোধের অবস্থা।',
      )}
      footer={
        <Link to="/" className="font-medium text-primary underline-offset-4 hover:underline">
          {content('Back to ShieldComment BD', 'ShieldComment BD-তে ফিরে যান')}
        </Link>
      }
    >
      {code ? <RequestStatus code={code} /> : <MissingCode />}
    </AuthScreen>
  )
}

function MissingCode() {
  const { content } = useLanguage()
  return (
    <MetaNotice tone="info" kind="missing-code">
      {content(
        'This link has no valid confirmation code. Open the link Facebook gave you after you removed ShieldComment BD. On Facebook you find it under Settings & privacy → Settings → Apps and websites → Removed → ShieldComment BD.',
        'এই লিংকে কোনো সঠিক কনফার্মেশন কোড নেই। ShieldComment BD রিমুভ করার পর ফেসবুক যে লিংক দিয়েছে সেটি খুলুন। ফেসবুকে এটি পাবেন সেটিংস ও গোপনীয়তা → সেটিংস → অ্যাপ ও ওয়েবসাইট → রিমুভ করা → ShieldComment BD-তে।',
      )}
    </MetaNotice>
  )
}

function RequestStatus({ code }: { code: string }) {
  const { content } = useLanguage()
  const query = useQuery(dataDeletionStatusQueryOptions(code))

  let body
  if (query.data?.kind === 'found') {
    body = <FoundRequest request={query.data.request} />
  } else if (query.data?.kind === 'unknown') {
    body = (
      <MetaNotice tone="error" kind="unknown-code">
        {content(
          "We couldn't find a request with this confirmation code. Check that you opened the full link from Facebook.",
          'এই কনফার্মেশন কোডে কোনো অনুরোধ পাওয়া যায়নি। ফেসবুক থেকে পুরো লিংকটি খুলেছেন কি না দেখুন।',
        )}
      </MetaNotice>
    )
  } else if (query.isError) {
    body = <LookupFailed error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} />
  } else {
    body = (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
        {content('Checking your request…', 'আপনার অনুরোধ দেখা হচ্ছে…')}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {body}
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="px-4 text-muted-foreground">{content('Confirmation code', 'কনফার্মেশন কোড')}</span>
        <code data-testid="confirmation-code" className="rounded-full bg-muted px-4 py-2 font-mono text-sm break-all">
          {code}
        </code>
        <span className="px-4 text-xs text-muted-foreground">
          {content('Quote this code if you contact our support.', 'সাপোর্টে যোগাযোগ করলে এই কোডটি জানান।')}
        </span>
      </div>
    </div>
  )
}

function FoundRequest({ request }: { request: DataDeletionStatus }) {
  const { content, language } = useLanguage()
  const completed = request.status === 'COMPLETED'
  return (
    <div className="flex flex-col gap-4">
      <MetaNotice tone={completed ? 'success' : 'info'} kind={`status:${request.status}`}>
        {completed
          ? content('Your data has been deleted.', 'আপনার ডেটা মুছে ফেলা হয়েছে।')
          : content(
              'We received your request. Your data is being deleted.',
              'আপনার অনুরোধ পেয়েছি। আপনার ডেটা মুছে ফেলা হচ্ছে।',
            )}
      </MetaNotice>
      <dl className="flex flex-col gap-3 rounded-2xl border bg-muted/50 px-4 py-3 text-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">{content('Requested', 'অনুরোধের সময়')}</dt>
          <dd className="font-medium">{formatDhakaDateTime(request.requestedAt, language)}</dd>
        </div>
        {request.completedAt && (
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">{content('Completed', 'সম্পন্ন হওয়ার সময়')}</dt>
            <dd className="font-medium">{formatDhakaDateTime(request.completedAt, language)}</dd>
          </div>
        )}
      </dl>
      <p className="px-1 text-sm text-pretty text-muted-foreground">
        {completed
          ? content(
              'We deleted your Facebook connection, its Pages and their comments. We only keep daily comment counts per Page, which contain no personal data.',
              'আমরা আপনার ফেসবুক কানেকশন, এর পেজগুলো ও সেগুলোর কমেন্ট মুছে ফেলেছি। শুধু প্রতিটি পেজের দৈনিক কমেন্ট সংখ্যা রাখা হয়, যাতে কোনো ব্যক্তিগত তথ্য নেই।',
            )
          : content(
              'This usually takes a few minutes. Open this page again later to see the result.',
              'সাধারণত কয়েক মিনিট লাগে। ফলাফল দেখতে পরে আবার এই পেজটি খুলুন।',
            )}
      </p>
    </div>
  )
}

function LookupFailed({ error, retrying, onRetry }: { error: unknown; retrying: boolean; onRetry: () => void }) {
  const { content } = useLanguage()
  const failure = dataDeletionFailure(error)
  const message =
    failure === 'rate-limited'
      ? content(
          'Too many checks in a short time. Wait a minute, then try again.',
          'অল্প সময়ে অনেকবার দেখা হয়েছে। এক মিনিট অপেক্ষা করে আবার চেষ্টা করুন।',
        )
      : failure === 'network'
        ? content(
            "Can't reach ShieldComment right now. Check your internet connection and try again.",
            'এখন ShieldComment-এ সংযোগ করা যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
          )
        : content(
            "We couldn't check the status right now. Please try again.",
            'এখন অবস্থা দেখা যাচ্ছে না। আবার চেষ্টা করুন।',
          )
  return (
    <MetaNotice
      tone="error"
      kind={`lookup:${failure}`}
      network={failure === 'network'}
      action={
        <Button variant="outline" size="sm" className="h-9 shrink-0 px-4" onClick={onRetry} disabled={retrying}>
          <RotateCw aria-hidden />
          {content('Try again', 'আবার চেষ্টা করুন')}
        </Button>
      }
    >
      {message}
    </MetaNotice>
  )
}

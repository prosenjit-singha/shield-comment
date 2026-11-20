import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, LoaderCircle, MessageSquareReply } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { MetaNotice } from '@/components/meta/meta-notice'
import { ChoiceGroup } from '@/components/rules/rule-controls'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import type { ApiError } from '@/lib/api'
import type { CommentPlatform } from '@/lib/comments-feed'
import { categoryLabel, formatCount } from '@/lib/dashboard-summary'
import {
  decisionLine,
  PLAYGROUND_TEXT_MAX,
  playgroundErrorMessage,
  playgroundTextError,
  playgroundUsageQueryKey,
  playgroundUsageQueryOptions,
  reviewHint,
  ruleKindLabel,
  runPlaygroundTest,
  testsLeftLine,
  type PlaygroundInput,
  type PlaygroundResult,
  type PlaygroundUsage,
} from '@/lib/playground'

/** C8 form + result (M6-T11): test a comment against the workspace rules and the AI. Nothing is stored or posted. */
export function PlaygroundForm({ workspaceId }: { workspaceId: string }) {
  const { content, language } = useLanguage()
  const queryClient = useQueryClient()
  const textId = useId()
  const [text, setText] = useState('')
  const [platform, setPlatform] = useState<CommentPlatform>('FACEBOOK')
  const [textError, setTextError] = useState<string | null>(null)
  const usage = useQuery(playgroundUsageQueryOptions(workspaceId))

  const test = useMutation<PlaygroundResult, ApiError, PlaygroundInput>({
    mutationFn: (input) => runPlaygroundTest(workspaceId, input),
    onSuccess: ({ testsLeft }) => {
      queryClient.setQueryData<PlaygroundUsage>(playgroundUsageQueryKey(workspaceId), (old) =>
        old ? { ...old, testsLeft, used: Math.max(0, old.limit - testsLeft) } : old,
      )
    },
    onError: (error) => {
      if (error.status === 429) void queryClient.invalidateQueries({ queryKey: playgroundUsageQueryKey(workspaceId) })
    },
  })

  const noneLeft = usage.data?.testsLeft === 0
  const length = text.trim().length

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const problem = playgroundTextError(text, content)
    setTextError(problem)
    if (!problem) test.mutate({ text, platform })
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submit} noValidate className="flex flex-col gap-5 rounded-3xl border bg-card p-5 sm:p-6">
        <p data-testid="tests-left" className="w-fit rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground empty:hidden">
          {usage.data
            ? testsLeftLine(usage.data, content, language)
            : usage.isError
              ? content('Couldn’t check how many tests are left today.', 'আজ কতগুলো টেস্ট বাকি আছে তা দেখা যায়নি।')
              : null}
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={textId} className="text-sm font-medium">
            {content('Comment', 'কমেন্ট')}
          </label>
          <textarea
            id={textId}
            rows={4}
            value={text}
            placeholder={content('e.g. bKash e 500 taka pathan, offer ache', 'যেমন: বিকাশে ৫০০ টাকা পাঠান, অফার আছে')}
            aria-invalid={textError ? true : undefined}
            aria-describedby={`${textId}-hint`}
            onChange={(event) => setText(event.target.value)}
            className="w-full rounded-2xl border border-input bg-transparent px-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30"
          />
          <span id={`${textId}-hint`} className="flex justify-between gap-2 text-xs text-muted-foreground">
            <span className="text-destructive">{textError}</span>
            <span data-testid="text-count" className="tabular-nums">
              {formatCount(length, language)}/{formatCount(PLAYGROUND_TEXT_MAX, language)}
            </span>
          </span>
        </div>
        <ChoiceGroup<CommentPlatform>
          legend={content('Platform', 'প্ল্যাটফর্ম')}
          options={[
            { value: 'FACEBOOK', label: 'Facebook' },
            { value: 'INSTAGRAM', label: 'Instagram' },
          ]}
          value={platform}
          onChange={setPlatform}
        />
        {test.isError ? (
          <MetaNotice tone="error" kind="playground-error" network={test.error.isNetwork}>
            {playgroundErrorMessage(test.error, content, language)}
          </MetaNotice>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="mr-auto text-xs text-pretty text-muted-foreground">
            {content('Nothing is posted to Facebook or Instagram.', 'ফেসবুক বা ইনস্টাগ্রামে কিছু পোস্ট হয় না।')}
          </p>
          <Button type="submit" className="h-10 px-5" disabled={test.isPending || noneLeft} aria-busy={test.isPending || undefined}>
            {test.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <FlaskConical aria-hidden />}
            {test.isPending ? content('Testing…', 'টেস্ট হচ্ছে…') : content('Test', 'টেস্ট করুন')}
          </Button>
        </div>
      </form>
      <div aria-live="polite">{test.data ? <PlaygroundResultCard result={test.data} /> : null}</div>
    </div>
  )
}

function PlaygroundResultCard({ result }: { result: PlaygroundResult }) {
  const { content, language } = useLanguage()
  const { ruleMatch, classification, decision } = result
  const hint = reviewHint(decision, content)
  return (
    <section data-testid="playground-result" className="flex flex-col gap-4 rounded-3xl border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{content('Result', 'ফলাফল')}</h2>
        <span data-testid="result-latency" className="text-xs text-muted-foreground tabular-nums">
          {content(`Checked in ${formatCount(result.latencyMs, language)} ms`, `${formatCount(result.latencyMs, language)} মিলিসেকেন্ডে যাচাই হয়েছে`)}
        </span>
      </div>

      {ruleMatch ? (
        <div data-testid="result-rule" className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">{content('Matched one of your rules (the AI was not asked):', 'আপনার একটি নিয়মের সাথে মিলেছে (AI-কে জিজ্ঞাসা করা হয়নি):')}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline" className="rounded-full">
              {ruleKindLabel(ruleMatch.kind, content)}
            </Badge>
            <span className="font-medium break-all">“{ruleMatch.value}”</span>
          </p>
        </div>
      ) : classification ? (
        <div data-testid="result-ai" className="flex flex-col gap-2">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline" className="rounded-full">
              {categoryLabel(classification.category, content)}
            </Badge>
            <span data-testid="result-confidence" className="text-muted-foreground tabular-nums">
              {content(
                `${formatCount(Math.round(classification.confidence * 100), language)}% confident`,
                `${formatCount(Math.round(classification.confidence * 100), language)}% নিশ্চিত`,
              )}
            </span>
          </p>
          <p className="text-sm text-pretty text-muted-foreground">{classification.reasoning}</p>
        </div>
      ) : null}

      <div data-testid="result-decision" className="flex flex-col gap-0.5 rounded-2xl bg-muted px-4 py-3">
        <p className="text-sm font-medium">{decisionLine(decision, content)}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>

      {decision.reply ? (
        <div data-testid="result-reply" className="flex flex-col gap-1.5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <MessageSquareReply className="size-4 shrink-0" aria-hidden />
            {decision.reply.language === 'bn'
              ? content('Auto-reply it would post (Bangla)', 'যে অটো-রিপ্লাই পোস্ট হতো (বাংলা)')
              : content('Auto-reply it would post (English)', 'যে অটো-রিপ্লাই পোস্ট হতো (ইংরেজি)')}
          </p>
          <p className="rounded-2xl border px-4 py-2.5 text-sm text-pretty">{decision.reply.text}</p>
        </div>
      ) : null}
    </section>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, LoaderCircle, RotateCw, Sparkles } from 'lucide-react'
import { useId, useState } from 'react'
import { MetaNotice } from '@/components/meta/meta-notice'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import { toApiError, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import {
  AI_CONTEXT_LEVELS,
  aiContextLevelMutationKey,
  aiContextLevelSaveErrorMessage,
  DEFAULT_AI_CONTEXT_LEVEL,
  isAiContextLevel,
  moderationPolicyLoadErrorMessage,
  moderationPolicyQueryKey,
  moderationPolicyQueryOptions,
  policyFromUpdate,
  updateAiContextLevel,
  type AiContextLevel,
  type ModerationPolicy,
  type ModerationPolicyUpdate,
} from '@/lib/moderation-policy'
import { cn } from '@/lib/utils'

/** D8 option copy: label + one-line pro/con (en + bn). */
function optionCopy(level: AiContextLevel, content: ContentFn): { label: string; detail: string } {
  switch (level) {
    case 'comment_only':
      return {
        label: content('Comment only', 'শুধু কমেন্ট'),
        detail: content(
          'Pro: sends the least data. Con: the AI reads only the comment text, so it can miss context.',
          'সুবিধা: সবচেয়ে কম তথ্য পাঠানো হয়। অসুবিধা: AI শুধু কমেন্টের লেখা পড়ে, তাই প্রসঙ্গ বুঝতে ভুল হতে পারে।',
        ),
      }
    case 'page_name':
      return {
        label: content('+ Page name', '+ পেজের নাম'),
        detail: content(
          'Pro: better at catching competitors who try to pull your buyers away. Con: your Page name is sent too.',
          'সুবিধা: আপনার ক্রেতা টেনে নিতে চাওয়া প্রতিযোগীদের আরও ভালোভাবে ধরে। অসুবিধা: আপনার পেজের নামও পাঠানো হয়।',
        ),
      }
    case 'post_caption':
      return {
        label: content('+ Post caption', '+ পোস্টের ক্যাপশন'),
        detail: content(
          'Pro: the most context, so the best filter. Con: your Page name and the post caption are sent too.',
          'সুবিধা: সবচেয়ে বেশি প্রসঙ্গ, তাই সবচেয়ে ভালো ফিল্টার। অসুবিধা: আপনার পেজের নাম ও পোস্টের ক্যাপশনও পাঠানো হয়।',
        ),
      }
  }
}

/**
 * C6 "AI analysis" card (M5-T15, D8): how much the AI sees per comment, stored as `aiContextLevel` in
 * the workspace moderation policy (D5). Every level counts 1 comment (PW-D1), so the card shows only
 * the data trade-off (credit costs dropped in PW-T8). Shown on `/pages` once the Pages list loaded (owner/admin;
 * impersonated sessions may change it, like the Page toggle). Save sends `{ aiContextLevel }` only
 * when the choice differs from the saved one, then writes the answer into the policy cache.
 */
export function AiAnalysisCard({ workspaceId }: { workspaceId: string }) {
  const { content } = useLanguage()
  const queryClient = useQueryClient()
  const policy = useQuery(moderationPolicyQueryOptions(workspaceId))
  const [choice, setChoice] = useState<AiContextLevel | null>(null)
  const save = useMutation<ModerationPolicyUpdate, ApiError, AiContextLevel>({
    mutationKey: aiContextLevelMutationKey(workspaceId),
    mutationFn: (level) => updateAiContextLevel(workspaceId, level),
    onSuccess: (update) => {
      queryClient.setQueryData<ModerationPolicy>(moderationPolicyQueryKey(workspaceId), policyFromUpdate(update))
      setChoice(null)
    },
  })
  const titleId = useId()

  const saved = policy.data && isAiContextLevel(policy.data.aiContextLevel) ? policy.data.aiContextLevel : null
  const selected = choice ?? saved
  const dirty = choice !== null && choice !== saved
  const pending = save.isPending

  const select = (level: AiContextLevel) => {
    setChoice(level)
    // A finished save's notice belongs to the previous choice.
    if (save.isSuccess || save.isError) save.reset()
  }

  return (
    <Card className="gap-4 rounded-3xl" data-testid="ai-analysis" role="region" aria-labelledby={titleId}>
      <CardHeader className="gap-1.5">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" aria-hidden />
          <h2 id={titleId} className="text-lg font-semibold">
            {content('AI analysis', 'AI বিশ্লেষণ')}
          </h2>
        </CardTitle>
        <CardDescription className="text-pretty">
          {content(
            'Choose what the AI sees when it checks a comment. Sending more gives a better filter but shares more of your data. Each comment counts once toward your monthly comment limit, whatever you choose. The commenter’s name and profile are never sent.',
            'কমেন্ট যাচাইয়ের সময় AI কী কী দেখবে তা বেছে নিন। বেশি তথ্য পাঠালে ফিল্টার আরও ভালো হয়, তবে আপনার বেশি তথ্য শেয়ার হয়। যেটাই বেছে নিন, প্রতিটি কমেন্ট আপনার মাসিক কমেন্ট সীমায় একবারই গোনা হয়। কমেন্টকারীর নাম ও প্রোফাইল কখনো পাঠানো হয় না।',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {policy.isPending ? (
          <div className="flex flex-col gap-3" aria-busy="true" data-testid="ai-analysis-loading">
            <Skeleton className="h-20 w-full rounded-2xl" />
            <Skeleton className="h-20 w-full rounded-2xl" />
            <Skeleton className="h-20 w-full rounded-2xl" />
          </div>
        ) : policy.isError ? (
          <MetaNotice
            tone="error"
            kind="ai-analysis-load"
            network={toApiError(policy.error).isNetwork}
            action={
              <Button
                variant="outline"
                size="sm"
                className="h-9 shrink-0 px-4"
                onClick={() => void policy.refetch()}
                disabled={policy.isFetching}
              >
                <RotateCw aria-hidden />
                {content('Try again', 'আবার চেষ্টা করুন')}
              </Button>
            }
          >
            {moderationPolicyLoadErrorMessage(toApiError(policy.error), content)}
          </MetaNotice>
        ) : (
          <>
            <fieldset className="flex flex-col gap-3" disabled={pending}>
              <legend className="sr-only">{content('What the AI sees', 'AI কী কী দেখবে')}</legend>
              {AI_CONTEXT_LEVELS.map((level) => (
                <AiContextOption
                  key={level}
                  level={level}
                  checked={selected === level}
                  isDefault={level === DEFAULT_AI_CONTEXT_LEVEL}
                  onSelect={select}
                />
              ))}
            </fieldset>
            <p className="text-xs text-pretty text-muted-foreground">
              {content(
                'Changes apply to comments that arrive after you save.',
                'সেভ করার পরে আসা কমেন্টে পরিবর্তন প্রযোজ্য হবে।',
              )}
            </p>
            {save.isError ? (
              <MetaNotice tone="error" kind="ai-analysis-save" network={save.error.isNetwork}>
                {aiContextLevelSaveErrorMessage(save.error, content)}
              </MetaNotice>
            ) : save.isSuccess && !dirty ? (
              <MetaNotice tone="success" kind="ai-analysis-saved">
                {content(
                  `Saved. New comments are analysed with “${optionCopy(save.data.aiContextLevel, content).label}”.`,
                  `সেভ হয়েছে। নতুন কমেন্ট “${optionCopy(save.data.aiContextLevel, content).label}” দিয়ে বিশ্লেষণ করা হবে।`,
                )}
              </MetaNotice>
            ) : null}
            <div className="flex justify-end">
              <Button
                className="h-10 px-5"
                disabled={!dirty || pending}
                aria-busy={pending || undefined}
                onClick={() => {
                  if (choice !== null && dirty) save.mutate(choice)
                }}
              >
                {pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Check aria-hidden />}
                {pending ? content('Saving…', 'সেভ হচ্ছে…') : content('Save', 'সেভ করুন')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function AiContextOption({
  level,
  checked,
  isDefault,
  onSelect,
}: {
  level: AiContextLevel
  checked: boolean
  isDefault: boolean
  onSelect: (level: AiContextLevel) => void
}) {
  const { content } = useLanguage()
  const id = useId()
  const { label, detail } = optionCopy(level, content)
  return (
    <label
      htmlFor={`${id}-input`}
      data-level={level}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition-colors',
        'hover:bg-muted/60 has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50',
        'has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-70',
        checked ? 'border-primary bg-primary/5' : 'border-border',
      )}
    >
      <input
        id={`${id}-input`}
        type="radio"
        name="ai-context-level"
        value={level}
        checked={checked}
        onChange={() => onSelect(level)}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-detail`}
        className="mt-1 size-4 shrink-0 accent-primary"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-2">
          <span id={`${id}-label`} className="font-medium">
            {label}
          </span>
          {isDefault ? (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              {content('Default', 'ডিফল্ট')}
            </span>
          ) : null}
        </span>
        <span id={`${id}-detail`} className="text-sm text-pretty text-muted-foreground">
          {detail}
        </span>
      </span>
    </label>
  )
}

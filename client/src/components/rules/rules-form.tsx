import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useBlocker } from '@tanstack/react-router'
import { Ban, Check, CheckCircle2, Gauge, LoaderCircle, Lock, type LucideIcon } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { ChipEditor, ChoiceGroup } from '@/components/rules/rule-controls'
import { MetaNotice } from '@/components/meta/meta-notice'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useLanguage } from '@/hooks/use-language'
import type { ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import { MODERATION_CATEGORIES } from '@/lib/comments-feed'
import { categoryLabel, formatCount } from '@/lib/dashboard-summary'
import {
  AUTO_REPLY_TEXT_MAX_CHARS,
  MAX_ALLOWED_DOMAINS,
  MAX_BLOCKED_KEYWORDS,
  MAX_KEYWORD_CHARS,
  MIN_CONFIDENCE_THRESHOLD,
  missingReplyTexts,
  moderationPolicyQueryKey,
  normalizeAllowedDomain,
  normalizeKeyword,
  policyDraft,
  policyFromUpdate,
  policyMutationKey,
  policyPatch,
  policySaveErrorMessage,
  updatePolicy,
  type CategoryDraft,
  type ModerationCategory,
  type ModerationMode,
  type ModerationPolicy,
  type ModerationPolicyUpdate,
  type PolicyAction,
  type PolicyDraft,
  type PolicyPatch,
  type RuleAction,
  type RuleKind,
  type StaticRules,
} from '@/lib/moderation-policy'

/** Carry-over (planner reading 7): what each category means + a made-up example, as static copy. */
function categoryCopy(category: ModerationCategory, content: ContentFn): { description: string; example: string } {
  switch (category) {
    case 'SAFE_INQUIRY':
      return {
        description: content('Normal questions about price, size, stock or delivery.', 'দাম, সাইজ, স্টক বা ডেলিভারি নিয়ে সাধারণ প্রশ্ন।'),
        example: content('Price koto? Dhaka te delivery hobe?', 'দাম কত? ঢাকায় ডেলিভারি হবে?'),
      }
    case 'COMPETITOR_POACH':
      return {
        description: content('Other sellers trying to pull your buyers to their own page.', 'অন্য বিক্রেতা আপনার ক্রেতাদের নিজের পেজে টানতে চাইছে।'),
        example: content('Same dress 300 taka kom e amader page e paben', 'একই ড্রেস ৩০০ টাকা কমে আমাদের পেজে পাবেন'),
      }
    case 'SCAM_PHISHING':
      return {
        description: content('Fake prizes, bKash/Nagad payment tricks and suspicious links.', 'ভুয়া পুরস্কার, বিকাশ/নগদে টাকা চাওয়ার ফাঁদ ও সন্দেহজনক লিংক।'),
        example: content('Apni lucky winner! Gift nite bKash e 500 taka pathan', 'আপনি লাকি উইনার! গিফট নিতে বিকাশে ৫০০ টাকা পাঠান'),
      }
    case 'SPAM_IRRELEVANT':
      return {
        description: content('Ads, job offers and comments that have nothing to do with your post.', 'বিজ্ঞাপন, চাকরির অফার ও পোস্টের সঙ্গে সম্পর্কহীন কমেন্ট।'),
        example: content('Ghore bose income korun, details inbox e', 'ঘরে বসে আয় করুন, বিস্তারিত ইনবক্সে'),
      }
    case 'ABUSIVE_TOXIC':
      return {
        description: content('Insults, slurs and threats against you or other buyers.', 'আপনাকে বা অন্য ক্রেতাদের অপমান, গালি ও হুমকি।'),
        example: content('Faltu product, tora sob chor', 'ফালতু প্রোডাক্ট, তোরা সব চোর'),
      }
  }
}

const actionOptions = (content: ContentFn) =>
  [
    { value: 'NONE', label: content('Show', 'দেখান') },
    { value: 'HIDE', label: content('Hide', 'হাইড করুন') },
    { value: 'DELETE', label: content('Delete', 'ডিলিট করুন') },
  ] as const satisfies readonly { value: PolicyAction; label: string }[]

const ruleActionOptions = (content: ContentFn) =>
  [
    { value: 'HIDE', label: content('Hide', 'হাইড করুন') },
    { value: 'DELETE', label: content('Delete', 'ডিলিট করুন') },
  ] as const satisfies readonly { value: RuleAction; label: string }[]

/**
 * C7 `/rules` form (M6-T10; D2 b, D4, D5, D6, D14): mode + threshold, per-category action and auto-reply,
 * static blocklist. Edits live in a draft; Save PATCHes only the changed fields (`policyPatch`) and writes
 * the answer into the policy cache. While unsaved, leaving asks first (`useBlocker`: `window.confirm` for
 * in-app links, the browser prompt on reload/close).
 */
export function RulesForm({ workspaceId, policy }: { workspaceId: string; policy: ModerationPolicy }) {
  const { content, language } = useLanguage()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<PolicyDraft | null>(null)
  const [attempted, setAttempted] = useState(false)
  const save = useMutation<ModerationPolicyUpdate, ApiError, PolicyPatch>({
    mutationKey: policyMutationKey(workspaceId),
    mutationFn: (patch) => updatePolicy(workspaceId, patch),
    onSuccess: (update) => {
      queryClient.setQueryData<ModerationPolicy>(moderationPolicyQueryKey(workspaceId), policyFromUpdate(update))
      setDraft(null)
      setAttempted(false)
    },
  })

  const current = draft ?? policyDraft(policy)
  const patch = draft ? policyPatch(policy, draft) : null
  const dirty = patch !== null
  const missing = attempted ? missingReplyTexts(current) : []

  useBlocker({
    shouldBlockFn: () =>
      !window.confirm(content('You have unsaved changes. Leave without saving?', 'কিছু পরিবর্তন সেভ করা হয়নি। সেভ না করেই চলে যাবেন?')),
    disabled: !dirty,
    enableBeforeUnload: dirty,
  })

  const edit = (change: (draft: PolicyDraft) => PolicyDraft) => {
    setDraft(change(current))
    if (save.isSuccess || save.isError) save.reset()
  }
  const editCategory = (category: ModerationCategory, change: Partial<CategoryDraft>) =>
    edit((d) => ({ ...d, categories: { ...d.categories, [category]: { ...d.categories[category], ...change } } }))
  const editRules = (change: Partial<StaticRules>) => edit((d) => ({ ...d, rules: { ...d.rules, ...change } }))
  const editAction = (kind: RuleKind, action: RuleAction) => editRules({ actions: { ...current.rules.actions, [kind]: action } })

  const addKeyword = (raw: string): string | null => {
    const keyword = normalizeKeyword(raw)
    if (!keyword) return null
    const list = current.rules.blockedKeywords
    if (Array.from(keyword).length > MAX_KEYWORD_CHARS) {
      return content(
        `Keep a keyword to ${MAX_KEYWORD_CHARS} characters or fewer.`,
        `কিওয়ার্ড ${formatCount(MAX_KEYWORD_CHARS, language)} অক্ষরের মধ্যে রাখুন।`,
      )
    }
    if (list.includes(keyword)) return content('This keyword is already in the list.', 'এই কিওয়ার্ডটি আগেই তালিকায় আছে।')
    if (list.length >= MAX_BLOCKED_KEYWORDS) {
      return content(
        `You can block up to ${MAX_BLOCKED_KEYWORDS} keywords.`,
        `সর্বোচ্চ ${formatCount(MAX_BLOCKED_KEYWORDS, language)}টি কিওয়ার্ড ব্লক করা যায়।`,
      )
    }
    editRules({ blockedKeywords: [...list, keyword] })
    return null
  }

  const addDomain = (raw: string): string | null => {
    if (!raw.trim()) return null
    const domain = normalizeAllowedDomain(raw)
    const list = current.rules.allowedDomains
    if (!domain) return content('Write a domain name like myshop.com.', 'myshop.com এর মতো করে ডোমেইন নাম লিখুন।')
    if (list.includes(domain)) return content('This domain is already in the list.', 'এই ডোমেইনটি আগেই তালিকায় আছে।')
    if (list.length >= MAX_ALLOWED_DOMAINS) {
      return content(
        `You can allow up to ${MAX_ALLOWED_DOMAINS} domains.`,
        `সর্বোচ্চ ${formatCount(MAX_ALLOWED_DOMAINS, language)}টি ডোমেইন অনুমতি দেওয়া যায়।`,
      )
    }
    editRules({ allowedDomains: [...list, domain] })
    return null
  }

  const submit = () => {
    if (missingReplyTexts(current).length > 0) {
      setAttempted(true)
      return
    }
    if (patch) save.mutate(patch)
  }

  const discard = () => {
    setDraft(null)
    setAttempted(false)
    save.reset()
  }

  const percent = Math.round(current.confidenceThreshold * 100)
  const plansLink = (
    <Link to="/plans" className="font-medium text-primary underline-offset-4 hover:underline">
      {content('See plans', 'প্ল্যান দেখুন')}
    </Link>
  )

  return (
    <div className="flex flex-col gap-6">
      <Section icon={Gauge} title={content('How comments are handled', 'কমেন্ট কীভাবে সামলানো হবে')} testId="rules-general">
        <ChoiceGroup<ModerationMode>
          legend={content('Mode', 'মোড')}
          options={[
            { value: 'AUTO', label: content('Auto', 'অটো') },
            { value: 'REVIEW', label: content('Review', 'রিভিউ') },
          ]}
          value={current.mode}
          onChange={(mode) => edit((d) => ({ ...d, mode }))}
          hint={
            current.mode === 'AUTO'
              ? content(
                  'The actions below run by themselves. Comments the AI isn’t sure about wait in Needs review.',
                  'নিচের অ্যাকশনগুলো নিজে থেকেই চলবে। যেসব কমেন্ট নিয়ে AI নিশ্চিত নয়, সেগুলো রিভিউ দরকার তালিকায় থাকবে।',
                )
              : content(
                  'Nothing is hidden, deleted or replied to by itself. Flagged comments wait for you in Comments.',
                  'নিজে থেকে কিছু হাইড, ডিলিট বা উত্তর দেওয়া হবে না। চিহ্নিত কমেন্টগুলো কমেন্ট পেজে আপনার জন্য অপেক্ষা করবে।',
                )
          }
        />
        <ThresholdInput
          percent={percent}
          onChange={(value) => edit((d) => ({ ...d, confidenceThreshold: value / 100 }))}
        />
      </Section>

      {MODERATION_CATEGORIES.map((category) => (
        <CategoryCard
          key={category}
          category={category}
          rule={current.categories[category]}
          autoReplyAvailable={policy.autoReplyAvailable}
          missingTexts={missing.includes(category)}
          plansLink={plansLink}
          onChange={(change) => editCategory(category, change)}
        />
      ))}

      <Section icon={Ban} title={content('Blocklist', 'ব্লকলিস্ট')} testId="rules-blocklist">
        <p className="-mt-2 text-sm text-pretty text-muted-foreground">
          {content(
            'Blocked comments are handled before the AI looks at them.',
            'ব্লক করা কমেন্ট AI দেখার আগেই সামলানো হয়।',
          )}
        </p>

        <div className="flex flex-col gap-3" data-testid="rules-keywords">
          <h3 className="font-medium">{content('Keywords', 'কিওয়ার্ড')}</h3>
          <p className="text-sm text-pretty text-muted-foreground">
            {content(
              'A comment containing any of these words or phrases is blocked. Upper/lower case doesn’t matter; Bangla and Banglish spellings are separate keywords.',
              'এই শব্দ বা বাক্যাংশের যেকোনোটি থাকলে কমেন্টটি ব্লক হবে। ছোট/বড় হাতের অক্ষরে পার্থক্য নেই; বাংলা ও বাংলিশ বানান আলাদা কিওয়ার্ড।',
            )}
          </p>
          <ChipEditor
            items={current.rules.blockedKeywords}
            listLabel={content('Blocked keywords', 'ব্লক করা কিওয়ার্ড')}
            inputLabel={content('New keyword', 'নতুন কিওয়ার্ড')}
            placeholder={content('e.g. inbox e price', 'যেমন: ইনবক্সে দাম')}
            empty={content('No keywords yet.', 'এখনো কোনো কিওয়ার্ড নেই।')}
            addable={policy.keywordRulesAvailable}
            onAdd={addKeyword}
            onRemove={(item) => editRules({ blockedKeywords: current.rules.blockedKeywords.filter((k) => k !== item) })}
          />
          {policy.keywordRulesAvailable ? null : (
            <PlanNote testId="keyword-plan-note">
              {content('Custom keywords are on the Growth and Pro plans.', 'কাস্টম কিওয়ার্ড গ্রোথ ও প্রো প্ল্যানে আছে।')} {plansLink}
            </PlanNote>
          )}
          <ChoiceGroup<RuleAction>
            legend={content('When a keyword matches', 'কিওয়ার্ড মিললে')}
            options={ruleActionOptions(content)}
            value={current.rules.actions.keyword}
            onChange={(action) => editAction('keyword', action)}
          />
        </div>

        <div className="flex flex-col gap-3 border-t pt-5" data-testid="rules-links">
          <SwitchRow
            label={content('Block links', 'লিংক ব্লক করুন')}
            description={content(
              'Blocks comments with a web link. facebook.com, instagram.com and m.me are always allowed.',
              'ওয়েব লিংকসহ কমেন্ট ব্লক করে। facebook.com, instagram.com ও m.me সবসময় অনুমোদিত।',
            )}
            checked={current.rules.blockUrls}
            disabled={!policy.urlPhoneRulesAvailable && !current.rules.blockUrls}
            onChange={(blockUrls) => editRules({ blockUrls })}
          />
          <h4 className="text-sm font-medium">{content('Your own domains (always allowed)', 'আপনার নিজের ডোমেইন (সবসময় অনুমোদিত)')}</h4>
          <ChipEditor
            items={current.rules.allowedDomains}
            listLabel={content('Allowed domains', 'অনুমোদিত ডোমেইন')}
            inputLabel={content('New domain', 'নতুন ডোমেইন')}
            placeholder="myshop.com"
            empty={content('No domains yet.', 'এখনো কোনো ডোমেইন নেই।')}
            addable
            onAdd={addDomain}
            onRemove={(item) => editRules({ allowedDomains: current.rules.allowedDomains.filter((d) => d !== item) })}
          />
          <ChoiceGroup<RuleAction>
            legend={content('When a link matches', 'লিংক মিললে')}
            options={ruleActionOptions(content)}
            value={current.rules.actions.url}
            onChange={(action) => editAction('url', action)}
          />
        </div>

        <div className="flex flex-col gap-3 border-t pt-5" data-testid="rules-phones">
          <SwitchRow
            label={content('Block phone numbers', 'ফোন নম্বর ব্লক করুন')}
            description={content(
              'Blocks comments with a Bangladeshi mobile number (01…, +880…, with dashes or Bangla digits). Buyers sometimes share their own number to order.',
              'বাংলাদেশি মোবাইল নম্বরসহ কমেন্ট ব্লক করে (০১…, +৮৮০…, ড্যাশ বা বাংলা অঙ্কসহ)। অনেক ক্রেতা অর্ডার দিতে নিজের নম্বর দেন।',
            )}
            checked={current.rules.blockPhoneNumbers}
            disabled={!policy.urlPhoneRulesAvailable && !current.rules.blockPhoneNumbers}
            onChange={(blockPhoneNumbers) => editRules({ blockPhoneNumbers })}
          />
          <ChoiceGroup<RuleAction>
            legend={content('When a phone number matches', 'ফোন নম্বর মিললে')}
            options={ruleActionOptions(content)}
            value={current.rules.actions.phone}
            onChange={(action) => editAction('phone', action)}
          />
        </div>

        {policy.urlPhoneRulesAvailable ? null : (
          <PlanNote testId="url-phone-plan-note">
            {content('Link and phone number blocking needs an active plan.', 'লিংক ও ফোন নম্বর ব্লক করতে একটি চালু প্ল্যান লাগবে।')} {plansLink}
          </PlanNote>
        )}
      </Section>

      <div className="sticky bottom-20 z-30 flex flex-col gap-3 rounded-3xl border bg-card p-4 shadow-sm md:bottom-4">
        <p role="status" data-testid="rules-notice" className="empty:hidden">
          {save.isSuccess && !dirty ? (
            <span className="flex items-center gap-2 rounded-2xl bg-primary/10 px-4 py-2 text-sm text-primary">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
              {content('Rules saved. New comments follow them.', 'নিয়ম সেভ হয়েছে। নতুন কমেন্টে এগুলো প্রযোজ্য হবে।')}
            </span>
          ) : null}
        </p>
        {missing.length > 0 ? (
          <MetaNotice tone="error" kind="rules-missing-replies">
            {content(
              'Write both an English and a Bangla reply for every auto-reply you switch on.',
              'যে অটো-রিপ্লাই চালু করবেন তার জন্য ইংরেজি ও বাংলা দুটো উত্তরই লিখুন।',
            )}
          </MetaNotice>
        ) : save.isError ? (
          <MetaNotice tone="error" kind="rules-save" network={save.error.isNetwork}>
            {policySaveErrorMessage(save.error, content, language)}
          </MetaNotice>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty ? (
            <span className="mr-auto text-sm text-muted-foreground">{content('Unsaved changes', 'পরিবর্তন সেভ হয়নি')}</span>
          ) : null}
          <Button variant="ghost" className="h-10 px-4" disabled={!dirty || save.isPending} onClick={discard}>
            {content('Discard', 'বাতিল করুন')}
          </Button>
          <Button className="h-10 px-5" disabled={!dirty || save.isPending} aria-busy={save.isPending || undefined} onClick={submit}>
            {save.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Check aria-hidden />}
            {save.isPending ? content('Saving…', 'সেভ হচ্ছে…') : content('Save', 'সেভ করুন')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Section({ icon: Icon, title, testId, children }: { icon: LucideIcon; title: string; testId: string; children: ReactNode }) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} data-testid={testId} className="flex flex-col gap-5 rounded-3xl border bg-card p-5 sm:p-6">
      <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold">
        <Icon className="size-4 text-primary" aria-hidden />
        {title}
      </h2>
      {children}
    </section>
  )
}

function ThresholdInput({ percent, onChange }: { percent: number; onChange: (percent: number) => void }) {
  const { content, language } = useLanguage()
  const id = useId()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {content('Confidence needed to act', 'অ্যাকশনের জন্য প্রয়োজনীয় নিশ্চয়তা')}
        </label>
        <output htmlFor={id} data-testid="threshold-value" className="rounded-full bg-muted px-3 py-0.5 text-sm font-medium tabular-nums">
          {formatCount(percent, language)}%
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={MIN_CONFIDENCE_THRESHOLD * 100}
        max={100}
        step={1}
        value={percent}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-primary"
      />
      <p className="text-xs text-pretty text-muted-foreground">
        {content(
          'The AI acts only when it is at least this sure. Below it, the comment waits in Needs review.',
          'AI অন্তত এতটা নিশ্চিত হলে তবেই অ্যাকশন নেয়। এর কম হলে কমেন্টটি রিভিউ দরকার তালিকায় থাকে।',
        )}
      </p>
    </div>
  )
}

function CategoryCard({
  category,
  rule,
  autoReplyAvailable,
  missingTexts,
  plansLink,
  onChange,
}: {
  category: ModerationCategory
  rule: CategoryDraft
  autoReplyAvailable: boolean
  missingTexts: boolean
  plansLink: ReactNode
  onChange: (change: Partial<CategoryDraft>) => void
}) {
  const { content } = useLanguage()
  const titleId = useId()
  const { description, example } = categoryCopy(category, content)
  return (
    <section aria-labelledby={titleId} data-testid={`category-${category}`} className="flex flex-col gap-4 rounded-3xl border bg-card p-5 sm:p-6">
      <div className="flex flex-col gap-1.5">
        <h2 id={titleId} className="text-lg font-semibold">
          {categoryLabel(category, content)}
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">{description}</p>
        <p className="text-sm">
          <span className="text-muted-foreground">{content('Example: ', 'উদাহরণ: ')}</span>
          <q className="italic">{example}</q>
        </p>
      </div>
      <ChoiceGroup<PolicyAction>
        legend={content('Action', 'অ্যাকশন')}
        options={actionOptions(content)}
        value={rule.action}
        onChange={(action) => onChange({ action })}
      />
      <div className="flex flex-col gap-3 border-t pt-4">
        <SwitchRow
          label={content('Auto-reply', 'অটো-রিপ্লাই')}
          description={content(
            'Replies once in the comment’s language (English or Bangla).',
            'কমেন্টের ভাষায় (ইংরেজি বা বাংলা) একবার উত্তর দেয়।',
          )}
          checked={rule.autoReply}
          disabled={!autoReplyAvailable && !rule.autoReply}
          onChange={(autoReply) => onChange({ autoReply })}
        />
        {autoReplyAvailable ? null : (
          <PlanNote testId={`auto-reply-plan-note-${category}`}>
            {content('Auto-replies are on the Growth and Pro plans.', 'অটো-রিপ্লাই গ্রোথ ও প্রো প্ল্যানে আছে।')} {plansLink}
          </PlanNote>
        )}
        {rule.autoReply ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <ReplyText
              label={content('Reply in English', 'ইংরেজিতে উত্তর')}
              value={rule.replyEn}
              missing={missingTexts && !rule.replyEn.trim()}
              onChange={(replyEn) => onChange({ replyEn })}
            />
            <ReplyText
              label={content('Reply in Bangla', 'বাংলায় উত্তর')}
              value={rule.replyBn}
              missing={missingTexts && !rule.replyBn.trim()}
              onChange={(replyBn) => onChange({ replyBn })}
            />
          </div>
        ) : null}
      </div>
    </section>
  )
}

function ReplyText({ label, value, missing, onChange }: { label: string; value: string; missing: boolean; onChange: (value: string) => void }) {
  const { content, language } = useLanguage()
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        rows={3}
        value={value}
        maxLength={AUTO_REPLY_TEXT_MAX_CHARS}
        aria-invalid={missing || undefined}
        aria-describedby={missing ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-input bg-transparent px-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30"
      />
      <span className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span id={`${id}-error`} className="text-destructive">
          {missing ? content('Write this reply too.', 'এই উত্তরটিও লিখুন।') : null}
        </span>
        <span className="tabular-nums">
          {formatCount(value.length, language)}/{formatCount(AUTO_REPLY_TEXT_MAX_CHARS, language)}
        </span>
      </span>
    </div>
  )
}

function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id} className="font-medium">
          {label}
        </Label>
        <p id={`${id}-description`} className="text-sm text-pretty text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} aria-describedby={`${id}-description`} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  )
}

function PlanNote({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <p data-testid={testId} className="flex items-start gap-2 rounded-2xl bg-muted px-4 py-2.5 text-sm text-pretty text-muted-foreground">
      <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bell, Check, ExternalLink, LoaderCircle, Mail, MessageCircle, RotateCw, Send, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { DashboardError } from '@/components/dashboard/dashboard-charts'
import { MetaNotice } from '@/components/meta/meta-notice'
import { PlanNote, Section, SwitchRow } from '@/components/rules/rules-form'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import {
  alertDraft,
  alertDraftErrors,
  alertErrorMessage,
  alertLoadErrorMessage,
  alertSettingsKey,
  alertSettingsPatch,
  alertSettingsQueryOptions,
  channelLabel,
  createTelegramLink,
  deliveryErrorText,
  MAX_EMAIL_RECIPIENTS,
  MAX_SPIKE_THRESHOLD,
  MAX_TELEGRAM_CHATS,
  MIN_SPIKE_THRESHOLD,
  removeTelegramChat,
  sendTestAlert,
  updateAlertSettings,
  type AlertChannel,
  type AlertDraft,
  type AlertSettings,
  type AlertSettingsPatch,
  type TelegramLink,
  type TestAlertResult,
} from '@/lib/alerts'
import { toApiError, type ApiError } from '@/lib/api'
import { formatCommentTime } from '@/lib/comments-feed'
import { formatCount } from '@/lib/dashboard-summary'
import { roleLabel, teamQueryOptions, teamRootKey, type TeamMember } from '@/lib/team'
import { cn } from '@/lib/utils'

/**
 * C12 `/settings/alerts` (M7-T15). Owner/admin edit (an impersonated session too, D2) and send tests (M7-D20);
 * moderators read. The viewer's role and the recipient tick list come from the team list (`GET …/team`).
 */
export function AlertSettingsScreen({ workspaceId, userId, impersonated }: { workspaceId: string; userId: string; impersonated: boolean }) {
  const { content } = useLanguage()
  const settings = useQuery(alertSettingsQueryOptions(workspaceId))
  const team = useQuery(teamQueryOptions(workspaceId))

  const failed = (settings.isError && !settings.data) || (team.isError && !team.data)
  if (failed)
    return (
      <DashboardError
        title={content('Couldn’t load your alert settings', 'আপনার অ্যালার্ট সেটিংস লোড করা যায়নি')}
        message={alertLoadErrorMessage(toApiError(settings.error ?? team.error), content)}
        onRetry={() => {
          if (settings.isError) void settings.refetch()
          if (team.isError) void team.refetch()
        }}
        retrying={settings.isFetching || team.isFetching}
      />
    )
  if (!settings.data || !team.data)
    return (
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} data-testid="alerts-skeleton" className="h-32 w-full rounded-3xl" />
        ))}
      </div>
    )

  const viewer = team.data.members.find((member) => member.userId === userId)?.role ?? null
  return (
    <AlertSettingsForm
      workspaceId={workspaceId}
      settings={settings.data}
      members={team.data.members}
      canEdit={viewer === 'owner' || viewer === 'admin'}
      impersonated={impersonated}
    />
  )
}

function AlertSettingsForm({
  workspaceId,
  settings,
  members,
  canEdit,
  impersonated,
}: {
  workspaceId: string
  settings: AlertSettings
  members: TeamMember[]
  canEdit: boolean
  impersonated: boolean
}) {
  const { content, language } = useLanguage()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<AlertDraft | null>(null)
  const key = alertSettingsKey(workspaceId)
  const refresh = () => queryClient.invalidateQueries({ queryKey: key })

  const save = useMutation<AlertSettings, ApiError, AlertSettingsPatch>({
    mutationFn: (patch) => updateAlertSettings(workspaceId, patch),
    onSuccess: (answer) => {
      queryClient.setQueryData<AlertSettings>(key, answer)
      setDraft(null)
    },
    onError: (error) => {
      // The plan or the team changed under the form: reload what the screen shows.
      if (error.code === 'PLAN_FEATURE_UNAVAILABLE') void refresh()
      if (error.code === 'ALERT_RECIPIENT_NOT_MEMBER') void queryClient.invalidateQueries({ queryKey: teamRootKey(workspaceId) })
    },
  })
  const link = useMutation<TelegramLink, ApiError>({
    mutationFn: () => createTelegramLink(workspaceId),
    onError: (error) => {
      if (error.code === 'PLAN_FEATURE_UNAVAILABLE' || error.code === 'TELEGRAM_CHAT_LIMIT') void refresh()
    },
  })
  const remove = useMutation<void, ApiError, string>({
    mutationFn: (chatId) => removeTelegramChat(workspaceId, chatId),
    onSuccess: (_, chatId) =>
      queryClient.setQueryData<AlertSettings>(key, (old) =>
        old ? { ...old, telegram: { ...old.telegram, chats: old.telegram.chats.filter((chat) => chat.id !== chatId) } } : old,
      ),
    onError: (error) => {
      if (error.status === 404) void refresh()
    },
  })
  const test = useMutation<TestAlertResult, ApiError>({ mutationFn: () => sendTestAlert(workspaceId) })

  const current = draft ?? alertDraft(settings)
  const errors = draft ? alertDraftErrors(draft, content, language) : {}
  const invalid = Object.keys(errors).length > 0
  const patch = draft && !invalid ? alertSettingsPatch(settings, draft) : null
  const dirty = draft !== null && (invalid || patch !== null)
  const disabled = !canEdit || save.isPending

  const edit = (change: Partial<AlertDraft>) => {
    setDraft({ ...current, ...change })
    if (save.isSuccess || save.isError) save.reset()
  }
  const toggleRecipient = (memberId: string, on: boolean) =>
    edit({ recipientIds: on ? [...current.recipientIds, memberId] : current.recipientIds.filter((id) => id !== memberId) })

  const thresholdId = useId()
  const lastAlert = (channel: AlertChannel) => settings.lastAlerts.find((alert) => alert.channel === channel)
  const chats = settings.telegram.chats
  const plansLink = (
    <Link to="/plans" className="font-medium text-primary underline-offset-4 hover:underline">
      {content('See plans', 'প্ল্যান দেখুন')}
    </Link>
  )

  return (
    <div className="flex flex-col gap-6">
      {!canEdit ? (
        <MetaNotice tone="info" kind="alerts-read-only">
          {content(
            'Only the owner and admins can change alert settings. You can see them here.',
            'শুধু মালিক ও অ্যাডমিন অ্যালার্ট সেটিংস বদলাতে পারেন। আপনি এখানে দেখতে পারবেন।',
          )}
        </MetaNotice>
      ) : impersonated ? (
        <MetaNotice tone="info" kind="alerts-impersonated">
          {content(
            'You’re signed in as this client by support. Changes you save here apply to the client’s workspace.',
            'আপনি সাপোর্ট থেকে এই ক্লায়েন্ট হিসেবে লগ ইন করেছেন। এখানে সেভ করা পরিবর্তন ক্লায়েন্টের ওয়ার্কস্পেসে প্রযোজ্য হবে।',
          )}
        </MetaNotice>
      ) : null}

      <Section icon={Bell} title={content('Scam-spike alerts', 'স্ক্যাম-স্পাইক অ্যালার্ট')} testId="alerts-threshold">
        <p className="text-sm text-pretty text-muted-foreground">
          {content(
            'We alert you when scam comments pile up within 60 minutes. After an alert, the next one waits at least 60 minutes. Times are Bangladesh time.',
            '৬০ মিনিটের মধ্যে অনেক স্ক্যাম কমেন্ট এলে আমরা আপনাকে জানাই। একটি অ্যালার্টের পরে পরেরটি অন্তত ৬০ মিনিট অপেক্ষা করে। সময় বাংলাদেশ সময় অনুযায়ী।',
          )}
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor={thresholdId}>{content('Alert after this many scam comments in 60 minutes', '৬০ মিনিটে এতগুলো স্ক্যাম কমেন্ট হলে অ্যালার্ট')}</Label>
          <Input
            id={thresholdId}
            type="number"
            inputMode="numeric"
            min={MIN_SPIKE_THRESHOLD}
            max={MAX_SPIKE_THRESHOLD}
            step={1}
            value={current.threshold}
            disabled={disabled}
            aria-invalid={errors.threshold ? true : undefined}
            aria-describedby={errors.threshold ? `${thresholdId}-error` : undefined}
            onChange={(event) => edit({ threshold: event.target.value })}
            className="h-10 w-32 px-4"
          />
          {errors.threshold ? (
            <p id={`${thresholdId}-error`} className="text-sm text-destructive">
              {errors.threshold}
            </p>
          ) : null}
        </div>
      </Section>

      <Section icon={Mail} title={content('Email', 'ইমেইল')} testId="alerts-email">
        <SwitchRow
          label={content('Email alerts', 'ইমেইল অ্যালার্ট')}
          description={content('Included in every plan. Sent to the people you choose below.', 'সব প্ল্যানে আছে। নিচে বেছে নেওয়া মানুষদের কাছে পাঠানো হয়।')}
          checked={current.emailEnabled}
          disabled={disabled}
          onChange={(emailEnabled) => edit({ emailEnabled })}
        />
        {current.emailEnabled ? (
          <fieldset className="flex flex-col gap-2" aria-describedby={errors.recipients ? 'alert-recipients-error' : undefined}>
            <legend className="mb-2 flex w-full items-center justify-between gap-3 text-sm font-medium">
              <span>{content('Who gets the email', 'কে ইমেইল পাবেন')}</span>
              <span data-testid="recipient-count" className="rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground tabular-nums">
                {`${formatCount(current.recipientIds.length, language)} / ${formatCount(MAX_EMAIL_RECIPIENTS, language)}`}
              </span>
            </legend>
            {members.map((member) => (
              <label
                key={member.memberId}
                data-recipient={member.memberId}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-2xl border p-3 text-sm transition-colors hover:bg-muted/60',
                  'has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-70 has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50',
                )}
              >
                <input
                  type="checkbox"
                  checked={current.recipientIds.includes(member.memberId)}
                  disabled={disabled}
                  onChange={(event) => toggleRecipient(member.memberId, event.target.checked)}
                  className="size-4 shrink-0 accent-primary"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{member.name}</span>
                  <span className="truncate text-muted-foreground">{member.email}</span>
                </span>
                <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{roleLabel(member.role, content)}</span>
              </label>
            ))}
            {errors.recipients ? (
              <p id="alert-recipients-error" className="text-sm text-destructive">
                {errors.recipients}
              </p>
            ) : null}
          </fieldset>
        ) : null}
        <LastAlert alert={lastAlert('EMAIL')} />
      </Section>

      <Section icon={Send} title={content('Telegram', 'টেলিগ্রাম')} testId="alerts-telegram">
        <SwitchRow
          label={content('Telegram alerts', 'টেলিগ্রাম অ্যালার্ট')}
          description={content(
            `Sent to every linked Telegram chat (up to ${MAX_TELEGRAM_CHATS}).`,
            `প্রতিটি যুক্ত টেলিগ্রাম চ্যাটে পাঠানো হয় (সর্বোচ্চ ${formatCount(MAX_TELEGRAM_CHATS, language)}টি)।`,
          )}
          checked={current.telegramEnabled}
          // Without the plan feature the switch can only be turned off (D12; saved settings stay when a plan drops).
          disabled={disabled || (!settings.telegram.available && !current.telegramEnabled)}
          onChange={(telegramEnabled) => edit({ telegramEnabled })}
        />
        {!settings.telegram.available ? (
          <PlanNote testId="telegram-plan-note">
            {content(
              'Telegram alerts are part of the Growth and Pro plans. Your plan sends email alerts only.',
              'টেলিগ্রাম অ্যালার্ট গ্রোথ ও প্রো প্ল্যানে আছে। আপনার প্ল্যানে শুধু ইমেইল অ্যালার্ট পাঠানো হয়।',
            )}{' '}
            {plansLink}
          </PlanNote>
        ) : !settings.telegram.configured ? (
          <PlanNote testId="telegram-not-configured">
            {content('Telegram alerts aren’t available right now. Try again later.', 'টেলিগ্রাম অ্যালার্ট এই মুহূর্তে পাওয়া যাচ্ছে না। পরে আবার চেষ্টা করুন।')}
          </PlanNote>
        ) : null}

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{content('Linked chats', 'যুক্ত চ্যাট')}</h3>
          {chats.length === 0 ? (
            <p className="text-sm text-muted-foreground">{content('No chat linked yet.', 'এখনো কোনো চ্যাট যুক্ত হয়নি।')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {chats.map((chat) => (
                <li key={chat.id} data-chat={chat.id} className="flex items-center justify-between gap-3 rounded-2xl border p-3 text-sm">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{chat.title}</span>
                    <span className="text-muted-foreground">
                      {chat.type === 'private' ? content('Private chat', 'ব্যক্তিগত চ্যাট') : content('Group', 'গ্রুপ')} ·{' '}
                      {content(`linked ${formatCommentTime(chat.linkedAt, language)}`, `যুক্ত ${formatCommentTime(chat.linkedAt, language)}`)}
                    </span>
                  </span>
                  {canEdit ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 px-4"
                      disabled={remove.isPending}
                      aria-label={content(`Remove ${chat.title}`, `${chat.title} সরান`)}
                      onClick={() => remove.mutate(chat.id)}
                    >
                      <Trash2 aria-hidden />
                      {content('Remove', 'সরান')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {remove.isError ? (
            <MetaNotice tone="error" kind="telegram-remove-error" network={remove.error.isNetwork}>
              {alertErrorMessage(remove.error, content, language)}
            </MetaNotice>
          ) : null}
        </div>

        {canEdit && settings.telegram.available && settings.telegram.configured ? (
          chats.length >= MAX_TELEGRAM_CHATS ? (
            <PlanNote testId="telegram-chat-limit">
              {content(
                `${MAX_TELEGRAM_CHATS} chats are linked, the most allowed. Remove one to link another.`,
                `${formatCount(MAX_TELEGRAM_CHATS, language)}টি চ্যাট যুক্ত আছে, এটাই সর্বোচ্চ। আরেকটি যুক্ত করতে একটি সরান।`,
              )}
            </PlanNote>
          ) : (
            <TelegramConnect link={link.data} pending={link.isPending} onConnect={() => link.mutate()} onRefresh={() => void refresh()} />
          )
        ) : null}
        {link.isError ? (
          <MetaNotice tone="error" kind="telegram-link-error" network={link.error.isNetwork}>
            {alertErrorMessage(link.error, content, language)}
          </MetaNotice>
        ) : null}
        <LastAlert alert={lastAlert('TELEGRAM')} />
      </Section>

      <Section icon={MessageCircle} title={content('WhatsApp', 'হোয়াটসঅ্যাপ')} testId="alerts-whatsapp">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-pretty text-muted-foreground">
            {content('WhatsApp alerts are on the way.', 'হোয়াটসঅ্যাপ অ্যালার্ট আসছে।')}
          </p>
          <span data-testid="whatsapp-soon" className="shrink-0 rounded-full border px-3 py-0.5 text-xs font-medium text-muted-foreground">
            {content('Coming soon', 'শিগগিরই আসছে')}
          </span>
        </div>
      </Section>

      {canEdit ? (
        <div className="flex flex-col gap-3">
          {save.isError ? (
            <MetaNotice tone="error" kind="alerts-save-error" network={save.error.isNetwork}>
              {alertErrorMessage(save.error, content, language)}
            </MetaNotice>
          ) : save.isSuccess && !draft ? (
            <MetaNotice tone="success" kind="alerts-saved">
              {content('Alert settings saved.', 'অ্যালার্ট সেটিংস সেভ হয়েছে।')}
            </MetaNotice>
          ) : null}
          <div className="flex justify-end gap-2">
            {draft ? (
              <Button variant="outline" className="h-10 px-5" disabled={save.isPending} onClick={() => setDraft(null)}>
                {content('Discard', 'বাদ দিন')}
              </Button>
            ) : null}
            <Button
              className="h-10 px-5"
              disabled={!patch || save.isPending}
              aria-busy={save.isPending || undefined}
              onClick={() => {
                if (patch) save.mutate(patch)
              }}
            >
              {save.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Check aria-hidden />}
              {save.isPending ? content('Saving…', 'সেভ হচ্ছে…') : content('Save', 'সেভ করুন')}
            </Button>
          </div>
        </div>
      ) : null}

      {canEdit ? (
        <Section icon={Send} title={content('Test alert', 'টেস্ট অ্যালার্ট')} testId="alerts-test">
          <p className="text-sm text-pretty text-muted-foreground">
            {dirty
              ? content('Save your changes first. A test uses your saved settings.', 'আগে পরিবর্তন সেভ করুন। টেস্ট আপনার সেভ করা সেটিংস ব্যবহার করে।')
              : content(
                  'Sends a test message to every channel that would get a real alert. Up to 5 an hour; it never counts as your last alert.',
                  'আসল অ্যালার্ট যেসব চ্যানেলে যেত সেখানে একটি টেস্ট মেসেজ পাঠায়। ঘণ্টায় সর্বোচ্চ ৫টি; এটি কখনো শেষ অ্যালার্ট হিসেবে গোনা হয় না।',
                )}
          </p>
          {test.isSuccess ? (
            <ul data-testid="test-results" className="flex flex-col gap-2">
              {test.data.deliveries.map((delivery) => (
                <li
                  key={delivery.channel}
                  data-channel={delivery.channel}
                  data-status={delivery.status}
                  className="flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm"
                >
                  <span className="font-medium">{`${channelLabel(delivery.channel, content)}:`}</span>{' '}
                  <span className={delivery.status === 'SENT' ? 'text-primary' : 'text-destructive'}>
                    {delivery.status === 'SENT'
                      ? content('sent', 'পাঠানো হয়েছে')
                      : content(
                          `failed, ${deliveryErrorText(delivery.errorKind, content)}`,
                          `ব্যর্থ, ${deliveryErrorText(delivery.errorKind, content)}`,
                        )}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {test.isError ? (
            <MetaNotice tone="error" kind="alerts-test-error" network={test.error.isNetwork}>
              {alertErrorMessage(test.error, content, language)}
            </MetaNotice>
          ) : null}
          <div className="flex justify-end">
            <Button variant="outline" className="h-10 px-5" disabled={dirty || test.isPending} onClick={() => test.mutate()}>
              {test.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Send aria-hidden />}
              {content('Send test alert', 'টেস্ট অ্যালার্ট পাঠান')}
            </Button>
          </div>
        </Section>
      ) : null}
    </div>
  )
}

function TelegramConnect({
  link,
  pending,
  onConnect,
  onRefresh,
}: {
  link: TelegramLink | undefined
  pending: boolean
  onConnect: () => void
  onRefresh: () => void
}) {
  const { content, language } = useLanguage()
  const anchor = cn(buttonVariants({ variant: 'outline' }), 'h-10 px-4')
  return (
    <div className="flex flex-col gap-3" data-testid="telegram-connect">
      {link ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-muted p-4 text-sm" data-testid="telegram-link">
          <p className="text-pretty">
            {content(
              'Open the link in Telegram and press Start. To alert a group, choose the group to add the bot to.',
              'লিংকটি টেলিগ্রামে খুলে Start চাপুন। কোনো গ্রুপে অ্যালার্ট পেতে বটটি যে গ্রুপে যোগ করবেন সেটি বেছে নিন।',
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={link.url} target="_blank" rel="noopener noreferrer" className={anchor}>
              <ExternalLink aria-hidden />
              {content('Open in Telegram', 'টেলিগ্রামে খুলুন')}
            </a>
            <a href={link.groupUrl} target="_blank" rel="noopener noreferrer" className={anchor}>
              <ExternalLink aria-hidden />
              {content('Add to a group', 'গ্রুপে যোগ করুন')}
            </a>
          </div>
          <p data-testid="telegram-link-expiry" className="text-muted-foreground">
            {content(
              `The link works once and expires at ${formatCommentTime(link.expiresAt, language)}.`,
              `লিংকটি একবারই কাজ করে, মেয়াদ শেষ হবে ${formatCommentTime(link.expiresAt, language)}-এ।`,
            )}
          </p>
          <Button variant="ghost" className="h-9 w-fit px-4" onClick={onRefresh}>
            <RotateCw aria-hidden />
            {content('I’ve linked it, refresh chats', 'যুক্ত করেছি, চ্যাট রিফ্রেশ করুন')}
          </Button>
        </div>
      ) : null}
      <Button className="h-10 w-fit px-5" disabled={pending} onClick={onConnect}>
        {pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Send aria-hidden />}
        {link ? content('Get a new link', 'নতুন লিংক নিন') : content('Connect Telegram', 'টেলিগ্রাম যুক্ত করুন')}
      </Button>
    </div>
  )
}

function LastAlert({ alert }: { alert: AlertSettings['lastAlerts'][number] | undefined }) {
  const { content, language } = useLanguage()
  const scams = (n: number) => `${formatCount(n, 'en')} scam comment${n === 1 ? '' : 's'}`
  return (
    <p data-testid="last-alert" className="border-t pt-4 text-sm text-muted-foreground">
      {!alert
        ? content('No alert sent yet.', 'এখনো কোনো অ্যালার্ট পাঠানো হয়নি।')
        : alert.status === 'SENT'
          ? content(
              `Last alert: ${formatCommentTime(alert.sentAt, language)} · sent · ${scams(alert.scamCount)}`,
              `শেষ অ্যালার্ট: ${formatCommentTime(alert.sentAt, language)} · পাঠানো হয়েছে · ${formatCount(alert.scamCount, language)}টি স্ক্যাম কমেন্ট`,
            )
          : content(
              `Last alert: ${formatCommentTime(alert.sentAt, language)} · failed, ${deliveryErrorText(alert.errorKind, content)} · ${scams(alert.scamCount)}`,
              `শেষ অ্যালার্ট: ${formatCommentTime(alert.sentAt, language)} · ব্যর্থ, ${deliveryErrorText(alert.errorKind, content)} · ${formatCount(alert.scamCount, language)}টি স্ক্যাম কমেন্ট`,
            )}
    </p>
  )
}

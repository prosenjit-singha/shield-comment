import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Crown, LoaderCircle, LogOut, Mail, RotateCw, UserPlus, X } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { DashboardError } from '@/components/dashboard/dashboard-charts'
import { MetaNotice } from '@/components/meta/meta-notice'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import { toApiError, type ApiError } from '@/lib/api'
import { formatCommentTime } from '@/lib/comments-feed'
import { formatCount } from '@/lib/dashboard-summary'
import { sessionQueryOptions } from '@/lib/session'
import {
  type AssignableRole,
  cancelInvitation,
  canManageInvite,
  emailError,
  invitableRoles,
  inviteMember,
  leaveWorkspace,
  memberActions,
  removeMember,
  roleLabel,
  seatMessage,
  seatState,
  sendTransferCode,
  type Team,
  type TeamInvitation,
  type TeamMember,
  teamErrorMessage,
  teamLoadErrorMessage,
  teamQueryOptions,
  teamRootKey,
  type TeamRole,
  TRANSFER_CODE_PATTERN,
  transferErrorMessage,
  type TransferInput,
  transferMethodQueryOptions,
  transferOwnership,
  updateMemberRole,
} from '@/lib/team'
import { cn } from '@/lib/utils'
import { setActiveWorkspace, workspacesQueryOptions } from '@/lib/workspaces'

const ROLE_CLASS: Record<TeamRole, string> = {
  owner: 'bg-primary/10 text-primary',
  admin: 'bg-accent/40 text-accent-foreground',
  moderator: 'bg-muted text-muted-foreground',
}

function RolePill({ role }: { role: TeamRole }) {
  const { content } = useLanguage()
  return (
    <span data-role={role} className={cn('inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium', ROLE_CLASS[role])}>
      {roleLabel(role, content)}
    </span>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-3xl border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function TeamError({ kind, error }: { kind: string; error: ApiError }) {
  const { content, language } = useLanguage()
  return (
    <MetaNotice tone="error" kind={kind} network={error.isNetwork}>
      {teamErrorMessage(error, content, language)}
    </MetaNotice>
  )
}

/** A confirmed member change (D7 / D11). */
type MemberChange = { kind: 'role'; member: TeamMember; role: AssignableRole } | { kind: 'remove'; member: TeamMember } | { kind: 'leave' }
type InviteChange = { kind: 'resend' | 'cancel'; invite: TeamInvitation }

/**
 * C11 `/settings/team` (M7-T13). The viewer's role comes from the members list. D2: an impersonated
 * session sees everything with no actions (403 `IMPERSONATION_READ_ONLY` is still mapped). Moderators get
 * a read-only view plus "Leave workspace".
 */
export function TeamScreen({ workspaceId, userId, impersonated }: { workspaceId: string; userId: string; impersonated: boolean }) {
  const { content } = useLanguage()
  const team = useQuery(teamQueryOptions(workspaceId))

  if (team.isError && !team.data)
    return (
      <DashboardError
        title={content('Couldn’t load your team', 'আপনার টিম লোড করা যায়নি')}
        message={teamLoadErrorMessage(toApiError(team.error), content)}
        onRetry={() => void team.refetch()}
        retrying={team.isFetching}
      />
    )
  if (team.isPending)
    return (
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} data-testid="team-skeleton" className="h-32 w-full rounded-3xl" />
        ))}
      </div>
    )

  const viewer = team.data.members.find((member) => member.userId === userId)?.role ?? null
  return <TeamManager workspaceId={workspaceId} team={team.data} viewer={impersonated ? null : viewer} userId={userId} impersonated={impersonated} />
}

function TeamManager({
  workspaceId,
  team,
  viewer,
  userId,
  impersonated,
}: {
  workspaceId: string
  team: Team
  /** `null` while impersonated: no actions at all. */
  viewer: TeamRole | null
  userId: string
  impersonated: boolean
}) {
  const { content, language } = useLanguage()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [notice, setNotice] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  // The last action stays while the dialog animates out, so its text doesn't change on close.
  const [confirm, setConfirm] = useState<MemberChange | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // A new key per open resets the transfer form.
  const [transfer, setTransfer] = useState({ open: false, key: 0 })
  const refresh = () => queryClient.invalidateQueries({ queryKey: teamRootKey(workspaceId) })

  const change = useMutation<unknown, ApiError, MemberChange>({
    mutationFn: (action) =>
      action.kind === 'role'
        ? updateMemberRole(workspaceId, action.member.memberId, action.role)
        : action.kind === 'remove'
          ? removeMember(workspaceId, action.member.memberId)
          : leaveWorkspace(workspaceId),
    onSuccess: async (_, action) => {
      if (action.kind === 'leave') {
        // The plugin clears the active workspace; set the next one (or none) so the session cookie
        // cache follows, then reload everything like the M7-T11 switcher.
        // The leave itself succeeded, so failures here only leave a stale page until the next load.
        const rest = await queryClient.fetchQuery({ ...workspacesQueryOptions, staleTime: 0 }).catch(() => [])
        await setActiveWorkspace(rest.find((workspace) => workspace.id !== workspaceId)?.id ?? null).catch(() => undefined)
        await queryClient.fetchQuery({ ...sessionQueryOptions, staleTime: 0 }).catch(() => undefined)
        queryClient.removeQueries({ queryKey: ['workspace'] })
        await navigate({ to: '/dashboard', replace: true })
        return
      }
      setConfirmOpen(false)
      setNotice(
        action.kind === 'role'
          ? content(
              `${action.member.name} is now ${roleLabel(action.role, content).toLowerCase()}.`,
              `${action.member.name} এখন ${roleLabel(action.role, content)}।`,
            )
          : content(`${action.member.name} was removed from the workspace.`, `${action.member.name}-কে ওয়ার্কস্পেস থেকে সরানো হয়েছে।`),
      )
      await refresh()
    },
  })

  const inviteChange = useMutation<unknown, ApiError, InviteChange>({
    mutationFn: ({ kind, invite }) =>
      kind === 'resend' ? inviteMember(workspaceId, { email: invite.email, role: invite.role, resend: true }) : cancelInvitation(invite.id),
    onMutate: () => setNotice(null),
    onSuccess: async (_, { kind, invite }) => {
      setNotice(
        kind === 'resend'
          ? content(`Invite sent again to ${invite.email}.`, `${invite.email}-এ আবার আমন্ত্রণ পাঠানো হয়েছে।`)
          : content(`Invite to ${invite.email} cancelled.`, `${invite.email}-এর আমন্ত্রণ বাতিল করা হয়েছে।`),
      )
      await refresh()
    },
  })

  const openConfirm = (action: MemberChange) => {
    change.reset()
    setNotice(null)
    setConfirm(action)
    setConfirmOpen(true)
  }

  const roles = invitableRoles(viewer)
  const seats = seatState(team.seats)
  const inviteBlocked = seats !== 'under'
  const seatNoteId = useId()

  return (
    <div className="flex flex-col gap-6">
      {impersonated ? (
        <MetaNotice tone="info" kind="impersonation-read-only">
          {content(
            'You’re signed in as this client by support. You can see the team, but invites and member changes are off so nothing is done in the client’s name.',
            'আপনি সাপোর্ট থেকে এই ক্লায়েন্ট হিসেবে লগ ইন করেছেন। টিম দেখতে পারবেন, কিন্তু ক্লায়েন্টের নামে কিছু যেন না হয় তাই আমন্ত্রণ ও সদস্য পরিবর্তন বন্ধ।',
          )}
        </MetaNotice>
      ) : viewer === 'moderator' || viewer === null ? (
        <MetaNotice tone="info" kind="moderator-read-only">
          {content('Only the owner and admins can invite people or change the team.', 'শুধু মালিক ও অ্যাডমিন কাউকে আমন্ত্রণ জানাতে বা টিম বদলাতে পারেন।')}
        </MetaNotice>
      ) : null}
      {notice ? (
        <MetaNotice tone="success" kind="team-done">
          {notice}
        </MetaNotice>
      ) : null}

      <Section
        title={content('Seats', 'সিট')}
        action={
          roles.length ? (
            <Button
              className="h-10 px-5"
              disabled={inviteBlocked}
              aria-describedby={inviteBlocked ? seatNoteId : undefined}
              onClick={() => {
                setNotice(null)
                setInviting(true)
              }}
            >
              <UserPlus aria-hidden />
              {content('Invite member', 'সদস্য আমন্ত্রণ')}
            </Button>
          ) : null
        }
      >
        <SeatMeter seats={team.seats} />
        <p id={seatNoteId} data-testid="seat-note" data-state={seats} className={cn('text-sm text-pretty', inviteBlocked ? 'text-foreground' : 'text-muted-foreground')}>
          {seatMessage(team.seats, content, language)}
          {seats === 'no_plan' || seats === 'full' || seats === 'over' ? (
            <>
              {' '}
              <Link to="/plans" className="font-medium text-primary underline-offset-4 hover:underline">
                {content('See plans', 'প্ল্যান দেখুন')}
              </Link>
            </>
          ) : null}
        </p>
      </Section>

      <Section title={content('Members', 'সদস্য')}>
        <div className="-mx-5 overflow-x-auto px-5 sm:-mx-6 sm:px-6">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="pb-2 font-medium">
                  {content('Member', 'সদস্য')}
                </th>
                <th scope="col" className="pb-2 font-medium">
                  {content('Role', 'রোল')}
                </th>
                <th scope="col" className="hidden pb-2 font-medium sm:table-cell">
                  {content('Joined', 'যোগ দিয়েছেন')}
                </th>
                <th scope="col" className="pb-2 text-right font-medium">
                  <span className="sr-only">{content('Actions', 'অ্যাকশন')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {team.members.map((member) => {
                const allowed = memberActions(viewer, member.role)
                const self = member.userId === userId
                const other: AssignableRole = member.role === 'admin' ? 'moderator' : 'admin'
                return (
                  <tr key={member.memberId} data-member={member.memberId}>
                    <td className="py-3 pr-3">
                      <span className="flex flex-col">
                        <span className="font-medium">
                          {member.name}
                          {self ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{content('(you)', '(আপনি)')}</span> : null}
                        </span>
                        <span className="text-xs break-all text-muted-foreground">{member.email}</span>
                      </span>
                    </td>
                    <td className="py-3 pr-3">
                      <RolePill role={member.role} />
                    </td>
                    <td className="hidden py-3 pr-3 text-muted-foreground sm:table-cell">{formatCommentTime(member.joinedAt, language)}</td>
                    <td className="py-3">
                      <span className="flex flex-wrap justify-end gap-2">
                        {viewer === 'owner' && self && team.members.length > 1 ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 px-3"
                            onClick={() => {
                              setNotice(null)
                              setTransfer((state) => ({ open: true, key: state.key + 1 }))
                            }}
                          >
                            <Crown aria-hidden />
                            {content('Transfer ownership', 'মালিকানা হস্তান্তর')}
                          </Button>
                        ) : null}
                        {allowed.changeRole ? (
                          <Button variant="outline" size="sm" className="h-8 px-3" onClick={() => openConfirm({ kind: 'role', member, role: other })}>
                            {other === 'admin' ? content('Make admin', 'অ্যাডমিন করুন') : content('Make moderator', 'মডারেটর করুন')}
                          </Button>
                        ) : null}
                        {allowed.remove ? (
                          <Button variant="ghost" size="sm" className="h-8 px-3 text-destructive" onClick={() => openConfirm({ kind: 'remove', member })}>
                            {content('Remove', 'সরান')}
                          </Button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={content('Pending invites', 'অপেক্ষমাণ আমন্ত্রণ')}>
        {inviteChange.isError ? <TeamError kind="invite-action-error" error={inviteChange.error} /> : null}
        {team.invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{content('No pending invites.', 'কোনো অপেক্ষমাণ আমন্ত্রণ নেই।')}</p>
        ) : (
          <ul aria-label={content('Pending invites', 'অপেক্ষমাণ আমন্ত্রণ')} className="flex flex-col divide-y">
            {team.invitations.map((invite) => {
              const busy = inviteChange.isPending && inviteChange.variables.invite.id === invite.id
              return (
                <li key={invite.id} data-invite={invite.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-all">{invite.email}</span>
                      <RolePill role={invite.role} />
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {content(
                        `Invited by ${invite.inviterName} · expires ${formatCommentTime(invite.expiresAt, language)}`,
                        `আমন্ত্রণ জানিয়েছেন ${invite.inviterName} · মেয়াদ শেষ ${formatCommentTime(invite.expiresAt, language)}`,
                      )}
                    </span>
                  </span>
                  {canManageInvite(viewer, invite.role) ? (
                    <span className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-3"
                        disabled={inviteChange.isPending}
                        aria-busy={busy || undefined}
                        onClick={() => inviteChange.mutate({ kind: 'resend', invite })}
                      >
                        <RotateCw aria-hidden />
                        {content('Resend', 'আবার পাঠান')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-3 text-destructive"
                        disabled={inviteChange.isPending}
                        onClick={() => inviteChange.mutate({ kind: 'cancel', invite })}
                      >
                        <X aria-hidden />
                        {content('Cancel invite', 'আমন্ত্রণ বাতিল')}
                      </Button>
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      {viewer === 'admin' || viewer === 'moderator' ? (
        <Section title={content('Leave workspace', 'ওয়ার্কস্পেস ছেড়ে দিন')}>
          <p className="text-sm text-pretty text-muted-foreground">
            {content(
              'You lose access to this workspace. The owner or an admin can invite you again.',
              'আপনি এই ওয়ার্কস্পেসে আর ঢুকতে পারবেন না। মালিক বা অ্যাডমিন আপনাকে আবার আমন্ত্রণ জানাতে পারবেন।',
            )}
          </p>
          <Button variant="outline" className="h-10 self-start px-5 text-destructive" onClick={() => openConfirm({ kind: 'leave' })}>
            <LogOut aria-hidden />
            {content('Leave workspace', 'ওয়ার্কস্পেস ছেড়ে দিন')}
          </Button>
        </Section>
      ) : null}

      {roles.length ? (
        <InviteDialog
          workspaceId={workspaceId}
          roles={roles}
          open={inviting}
          onOpenChange={setInviting}
          onInvited={(email) => {
            setInviting(false)
            setNotice(content(`Invite sent to ${email}.`, `${email}-এ আমন্ত্রণ পাঠানো হয়েছে।`))
          }}
        />
      ) : null}
      {viewer === 'owner' ? (
        <TransferDialog
          key={transfer.key}
          workspaceId={workspaceId}
          candidates={team.members.filter((member) => member.role !== 'owner')}
          open={transfer.open}
          onOpenChange={(open) => setTransfer((state) => ({ ...state, open }))}
          onTransferred={(name) => {
            setTransfer((state) => ({ ...state, open: false }))
            setNotice(
              content(
                `${name} is now the owner and has the billing account. You’re an admin of this workspace now.`,
                `${name} এখন মালিক এবং বিলিং অ্যাকাউন্ট তাঁর কাছে গেছে। আপনি এখন এই ওয়ার্কস্পেসের অ্যাডমিন।`,
              ),
            )
          }}
        />
      ) : null}
      <ConfirmChange action={confirm} open={confirmOpen} mutation={change} onClose={() => setConfirmOpen(false)} />
    </div>
  )
}

function SeatMeter({ seats }: { seats: Team['seats'] }) {
  const { content, language } = useLanguage()
  const { used, limit } = seats
  const label = content('Seats used', 'ব্যবহৃত সিট')
  const percent = limit ? Math.min(100, Math.round((used / limit) * 100)) : 100
  const state = seatState(seats)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm" data-testid="seat-count">
        <span className="text-2xl font-semibold tabular-nums">{formatCount(used, language)}</span>
        <span className="text-muted-foreground"> / {limit === null ? content('no plan', 'প্ল্যান নেই') : formatCount(limit, language)}</span>
      </p>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit ?? 0}
        aria-valuenow={used}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn('h-full rounded-full', state === 'under' ? 'bg-primary' : state === 'full' ? 'bg-accent' : 'bg-destructive')}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function InviteDialog({
  workspaceId,
  roles,
  open,
  onOpenChange,
  onInvited,
}: {
  workspaceId: string
  roles: AssignableRole[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onInvited: (email: string) => void
}) {
  const { content } = useLanguage()
  const queryClient = useQueryClient()
  const id = useId()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AssignableRole>(roles[roles.length - 1] ?? 'moderator')
  const [touched, setTouched] = useState(false)

  const invite = useMutation<unknown, ApiError, { email: string; role: AssignableRole }>({
    mutationFn: (input) => inviteMember(workspaceId, input),
    onSuccess: async (_, input) => {
      setEmail('')
      setTouched(false)
      onInvited(input.email)
      await queryClient.invalidateQueries({ queryKey: teamRootKey(workspaceId) })
    },
  })

  const changeOpen = (next: boolean) => {
    if (invite.isPending) return
    if (next) invite.reset()
    onOpenChange(next)
  }

  const error = touched ? emailError(email, content) : null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (emailError(email, content)) return
    invite.mutate({ email: email.trim().toLowerCase(), role })
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent showCloseButton={false} className="gap-5 rounded-2xl p-5 sm:max-w-md">
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">{content('Invite a member', 'সদস্য আমন্ত্রণ জানান')}</DialogTitle>
            <DialogDescription className="text-pretty">
              {content(
                'We email them a link that works for 7 days. Inviting the same email again replaces the old invite.',
                'আমরা তাঁকে একটি লিংক ইমেইল করব, যা ৭ দিন কাজ করবে। একই ইমেইলে আবার আমন্ত্রণ জানালে আগেরটি বাতিল হয়ে যাবে।',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-email`} className="text-sm font-medium">
              {content('Email', 'ইমেইল')}
            </label>
            <Input
              id={`${id}-email`}
              type="email"
              autoComplete="off"
              value={email}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-email-error` : undefined}
              onChange={(event) => setEmail(event.target.value)}
              className="h-10 px-4"
            />
            {error ? (
              <span id={`${id}-email-error`} className="text-xs text-destructive">
                {error}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-role`} className="text-sm font-medium">
              {content('Role', 'রোল')}
            </label>
            <select
              id={`${id}-role`}
              value={role}
              onChange={(event) => setRole(event.target.value as AssignableRole)}
              className="h-10 w-full rounded-full border border-input bg-transparent px-4 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              {roles.map((value) => (
                <option key={value} value={value}>
                  {roleLabel(value, content)}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              {role === 'admin'
                ? content('Admins can invite and remove moderators and manage Pages and rules.', 'অ্যাডমিন মডারেটর আমন্ত্রণ ও সরাতে এবং পেজ ও রুল সামলাতে পারেন।')
                : content('Moderators review comments and act on them.', 'মডারেটর কমেন্ট দেখেন ও সেগুলোর ওপর ব্যবস্থা নেন।')}
            </span>
          </div>
          {invite.isError ? <TeamError kind="invite-error" error={invite.error} /> : null}
          <DialogFooter className="-mx-5 -mb-5 rounded-b-2xl p-5">
            <Button type="button" variant="outline" className="h-10 px-5" disabled={invite.isPending} onClick={() => changeOpen(false)}>
              {content('Cancel', 'বাতিল')}
            </Button>
            <Button type="submit" className="h-10 px-5" disabled={invite.isPending} aria-busy={invite.isPending || undefined}>
              {invite.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Mail aria-hidden />}
              {content('Send invite', 'আমন্ত্রণ পাঠান')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ConfirmChange({
  action,
  open,
  mutation,
  onClose,
}: {
  action: MemberChange | null
  open: boolean
  mutation: { mutate: (action: MemberChange) => void; isPending: boolean; error: ApiError | null }
  onClose: () => void
}) {
  const { content } = useLanguage()
  const pending = mutation.isPending
  const text =
    action?.kind === 'role'
      ? {
          title: content(`Make ${action.member.name} ${roleLabel(action.role, content).toLowerCase()}?`, `${action.member.name}-কে ${roleLabel(action.role, content)} করবেন?`),
          body:
            action.role === 'admin'
              ? content(
                  'Admins can invite and remove moderators and manage Pages and rules.',
                  'অ্যাডমিন মডারেটর আমন্ত্রণ ও সরাতে এবং পেজ ও রুল সামলাতে পারেন।',
                )
              : content('Moderators can review comments but can’t invite people or change the team.', 'মডারেটর কমেন্ট দেখতে পারেন, কিন্তু কাউকে আমন্ত্রণ বা টিম বদলাতে পারেন না।'),
          confirm: content('Change role', 'রোল বদলান'),
          destructive: false,
        }
      : action?.kind === 'remove'
        ? {
            title: content(`Remove ${action.member.name}?`, `${action.member.name}-কে সরাবেন?`),
            body: content(
              'They lose access to this workspace right away and their seat is freed. You can invite them again later.',
              'তিনি সঙ্গে সঙ্গে এই ওয়ার্কস্পেসে ঢোকার অধিকার হারাবেন এবং তাঁর সিট খালি হবে। পরে আবার আমন্ত্রণ জানাতে পারবেন।',
            ),
            confirm: content('Yes, remove', 'হ্যাঁ, সরান'),
            destructive: true,
          }
        : {
            title: content('Leave this workspace?', 'এই ওয়ার্কস্পেস ছেড়ে দেবেন?'),
            body: content(
              'You lose access right away. The owner or an admin can invite you again.',
              'আপনি সঙ্গে সঙ্গে ঢোকার অধিকার হারাবেন। মালিক বা অ্যাডমিন আপনাকে আবার আমন্ত্রণ জানাতে পারবেন।',
            ),
            confirm: content('Yes, leave', 'হ্যাঁ, ছেড়ে দিন'),
            destructive: true,
          }

  return (
    <Dialog open={open && action !== null} onOpenChange={(next) => (!next && !pending ? onClose() : undefined)}>
      <DialogContent showCloseButton={false} className="gap-5 rounded-2xl p-5 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">{text.title}</DialogTitle>
          <DialogDescription className="text-pretty">{text.body}</DialogDescription>
        </DialogHeader>
        {mutation.error && !pending ? <TeamError kind="change-error" error={mutation.error} /> : null}
        <DialogFooter className="-mx-5 -mb-5 rounded-b-2xl p-5">
          <Button variant="outline" className="h-10 px-5" disabled={pending} onClick={onClose}>
            {content('Cancel', 'বাতিল')}
          </Button>
          <Button
            variant={text.destructive ? 'destructive' : 'default'}
            className="h-10 px-5"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={() => (action ? mutation.mutate(action) : undefined)}
          >
            {pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
            {text.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Whole seconds until `iso` (0 once passed), ticking every second while set (the first tick corrects a stale `now`). */
function useSecondsUntil(iso: string | null): number {
  const [now, setNow] = useState(() => Date.now())
  const target = iso ? Date.parse(iso) : 0
  useEffect(() => {
    if (!iso) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [iso])
  return Math.max(0, Math.ceil((target - now) / 1000))
}

const FIELD_CLASS =
  'h-10 w-full rounded-full border border-input bg-transparent px-4 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'

/**
 * M7-T13b (D11 b with verification, M7-D19 a): the owner picks a member and confirms with the current
 * password twice, or (Google-only owner) with an emailed 6-digit code. Success puts the returned team into
 * the cache (the viewer is admin now) and reloads the workspace data that depends on role or billing.
 */
function TransferDialog({
  workspaceId,
  candidates,
  open,
  onOpenChange,
  onTransferred,
}: {
  workspaceId: string
  candidates: TeamMember[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onTransferred: (name: string) => void
}) {
  const { content, language } = useLanguage()
  const queryClient = useQueryClient()
  const id = useId()
  const methodOptions = transferMethodQueryOptions(workspaceId)
  const method = useQuery({ ...methodOptions, enabled: open })
  const [memberId, setMemberId] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [code, setCode] = useState('')
  const [touched, setTouched] = useState(false)
  const [resendAt, setResendAt] = useState<string | null>(null)
  const wait = useSecondsUntil(resendAt)
  const target = candidates.find((member) => member.memberId === memberId)
  const targetName = target?.name ?? content('this member', 'এই সদস্য')

  const send = useMutation<{ expiresAt: string; resendAt: string }, ApiError>({
    mutationFn: () => sendTransferCode(workspaceId),
    onMutate: (): void => transfer.reset(),
    onSuccess: (sent) => setResendAt(sent.resendAt),
    onError: (error) => {
      if (error.code === 'TRANSFER_CODE_NOT_NEEDED') void queryClient.invalidateQueries({ queryKey: methodOptions.queryKey })
    },
  })

  const transfer = useMutation<Team, ApiError, TransferInput>({
    mutationFn: (input) => transferOwnership(workspaceId, input),
    onMutate: (): void => send.reset(),
    onSuccess: async (next) => {
      queryClient.setQueryData(teamRootKey(workspaceId), next)
      onTransferred(targetName)
      // Role and billing moved: reload every other workspace query (billing summary, plans, …).
      await queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId], predicate: (query) => query.queryKey[2] !== 'team' })
    },
  })
  const pending = transfer.isPending

  const errors = {
    member: !memberId ? content('Choose who becomes the owner.', 'কে মালিক হবেন তা বেছে নিন।') : null,
    password: !password ? content('Enter your current password.', 'আপনার বর্তমান পাসওয়ার্ড লিখুন।') : null,
    passwordConfirm: !passwordConfirm
      ? content('Enter your password again.', 'পাসওয়ার্ডটি আবার লিখুন।')
      : password && passwordConfirm !== password
        ? content('The two passwords don’t match.', 'দুটি পাসওয়ার্ড মিলছে না।')
        : null,
    code: !TRANSFER_CODE_PATTERN.test(code.trim()) ? content('Enter the 6-digit code from the email.', 'ইমেইলে পাওয়া ৬ সংখ্যার কোডটি লিখুন।') : null,
  }
  const shown = (key: keyof typeof errors) => (touched ? errors[key] : null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!method.data) return
    setTouched(true)
    if (errors.member) return
    if (method.data.method === 'password') {
      if (errors.password || errors.passwordConfirm) return
      transfer.mutate({ memberId, password, passwordConfirm })
    } else {
      if (errors.code) return
      transfer.mutate({ memberId, code: code.trim() })
    }
  }

  const field = (key: keyof typeof errors, label: string, input: (props: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode) => {
    const error = shown(key)
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-${key}`} className="text-sm font-medium">
          {label}
        </label>
        {input({ id: `${id}-${key}`, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-${key}-error` : undefined })}
        {error ? (
          <span id={`${id}-${key}-error`} className="text-xs text-destructive">
            {error}
          </span>
        ) : null}
      </div>
    )
  }

  const failure = transfer.error ?? send.error
  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={false} className="gap-5 rounded-2xl p-5 sm:max-w-md">
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">{content('Transfer ownership', 'মালিকানা হস্তান্তর')}</DialogTitle>
            <DialogDescription className="text-pretty">
              {content(
                'The new owner controls the team and the billing for this workspace.',
                'নতুন মালিক এই ওয়ার্কস্পেসের টিম ও বিলিং নিয়ন্ত্রণ করবেন।',
              )}
            </DialogDescription>
          </DialogHeader>
          {field('member', content('New owner', 'নতুন মালিক'), (props) => (
            <select {...props} value={memberId} onChange={(event) => setMemberId(event.target.value)} className={FIELD_CLASS}>
              <option value="">{content('Choose a member', 'একজন সদস্য বেছে নিন')}</option>
              {candidates.map((member) => (
                <option key={member.memberId} value={member.memberId}>
                  {`${member.name} (${member.email}) · ${roleLabel(member.role, content)}`}
                </option>
              ))}
            </select>
          ))}
          <MetaNotice tone="warning" kind="transfer-warning">
            {content(
              `The billing account (plan, wallet and payments) moves to ${targetName}, and you become an admin. Only the new owner can give ownership back.`,
              `বিলিং অ্যাকাউন্ট (প্ল্যান, ওয়ালেট ও পেমেন্ট) ${targetName}-এর কাছে চলে যাবে, আর আপনি অ্যাডমিন হয়ে যাবেন। শুধু নতুন মালিকই মালিকানা আবার ফিরিয়ে দিতে পারবেন।`,
            )}
          </MetaNotice>

          {method.isPending ? (
            <Skeleton data-testid="transfer-method-skeleton" className="h-24 w-full rounded-2xl" />
          ) : method.isError ? (
            <MetaNotice
              tone="error"
              kind="transfer-method-error"
              network={toApiError(method.error).isNetwork}
              action={
                <Button type="button" variant="outline" size="sm" className="h-9 shrink-0 px-4" disabled={method.isFetching} onClick={() => void method.refetch()}>
                  <RotateCw aria-hidden />
                  {content('Try again', 'আবার চেষ্টা করুন')}
                </Button>
              }
            >
              {transferErrorMessage(toApiError(method.error), content, language, targetName)}
            </MetaNotice>
          ) : method.data.method === 'password' ? (
            <>
              {field('password', content('Current password', 'বর্তমান পাসওয়ার্ড'), (props) => (
                <Input {...props} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="h-10 px-4" />
              ))}
              {field('passwordConfirm', content('Current password again', 'বর্তমান পাসওয়ার্ড আবার'), (props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="current-password"
                  value={passwordConfirm}
                  onChange={(event) => setPasswordConfirm(event.target.value)}
                  className="h-10 px-4"
                />
              ))}
            </>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-pretty text-muted-foreground">
                {resendAt
                  ? content('We emailed you a 6-digit code. It works for 10 minutes.', 'আমরা আপনাকে একটি ৬ সংখ্যার কোড ইমেইল করেছি। এটি ১০ মিনিট কাজ করবে।')
                  : content(
                      'You sign in with Google, so we’ll email you a 6-digit code to confirm.',
                      'আপনি Google দিয়ে লগ ইন করেন, তাই নিশ্চিত করতে আমরা আপনাকে একটি ৬ সংখ্যার কোড ইমেইল করব।',
                    )}
              </p>
              <Button
                type="button"
                variant="outline"
                className="h-10 self-start px-5"
                disabled={send.isPending || pending || wait > 0}
                aria-busy={send.isPending || undefined}
                onClick={() => send.mutate()}
              >
                {send.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Mail aria-hidden />}
                {!resendAt
                  ? content('Send code', 'কোড পাঠান')
                  : wait > 0
                    ? content(`Send again in ${wait} s`, `${formatCount(wait, language)} সেকেন্ড পরে আবার পাঠান`)
                    : content('Send a new code', 'নতুন কোড পাঠান')}
              </Button>
              {resendAt
                ? field('code', content('Code from the email', 'ইমেইলের কোড'), (props) => (
                    <Input
                      {...props}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={code}
                      onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                      className="h-10 px-4 tracking-widest tabular-nums"
                    />
                  ))
                : null}
            </div>
          )}

          {failure && !transfer.isPending && !send.isPending ? (
            <MetaNotice tone="error" kind="transfer-error" network={failure.isNetwork}>
              {transferErrorMessage(failure, content, language, targetName)}
            </MetaNotice>
          ) : null}
          <DialogFooter className="-mx-5 -mb-5 rounded-b-2xl p-5">
            <Button type="button" variant="outline" className="h-10 px-5" disabled={pending} onClick={() => onOpenChange(false)}>
              {content('Cancel', 'বাতিল')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              className="h-10 px-5"
              disabled={pending || !method.data || (method.data.method === 'code' && !resendAt)}
              aria-busy={pending || undefined}
            >
              {pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {content('Transfer ownership', 'মালিকানা হস্তান্তর')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

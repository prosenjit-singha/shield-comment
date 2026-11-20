import { queryOptions } from '@tanstack/react-query'
import { apiFetch, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import { formatCount } from '@/lib/dashboard-summary'
import type { Language } from '@/lib/language'
import { genericFailure } from '@/lib/meta-messages'

/*
 * C11 `/settings/team` data (M7-T13; Module 7 D2, D7, D9, D10, D11 answered 2026-11-20).
 * Read: `GET /api/workspaces/:workspaceId/team` (backend `src/workspaces/team.*`, any member, impersonated too).
 * Writes: the Better Auth organization plugin under `/api/auth/organization/*` (no wrapper routes, M7-T5/T6);
 * every body names the workspace (`organizationId`) except cancel, which names the invitation.
 * Calls go through `apiFetch` so plugin + backend refusals arrive as one `ApiError` (`code`, `details`).
 */

export type TeamRole = 'owner' | 'admin' | 'moderator'
/** D7 / D11: nobody is invited as, or promoted to, owner. */
export type AssignableRole = Exclude<TeamRole, 'owner'>

export interface TeamMember {
  memberId: string
  userId: string
  name: string
  email: string
  role: TeamRole
  joinedAt: string
}

export interface TeamInvitation {
  id: string
  email: string
  role: AssignableRole
  expiresAt: string
  inviterName: string
}

export interface Team {
  /** Owner first, then by join date. */
  members: TeamMember[]
  /** Pending, unexpired, oldest first. */
  invitations: TeamInvitation[]
  /** D9: members (owner incl.) + pending invites, pooled on the billing account; `limit` null = no live plan. */
  seats: { used: number; limit: number | null }
}

export const teamRootKey = (workspaceId: string) => ['workspace', workspaceId, 'team'] as const

export function teamQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: teamRootKey(workspaceId),
    queryFn: () => apiFetch<Team>(`/api/workspaces/${encodeURIComponent(workspaceId)}/team`),
  })
}

const org = (path: string, body: Record<string, unknown>) => apiFetch<unknown>(`/api/auth/organization/${path}`, { method: 'POST', body })

/** `resend: true` re-sends the same invite (same id, new 7-day expiry); a plain re-invite cancels the old one (D7). */
export const inviteMember = (workspaceId: string, input: { email: string; role: AssignableRole; resend?: boolean }) =>
  org('invite-member', { ...input, organizationId: workspaceId })
export const cancelInvitation = (invitationId: string) => org('cancel-invitation', { invitationId })
export const updateMemberRole = (workspaceId: string, memberId: string, role: AssignableRole) =>
  org('update-member-role', { memberId, role, organizationId: workspaceId })
export const removeMember = (workspaceId: string, memberId: string) =>
  org('remove-member', { memberIdOrEmail: memberId, organizationId: workspaceId })
export const leaveWorkspace = (workspaceId: string) => org('leave', { organizationId: workspaceId })

/** D7: owner invites admin or moderator, admin invites moderator only, moderator nobody. */
export function invitableRoles(viewer: TeamRole | null): AssignableRole[] {
  if (viewer === 'owner') return ['admin', 'moderator']
  if (viewer === 'admin') return ['moderator']
  return []
}

/**
 * D7 / D11: who may change whom (mirrors backend `memberChangeRefusal`). The owner row never has actions;
 * the owner re-roles and removes admins and moderators; an admin removes moderators only (no promotions).
 */
export function memberActions(viewer: TeamRole | null, target: TeamRole): { changeRole: boolean; remove: boolean } {
  if (target === 'owner') return { changeRole: false, remove: false }
  if (viewer === 'owner') return { changeRole: true, remove: true }
  if (viewer === 'admin') return { changeRole: false, remove: target === 'moderator' }
  return { changeRole: false, remove: false }
}

/** Resend / cancel a pending invite: the owner any, an admin moderator invites only (same rule as members). */
export const canManageInvite = (viewer: TeamRole | null, role: AssignableRole) => invitableRoles(viewer).includes(role)

export type SeatState = 'no_plan' | 'under' | 'full' | 'over'

export function seatState({ used, limit }: Team['seats']): SeatState {
  if (limit === null) return 'no_plan'
  if (used > limit) return 'over'
  return used === limit ? 'full' : 'under'
}

/** Same loose check as a browser `type=email`; the plugin validates for real. */
export function emailError(email: string, content: ContentFn): string | null {
  const value = email.trim()
  if (!value) return content('Enter an email address.', 'একটি ইমেইল ঠিকানা লিখুন।')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return content('Enter a valid email address.', 'একটি সঠিক ইমেইল ঠিকানা লিখুন।')
  return null
}

export function roleLabel(role: TeamRole, content: ContentFn): string {
  switch (role) {
    case 'owner':
      return content('Owner', 'মালিক')
    case 'admin':
      return content('Admin', 'অ্যাডমিন')
    case 'moderator':
      return content('Moderator', 'মডারেটর')
  }
}

export function seatMessage(seats: Team['seats'], content: ContentFn, language: Language): string {
  const n = (value: number) => formatCount(value, language)
  const { used, limit } = seats
  switch (seatState(seats)) {
    case 'no_plan':
      return content(
        'Your workspace has no active plan, so you can’t invite anyone. Choose a plan to add people.',
        'আপনার ওয়ার্কস্পেসে কোনো সক্রিয় প্ল্যান নেই, তাই কাউকে আমন্ত্রণ জানানো যাবে না। মানুষ যোগ করতে একটি প্ল্যান বেছে নিন।',
      )
    case 'over':
      return content(
        `You’re using ${used} seats but your plan has ${limit}. Nobody is removed, but new invites and accepts are off until you’re under the limit. Remove someone, cancel an invite or upgrade your plan.`,
        `আপনি ${n(used)}টি সিট ব্যবহার করছেন কিন্তু আপনার প্ল্যানে আছে ${n(limit ?? 0)}টি। কাউকে সরানো হবে না, তবে লিমিটের নিচে না নামা পর্যন্ত নতুন আমন্ত্রণ ও যোগদান বন্ধ থাকবে। কাউকে সরান, কোনো আমন্ত্রণ বাতিল করুন বা প্ল্যান আপগ্রেড করুন।`,
      )
    case 'full':
      return content(
        'All seats are in use. Remove someone, cancel an invite or upgrade your plan to invite more people.',
        'সব সিট ব্যবহার হয়ে গেছে। আরও মানুষকে আমন্ত্রণ জানাতে কাউকে সরান, কোনো আমন্ত্রণ বাতিল করুন বা প্ল্যান আপগ্রেড করুন।',
      )
    case 'under': {
      const left = (limit ?? 0) - used
      return content(
        `${left} seat${left === 1 ? '' : 's'} left. Members and pending invites across your plan’s workspaces count.`,
        `আরও ${n(left)}টি সিট বাকি। আপনার প্ল্যানের সব ওয়ার্কস্পেসের সদস্য ও অপেক্ষমাণ আমন্ত্রণ গোনা হয়।`,
      )
    }
  }
}

/** Every team write failure by `code` (backend + plugin), then by status; server text is never shown. */
export function teamErrorMessage(error: ApiError, content: ContentFn, language: Language): string {
  switch (error.code) {
    case 'IMPERSONATION_READ_ONLY':
      return content(
        'You’re signed in as this client by support, so you can see the team but not change it.',
        'আপনি সাপোর্ট থেকে এই ক্লায়েন্ট হিসেবে লগ ইন করেছেন, তাই টিম দেখতে পারবেন কিন্তু বদলাতে পারবেন না।',
      )
    case 'SEAT_LIMIT_REACHED': {
      const { limit, used } = error.details ?? {}
      if (typeof limit === 'number' && typeof used === 'number')
        return content(
          `Your plan has ${limit} seat${limit === 1 ? '' : 's'} and ${used} ${used === 1 ? 'is' : 'are'} used (members and pending invites). Remove someone, cancel an invite or upgrade your plan.`,
          `আপনার প্ল্যানে ${formatCount(limit, language)}টি সিট আছে এবং ${formatCount(used, language)}টি ব্যবহার হয়েছে (সদস্য ও অপেক্ষমাণ আমন্ত্রণ)। কাউকে সরান, কোনো আমন্ত্রণ বাতিল করুন বা প্ল্যান আপগ্রেড করুন।`,
        )
      return content('All seats on your plan are in use.', 'আপনার প্ল্যানের সব সিট ব্যবহার হয়ে গেছে।')
    }
    case 'NO_ACTIVE_PLAN':
      return content(
        'Your plan has ended, so you can’t invite people. Choose a plan first.',
        'আপনার প্ল্যান শেষ হয়ে গেছে, তাই কাউকে আমন্ত্রণ জানানো যাবে না। আগে একটি প্ল্যান বেছে নিন।',
      )
    case 'WORKSPACE_OWNER_PROTECTED':
    case 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER':
    case 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER':
      return content(
        'The workspace owner can’t be removed, change role or leave.',
        'ওয়ার্কস্পেসের মালিককে সরানো, তাঁর রোল বদলানো বা তাঁর চলে যাওয়া যায় না।',
      )
    case 'YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE':
      return content('You can’t invite someone with this role.', 'আপনি এই রোলে কাউকে আমন্ত্রণ জানাতে পারবেন না।')
    case 'YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION':
      return content('Only the owner and admins can invite people.', 'শুধু মালিক ও অ্যাডমিন কাউকে আমন্ত্রণ জানাতে পারেন।')
    case 'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER':
      return content('You can’t change this member’s role.', 'আপনি এই সদস্যের রোল বদলাতে পারবেন না।')
    case 'YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER':
      return content('You can’t remove this member.', 'আপনি এই সদস্যকে সরাতে পারবেন না।')
    case 'YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION':
      return content('You can’t cancel this invite.', 'আপনি এই আমন্ত্রণ বাতিল করতে পারবেন না।')
    case 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION':
      return content('This person is already a member of the workspace.', 'এই ব্যক্তি আগে থেকেই ওয়ার্কস্পেসের সদস্য।')
    case 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION':
      return content('This person already has a pending invite.', 'এই ব্যক্তির জন্য আগে থেকেই একটি অপেক্ষমাণ আমন্ত্রণ আছে।')
    case 'INVITATION_LIMIT_REACHED':
    case 'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED':
      return content('This workspace can’t take more people right now.', 'এই ওয়ার্কস্পেসে এই মুহূর্তে আর কাউকে যোগ করা যাবে না।')
    case 'INVITATION_NOT_FOUND':
      return content('This invite no longer exists. It may have been accepted or cancelled.', 'এই আমন্ত্রণটি আর নেই। হয়তো এটি গ্রহণ বা বাতিল করা হয়েছে।')
    case 'MEMBER_NOT_FOUND':
      return content('This member is no longer in the workspace.', 'এই সদস্য আর ওয়ার্কস্পেসে নেই।')
    case 'YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION':
    case 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION':
      return content('You’re no longer a member of this workspace.', 'আপনি আর এই ওয়ার্কস্পেসের সদস্য নন।')
  }
  if (error.status === 403) return content('You don’t have permission to do this.', 'এটি করার অনুমতি আপনার নেই।')
  if (error.status === 400) return content('Check the details and try again.', 'তথ্যগুলো দেখে আবার চেষ্টা করুন।')
  return genericFailure(error, content)
}

export function teamLoadErrorMessage(error: ApiError, content: ContentFn): string {
  if (error.status === 404) return content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')
  return genericFailure(error, content)
}

/*
 * Ownership transfer (M7-T13b; D11 b with verification, M7-D19 a). Owner only, never while impersonated (D2).
 * `GET …/team/transfer-ownership` → `{ method }`: `password` = the current password twice; `code` (Google-only
 * owner) = `POST …/code` emails a 6-digit code (10 min, resend 1/min). `POST …/transfer-ownership` answers the new
 * team view. Wrong password is 403 (never 401), so the session stays.
 */
export type TransferMethod = 'password' | 'code'
export type TransferInput = { memberId: string; password: string; passwordConfirm: string } | { memberId: string; code: string }

const transferPath = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/team/transfer-ownership`

export function transferMethodQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: [...teamRootKey(workspaceId), 'transfer-ownership'] as const,
    queryFn: () => apiFetch<{ method: TransferMethod }>(transferPath(workspaceId)),
  })
}

export const sendTransferCode = (workspaceId: string) =>
  apiFetch<{ expiresAt: string; resendAt: string }>(`${transferPath(workspaceId)}/code`, { method: 'POST' })
export const transferOwnership = (workspaceId: string, input: TransferInput) => apiFetch<Team>(transferPath(workspaceId), { method: 'POST', body: input })

export const TRANSFER_CODE_PATTERN = /^\d{6}$/

/** `TRANSFER_*` codes (backend `OWNERSHIP_TRANSFER_CODES`), then the shared team mapping. */
export function transferErrorMessage(error: ApiError, content: ContentFn, language: Language, targetName: string): string {
  switch (error.code) {
    case 'TRANSFER_PASSWORD_REQUIRED':
      return content('Enter your current password in both fields.', 'দুই ঘরেই আপনার বর্তমান পাসওয়ার্ড লিখুন।')
    case 'TRANSFER_PASSWORD_MISMATCH':
      return content('The two passwords don’t match.', 'দুটি পাসওয়ার্ড মিলছে না।')
    case 'TRANSFER_PASSWORD_INVALID':
      return content('That password isn’t right. Check it and try again.', 'পাসওয়ার্ডটি সঠিক নয়। দেখে আবার চেষ্টা করুন।')
    case 'TRANSFER_CODE_REQUIRED':
      return content('Enter the 6-digit code from the email.', 'ইমেইলে পাওয়া ৬ সংখ্যার কোডটি লিখুন।')
    case 'TRANSFER_CODE_INVALID':
      return content('That code isn’t right. Check the email and try again.', 'কোডটি সঠিক নয়। ইমেইল দেখে আবার চেষ্টা করুন।')
    case 'TRANSFER_CODE_EXPIRED':
      return content('This code has expired or was already used. Send a new code.', 'এই কোডের মেয়াদ শেষ বা এটি আগেই ব্যবহার হয়েছে। নতুন কোড পাঠান।')
    case 'TRANSFER_TOO_MANY_ATTEMPTS':
      return content('Too many tries. Wait 10 minutes, then try again.', 'অনেকবার চেষ্টা করা হয়েছে। ১০ মিনিট অপেক্ষা করে আবার চেষ্টা করুন।')
    case 'TRANSFER_CODE_RESEND_TOO_SOON':
      return content('A code was sent less than a minute ago. Wait a moment, then send again.', 'এক মিনিটের কম আগে একটি কোড পাঠানো হয়েছে। একটু অপেক্ষা করে আবার পাঠান।')
    case 'TRANSFER_CODE_NOT_NEEDED':
      return content('Your account has a password, so confirm with your password instead.', 'আপনার অ্যাকাউন্টে পাসওয়ার্ড আছে, তাই পাসওয়ার্ড দিয়ে নিশ্চিত করুন।')
    case 'TRANSFER_CODE_EMAIL_FAILED':
      return content('We couldn’t send the email. Try again in a moment.', 'ইমেইল পাঠানো যায়নি। একটু পরে আবার চেষ্টা করুন।')
    case 'TRANSFER_TARGET_IS_SELF':
      return content('You already own this workspace. Choose another member.', 'আপনি আগে থেকেই এই ওয়ার্কস্পেসের মালিক। অন্য একজন সদস্য বেছে নিন।')
    case 'TRANSFER_TARGET_NOT_FOUND':
      return content('This person is no longer a member of the workspace.', 'এই ব্যক্তি আর ওয়ার্কস্পেসের সদস্য নন।')
    case 'TRANSFER_TARGET_HAS_ACCOUNT':
      return content(
        `${targetName} already has their own plan or billing history, so your billing account can’t move to them. Contact support to transfer this workspace.`,
        `${targetName}-এর নিজের প্ল্যান বা বিলিং ইতিহাস আছে, তাই আপনার বিলিং অ্যাকাউন্ট তাঁর কাছে যাবে না। এই ওয়ার্কস্পেস হস্তান্তর করতে সাপোর্টে যোগাযোগ করুন।`,
      )
    case 'TRANSFER_ACCOUNT_HAS_OTHER_WORKSPACES':
      return content(
        'Your plan also pays for your other workspaces, so it can’t move with this one. Contact support to transfer this workspace.',
        'আপনার প্ল্যান অন্য ওয়ার্কস্পেসগুলোর খরচও দেয়, তাই এটি এই ওয়ার্কস্পেসের সঙ্গে যাবে না। এই ওয়ার্কস্পেস হস্তান্তর করতে সাপোর্টে যোগাযোগ করুন।',
      )
  }
  if (error.status === 403 && !error.code) return content('Only the workspace owner can transfer ownership.', 'শুধু ওয়ার্কস্পেসের মালিক মালিকানা হস্তান্তর করতে পারেন।')
  return teamErrorMessage(error, content, language)
}

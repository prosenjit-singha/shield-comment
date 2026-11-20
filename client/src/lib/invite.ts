import { queryOptions } from '@tanstack/react-query'
import { ApiError, apiFetch } from '@/lib/api'
import { authClient } from '@/lib/auth-client'
import { authErrorFromResponse, toAuthError, type ContentFn } from '@/lib/auth-errors'
import { formatCount } from '@/lib/dashboard-summary'
import type { Language } from '@/lib/language'
import { genericFailure } from '@/lib/meta-messages'

/*
 * C11 invite link `/invite/$invitationId` (M7-T14; Module 7 D8 a, D9/D10, M7-D18 a, M7-D22 generic page).
 * Signed-out visitors can't read the invite (Better Auth's `get-invitation` needs the recipient's session),
 * so they sign up (`invitationId`, no `workspaceName`) or log in first; the backend checks the email.
 */

/** Better Auth `GET /organization/get-invitation?id=` (recipient only, pending + unexpired). */
export interface InvitationDetails {
  id: string
  email: string
  role: string
  organizationId: string
  organizationName: string
  inviterEmail: string
  expiresAt: string
}

/** Invite ids are uuidv7; anything else can't be an invite (the backend answers `INVITATION_NOT_FOUND`). */
export const isInvitationId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

export const notFoundError = () => new ApiError(400, 'Invitation not found', { code: 'INVITATION_NOT_FOUND' })

/** Not under `['workspace', …]`: it belongs to the signed-in user, not to an active workspace. */
export function invitationQueryOptions(invitationId: string) {
  return queryOptions({
    queryKey: ['auth', 'invitation', invitationId] as const,
    queryFn: () =>
      apiFetch<InvitationDetails>(`/api/auth/organization/get-invitation?id=${encodeURIComponent(invitationId)}`),
  })
}

/** The plugin makes the workspace active and the backend refreshes the cookie cache (M7-T6). */
export const acceptInvitation = (invitationId: string) =>
  apiFetch<unknown>('/api/auth/organization/accept-invitation', { method: 'POST', body: { invitationId } })

export interface InviteSignUpInput {
  name: string
  email: string
  password: string
}

const INVITE_CODES = new Set(['INVITATION_NOT_FOUND', 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'])

/**
 * `POST /api/auth/sign-up/email` with `invitationId` (D8: no first workspace, billing account or trial).
 * `invitationId` rides in `fetchOptions.body` like `workspaceName` does in `signUpWithWorkspace`.
 * The invite refusals throw `ApiError` (with `code`); everything else the usual `AuthError`.
 */
export async function signUpFromInvite(invitationId: string, input: InviteSignUpInput): Promise<void> {
  let result: Awaited<ReturnType<typeof authClient.signUp.email>>
  try {
    result = await authClient.signUp.email(
      { name: input.name.trim(), email: input.email.trim(), password: input.password },
      { body: { invitationId } },
    )
  } catch (thrown) {
    throw toAuthError(thrown)
  }
  if (!result.error) return
  const { status, code, message } = result.error
  if (code && INVITE_CODES.has(code)) throw new ApiError(status, message ?? code, { code })
  throw authErrorFromResponse(result.error)
}

/** Invite read / accept / sign-up refusals for the invited person (not the owner), en + bn. */
export function inviteErrorMessage(error: ApiError, content: ContentFn, language: Language): string {
  switch (error.code) {
    case 'INVITATION_NOT_FOUND':
    case 'ORGANIZATION_NOT_FOUND':
    case 'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION':
      return content(
        'This invite has expired, was cancelled or doesn’t exist. Ask the person who invited you to send a new one.',
        'এই আমন্ত্রণের মেয়াদ শেষ, এটি বাতিল করা হয়েছে বা এটি নেই। যিনি আমন্ত্রণ জানিয়েছেন তাঁকে নতুন একটি পাঠাতে বলুন।',
      )
    case 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION':
      return content(
        'This invite was sent to a different email address. Use the account for that email.',
        'এই আমন্ত্রণটি অন্য একটি ইমেইল ঠিকানায় পাঠানো হয়েছে। সেই ইমেইলের অ্যাকাউন্ট ব্যবহার করুন।',
      )
    case 'SEAT_LIMIT_REACHED': {
      const { limit, used } = error.details ?? {}
      const seats =
        typeof limit === 'number' && typeof used === 'number'
          ? content(
              ` (${used} of ${limit} seats used)`,
              ` (${formatCount(limit, language)}টির মধ্যে ${formatCount(used, language)}টি সিট ব্যবহৃত)`,
            )
          : ''
      return content(
        `This workspace’s plan has no free seat${seats}. Ask the workspace owner to free a seat or upgrade, then try again.`,
        `এই ওয়ার্কস্পেসের প্ল্যানে কোনো খালি সিট নেই${seats}। ওয়ার্কস্পেসের মালিককে একটি সিট খালি করতে বা প্ল্যান আপগ্রেড করতে বলুন, তারপর আবার চেষ্টা করুন।`,
      )
    }
    case 'NO_ACTIVE_PLAN':
      return content(
        'This workspace has no active plan, so nobody can join right now. Ask the workspace owner to choose a plan.',
        'এই ওয়ার্কস্পেসে কোনো সক্রিয় প্ল্যান নেই, তাই এখন কেউ যোগ দিতে পারবেন না। ওয়ার্কস্পেসের মালিককে একটি প্ল্যান বেছে নিতে বলুন।',
      )
    case 'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED':
      return content(
        'This workspace can’t take more people right now. Ask the workspace owner.',
        'এই ওয়ার্কস্পেসে এই মুহূর্তে আর কাউকে যোগ করা যাবে না। ওয়ার্কস্পেসের মালিককে জানান।',
      )
    case 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION':
      return content('You’re already a member of this workspace.', 'আপনি আগে থেকেই এই ওয়ার্কস্পেসের সদস্য।')
  }
  return genericFailure(error, content)
}

/** Codes after which Accept can't succeed, so the page hides it. */
export const isFinalInviteError = (error: ApiError) =>
  error.code === 'INVITATION_NOT_FOUND' ||
  error.code === 'ORGANIZATION_NOT_FOUND' ||
  error.code === 'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION' ||
  error.code === 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'

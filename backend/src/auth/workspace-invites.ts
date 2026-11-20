import { Logger } from '@nestjs/common';
import { APIError } from 'better-auth';
import { SEAT_ERROR_CODES, type SeatCheck } from '../billing/limit.service.js';
import { bilingualEmail, type EmailContent } from '../email/bilingual-email.js';
import type { EmailService } from '../email/email.service.js';

/** D7 (Module 7): invite links last 7 days (`invitationExpiresIn`, seconds). */
export const INVITATION_EXPIRES_IN_SEC = 7 * 24 * 60 * 60;

/** 403 (D2): impersonated sessions read the team but never change it. */
export const IMPERSONATION_READ_ONLY = 'IMPERSONATION_READ_ONLY';

/** The plugin's own code for a refused invite role, reused for the D7 rules. */
export const INVITE_ROLE_REFUSED =
  'YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE';

/**
 * Better Auth organization routes that change the team (D2): 403 `IMPERSONATION_READ_ONLY` for an
 * impersonated session. Reads (`list-*`, `get-*`) stay open.
 */
export const TEAM_WRITE_PATHS: ReadonlySet<string> = new Set([
  '/organization/invite-member',
  '/organization/cancel-invitation',
  '/organization/accept-invitation',
  '/organization/reject-invitation',
  '/organization/update-member-role',
  '/organization/remove-member',
  '/organization/leave',
]);

export const INVITE_MEMBER_PATH = '/organization/invite-member';

/**
 * D7: owner invites admin or moderator, admin invites moderator only, nobody is invited as owner,
 * one role per invite. `inviterRole` is the inviter's membership role in that workspace.
 */
export function inviteRoleAllowed(
  inviterRole: string,
  invitedRole: string,
): boolean {
  if (inviterRole === 'owner')
    return invitedRole === 'admin' || invitedRole === 'moderator';
  if (inviterRole === 'admin') return invitedRole === 'moderator';
  return false;
}

export function assertInviteRole(inviterRole: string, invitedRole: string) {
  if (inviteRoleAllowed(inviterRole, invitedRole)) return;
  throw new APIError('FORBIDDEN', {
    message:
      inviterRole === 'admin'
        ? 'Admins can invite moderators only.'
        : inviterRole === 'owner'
          ? 'Invite people as admin or moderator.'
          : 'You are not allowed to invite people to this workspace.',
    code: INVITE_ROLE_REFUSED,
  });
}

export function assertNotImpersonating(impersonatedBy: unknown) {
  if (!impersonatedBy) return;
  throw new APIError('FORBIDDEN', {
    message: 'Team changes are not allowed while impersonating.',
    code: IMPERSONATION_READ_ONLY,
  });
}

/** Plugin paths for accepting an invite and changing members (M7-T6). */
export const ACCEPT_INVITATION_PATH = '/organization/accept-invitation';
export const UPDATE_MEMBER_ROLE_PATH = '/organization/update-member-role';
export const REMOVE_MEMBER_PATH = '/organization/remove-member';
export const LEAVE_PATH = '/organization/leave';

/** Codes of the member-change 403s (D7/D11, M7-T6); the last two are the plugin's own. */
export const MEMBER_CHANGE_CODES = {
  /** The owner can't be removed, demoted or leave (D11; transfer is M7-T6b). */
  ownerProtected: 'WORKSPACE_OWNER_PROTECTED',
  update: 'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER',
  remove: 'YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER',
} as const;

export type MemberChange =
  | { action: 'update'; targetRole: string; newRoles: readonly string[] }
  | { action: 'remove'; targetRole: string }
  | { action: 'leave' };

/**
 * D7 + D11 (M7-T6): who may change whom. `actorRole` is the caller's role in that workspace.
 * - The owner can't leave, and nobody removes or re-roles the owner → `ownerProtected`.
 * - Exactly one new role, never `owner` (no promotion to owner; transfer is M7-T6b).
 * - Owner: re-role admin ↔ moderator, remove admins/moderators.
 * - Admin: moderators only (remove; "re-role" only to moderator, i.e. no promotion to admin,
 *   matching "admins invite moderators only"); not other admins, not themselves.
 * - Moderator: nothing (they may leave).
 * Returns the refusal code, or null when allowed.
 */
export function memberChangeRefusal(
  actorRole: string,
  change: MemberChange,
): string | null {
  if (change.action === 'leave')
    return actorRole === 'owner' ? MEMBER_CHANGE_CODES.ownerProtected : null;
  if (change.targetRole === 'owner') return MEMBER_CHANGE_CODES.ownerProtected;
  const code =
    change.action === 'update'
      ? MEMBER_CHANGE_CODES.update
      : MEMBER_CHANGE_CODES.remove;
  if (change.action === 'update') {
    const [role, ...rest] = change.newRoles;
    if (rest.length || (role !== 'admin' && role !== 'moderator')) return code;
    if (actorRole === 'admin' && role !== 'moderator') return code;
  }
  if (actorRole === 'owner') return null;
  if (actorRole === 'admin' && change.targetRole === 'moderator') return null;
  return code;
}

const MEMBER_CHANGE_MESSAGES: Record<string, string> = {
  [MEMBER_CHANGE_CODES.ownerProtected]:
    'The workspace owner can’t be removed, change role or leave.',
  [MEMBER_CHANGE_CODES.update]: 'You are not allowed to change this role.',
  [MEMBER_CHANGE_CODES.remove]: 'You are not allowed to remove this member.',
};

export function assertMemberChange(actorRole: string, change: MemberChange) {
  const code = memberChangeRefusal(actorRole, change);
  if (!code) return;
  throw new APIError('FORBIDDEN', {
    message: MEMBER_CHANGE_MESSAGES[code],
    code,
  });
}

/** Comma list or array (the plugin accepts both) → trimmed role names. */
export function roleList(raw: unknown): string[] | null {
  if (Array.isArray(raw)) return raw.map((r) => String(r).trim());
  if (typeof raw === 'string') return raw.split(',').map((r) => r.trim());
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && UUID.test(v);

/** Codes of the sign-up-from-invite refusals (D8, M7-T6); the last two are the plugin's own. */
export const SIGN_UP_INVITE_CODES = {
  /** 400: both `workspaceName` and `invitationId`. */
  both: 'WORKSPACE_NAME_WITH_INVITATION',
  /** 400: unknown, malformed, not pending or expired invite. */
  notFound: 'INVITATION_NOT_FOUND',
  /** 403: the sign-up email isn't the invited one. */
  wrongEmail: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION',
} as const;

/**
 * D8: `invitationId` from the sign-up body. `undefined` = a normal sign-up; a sign-up that also
 * names a workspace → 400; a malformed id → 400 (as an unknown invite).
 */
export function signUpInvitationId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { invitationId, workspaceName } = body as Record<string, unknown>;
  if (invitationId === undefined) return undefined;
  if (workspaceName !== undefined) {
    throw new APIError('BAD_REQUEST', {
      message: 'Send either workspaceName or invitationId, not both.',
      code: SIGN_UP_INVITE_CODES.both,
    });
  }
  if (!isUuid(invitationId)) throw invitationNotFound();
  return invitationId.toLowerCase();
}

const invitationNotFound = () =>
  new APIError('BAD_REQUEST', {
    message: 'This invitation was not found, was cancelled or has expired.',
    code: SIGN_UP_INVITE_CODES.notFound,
  });

/** D8: the invite must be pending, unexpired and for exactly this email (case-insensitive). */
export function assertSignUpInvite(
  invite: { status: string; expiresAt: Date; email: string } | undefined,
  email: unknown,
  now: Date = new Date(),
): void {
  if (!invite || invite.status !== 'pending' || invite.expiresAt <= now)
    throw invitationNotFound();
  // A missing/malformed email gets Better Auth's own 400.
  if (
    typeof email === 'string' &&
    email.toLowerCase() !== invite.email.toLowerCase()
  ) {
    throw new APIError('FORBIDDEN', {
      message: 'Sign up with the email address the invitation was sent to.',
      code: SIGN_UP_INVITE_CODES.wrongEmail,
    });
  }
}

/** D9/D10: 409 when the account has no live plan or no free seat (members + pending invites). */
export function assertSeatAvailable(check: SeatCheck): void {
  if (check.kind === 'ok') return;
  if (check.kind === 'no_active_plan') {
    throw new APIError('CONFLICT', {
      message:
        'Your plan has ended, so you can’t invite people. Choose a plan first.',
      code: SEAT_ERROR_CODES.noActivePlan,
    });
  }
  throw new APIError('CONFLICT', {
    message: `Your plan has ${check.limit} seat${check.limit === 1 ? '' : 's'} and ${check.used} ${check.used === 1 ? 'is' : 'are'} used (members and pending invites). Remove someone or upgrade your plan.`,
    code: SEAT_ERROR_CODES.limitReached,
    details: { limit: check.limit, used: check.used },
  });
}

const ROLE_LABEL: Record<string, { en: string; bn: string }> = {
  admin: { en: 'an admin', bn: 'অ্যাডমিন' },
  moderator: { en: 'a moderator', bn: 'মডারেটর' },
};

/**
 * Reading 10: workspace name, inviter name and role; the CTA opens `/invite/<invitationId>` in
 * the client app (no other ids).
 */
export function invitationEmail(
  invite: {
    invitationId: string;
    workspaceName: string;
    inviterName: string;
    role: string;
  },
  clientAppUrl: string,
): EmailContent {
  const url = `${clientAppUrl.replace(/\/+$/, '')}/invite/${encodeURIComponent(invite.invitationId)}`;
  const role = ROLE_LABEL[invite.role] ?? { en: invite.role, bn: invite.role };
  const { inviterName: who, workspaceName: ws } = invite;
  return bilingualEmail(
    {
      en: {
        subject: `${who} invited you to ${ws} on ShieldComment BD`,
        lines: [
          `${who} invited you to join the workspace "${ws}" as ${role.en}.`,
          'The invitation expires in 7 days.',
        ],
        cta: { label: 'Accept invitation', url },
      },
      bn: {
        subject: `${who} আপনাকে ShieldComment BD-তে ${ws}-এ আমন্ত্রণ জানিয়েছেন`,
        lines: [
          `${who} আপনাকে "${ws}" ওয়ার্কস্পেসে ${role.bn} হিসেবে যোগ দিতে আমন্ত্রণ জানিয়েছেন।`,
          'এই আমন্ত্রণের মেয়াদ ৭ দিন।',
        ],
        cta: { label: 'আমন্ত্রণ গ্রহণ করুন', url },
      },
    },
    clientAppUrl,
  );
}

export interface InvitationMail {
  id: string;
  role: string;
  email: string;
  organization: { id: string; name: string };
  invitation: { expiresAt: Date };
  inviter: { user: { name: string } };
}

/**
 * The plugin's `sendInvitationEmail` (new invite and `resend: true`). A failed send is logged and
 * swallowed: the invite still exists and the owner/admin can resend it. The idempotency key
 * changes with each resend (new `expiresAt`), so Resend doesn't drop a resend.
 */
export function createInvitationMailer(
  email: Pick<EmailService, 'send'>,
  clientAppUrl: string,
  logger = new Logger('WorkspaceInvites'),
) {
  return async (data: InvitationMail): Promise<void> => {
    const ref = { invitationId: data.id, workspaceId: data.organization.id };
    try {
      await email.send({
        to: data.email,
        ...invitationEmail(
          {
            invitationId: data.id,
            workspaceName: data.organization.name,
            inviterName: data.inviter.user.name,
            role: data.role,
          },
          clientAppUrl,
        ),
        idempotencyKey: `workspace-invite:${data.id}:${new Date(data.invitation.expiresAt).getTime()}`,
      });
    } catch (err) {
      const reason =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      logger.warn(ref, `invitation email failed: ${reason}`);
    }
  };
}

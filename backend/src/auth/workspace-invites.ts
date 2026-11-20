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

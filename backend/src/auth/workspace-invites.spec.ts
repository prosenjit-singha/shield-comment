import { APIError } from 'better-auth';
import { EmailSendError } from '../email/email.service.js';
import {
  assertInviteRole,
  assertMemberChange,
  assertSignUpInvite,
  MEMBER_CHANGE_CODES,
  memberChangeRefusal,
  roleList,
  signUpInvitationId,
  assertNotImpersonating,
  assertSeatAvailable,
  createInvitationMailer,
  IMPERSONATION_READ_ONLY,
  INVITATION_EXPIRES_IN_SEC,
  invitationEmail,
  inviteRoleAllowed,
  TEAM_WRITE_PATHS,
} from './workspace-invites.js';

const APP = 'http://app.localhost:5174';
const INVITE_ID = '019a0000-0000-7000-8000-0000000000a1';

function thrown(fn: () => void): APIError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(APIError);
    return e as APIError;
  }
  throw new Error('expected an APIError');
}

describe('inviteRoleAllowed (D7)', () => {
  it.each([
    ['owner', 'admin', true],
    ['owner', 'moderator', true],
    ['owner', 'owner', false],
    ['admin', 'moderator', true],
    ['admin', 'admin', false],
    ['admin', 'owner', false],
    ['moderator', 'moderator', false],
    ['moderator', 'admin', false],
    ['owner', 'member', false],
    ['owner', '', false],
  ])('%s invites %s → %s', (inviter, invited, allowed) => {
    expect(inviteRoleAllowed(inviter, invited)).toBe(allowed);
  });

  it('refusal → 403 with the plugin code', () => {
    const error = thrown(() => assertInviteRole('admin', 'admin'));
    expect(error.statusCode).toBe(403);
    expect(error.body).toMatchObject({
      code: 'YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE',
      message: 'Admins can invite moderators only.',
    });
    expect(() => assertInviteRole('owner', 'admin')).not.toThrow();
  });
});

describe('assertNotImpersonating (D2)', () => {
  it('impersonated → 403 IMPERSONATION_READ_ONLY; otherwise passes', () => {
    const error = thrown(() => assertNotImpersonating('admin-user-id'));
    expect(error.statusCode).toBe(403);
    expect(error.body?.code).toBe(IMPERSONATION_READ_ONLY);
    expect(() => assertNotImpersonating(null)).not.toThrow();
    expect(() => assertNotImpersonating(undefined)).not.toThrow();
  });

  it('covers the team writes, not the reads', () => {
    expect(TEAM_WRITE_PATHS.has('/organization/invite-member')).toBe(true);
    expect(TEAM_WRITE_PATHS.has('/organization/cancel-invitation')).toBe(true);
    expect(TEAM_WRITE_PATHS.has('/organization/list-invitations')).toBe(false);
  });
});

describe('assertSeatAvailable (D9/D10)', () => {
  it('ok passes', () => {
    expect(() =>
      assertSeatAvailable({ kind: 'ok', limit: 3, used: 2 }),
    ).not.toThrow();
  });

  it('limit_reached → 409 SEAT_LIMIT_REACHED + details { limit, used }', () => {
    const error = thrown(() =>
      assertSeatAvailable({ kind: 'limit_reached', limit: 1, used: 1 }),
    );
    expect(error.statusCode).toBe(409);
    expect(error.body).toMatchObject({
      code: 'SEAT_LIMIT_REACHED',
      details: { limit: 1, used: 1 },
    });
    expect(error.body?.message).toMatch(/1 seat and 1 is used/);
  });

  it('no_active_plan → 409 NO_ACTIVE_PLAN, no details', () => {
    const error = thrown(() =>
      assertSeatAvailable({ kind: 'no_active_plan', used: 1 }),
    );
    expect(error.statusCode).toBe(409);
    expect(error.body?.code).toBe('NO_ACTIVE_PLAN');
    expect(error.body).not.toHaveProperty('details');
  });
});

describe('invitationEmail (reading 10)', () => {
  const content = invitationEmail(
    {
      invitationId: INVITE_ID,
      workspaceName: 'Rina <Shop>',
      inviterName: 'Rina',
      role: 'moderator',
    },
    `${APP}/`,
  );

  it('7-day links', () => {
    expect(INVITATION_EXPIRES_IN_SEC).toBe(604_800);
  });

  it('English then Bangla subject with workspace and inviter', () => {
    expect(content.subject).toBe(
      'Rina invited you to Rina <Shop> on ShieldComment BD · Rina আপনাকে ShieldComment BD-তে Rina <Shop>-এ আমন্ত্রণ জানিয়েছেন',
    );
  });

  it('en + bn body with the role, CTA /invite/<id>, escaped HTML', () => {
    expect(content.text).toContain(
      'Rina invited you to join the workspace "Rina <Shop>" as a moderator.',
    );
    expect(content.text).toContain('মডারেটর হিসেবে যোগ দিতে');
    expect(content.text).toContain(
      `Accept invitation: ${APP}/invite/${INVITE_ID}`,
    );
    expect(content.text).toContain(
      `আমন্ত্রণ গ্রহণ করুন: ${APP}/invite/${INVITE_ID}`,
    );
    expect(content.text.indexOf('Accept invitation')).toBeLessThan(
      content.text.indexOf('আমন্ত্রণ গ্রহণ করুন'),
    );
    expect(content.html).toContain(`href="${APP}/invite/${INVITE_ID}"`);
    expect(content.html).toContain('Rina &lt;Shop&gt;');
    expect(content.html).not.toContain('<Shop>');
  });

  it('admin role label', () => {
    const admin = invitationEmail(
      {
        invitationId: INVITE_ID,
        workspaceName: 'W',
        inviterName: 'I',
        role: 'admin',
      },
      APP,
    );
    expect(admin.text).toContain('as an admin.');
    expect(admin.text).toContain('অ্যাডমিন হিসেবে');
  });
});

describe('createInvitationMailer', () => {
  const data = {
    id: INVITE_ID,
    role: 'admin',
    email: 'new@example.com',
    organization: { id: 'ws-1', name: 'Shop' },
    invitation: { expiresAt: new Date('2026-11-27T00:00:00Z') },
    inviter: { user: { name: 'Owner' } },
  };
  const logger = () => ({ warn: vi.fn() });

  it('sends one email to the invitee with a key that changes per resend', async () => {
    const send = vi.fn().mockResolvedValue({ delivered: true, id: 'e1' });
    const log = logger();
    await createInvitationMailer({ send }, APP, log as never)(data);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      to: 'new@example.com',
      idempotencyKey: `workspace-invite:${INVITE_ID}:${Date.parse('2026-11-27T00:00:00Z')}`,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a failed send is logged without the recipient and never throws', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new EmailSendError('Resend 503', 503, true));
    const log = logger();
    await expect(
      createInvitationMailer({ send }, APP, log as never)(data),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [ref, msg] = log.warn.mock.calls[0]!;
    expect(ref).toEqual({ invitationId: INVITE_ID, workspaceId: 'ws-1' });
    expect(JSON.stringify([ref, msg])).not.toContain('new@example.com');
  });
});

describe('memberChangeRefusal (D7 + D11, M7-T6)', () => {
  const OWNER = MEMBER_CHANGE_CODES.ownerProtected;
  const UPD = MEMBER_CHANGE_CODES.update;
  const DEL = MEMBER_CHANGE_CODES.remove;

  it.each([
    // actor, target, new role → refusal
    ['owner', 'admin', 'moderator', null],
    ['owner', 'moderator', 'admin', null],
    ['owner', 'admin', 'owner', UPD],
    ['owner', 'moderator', 'owner', UPD],
    ['owner', 'owner', 'admin', OWNER],
    ['owner', 'admin', 'admin,moderator', UPD],
    ['owner', 'admin', 'member', UPD],
    ['admin', 'moderator', 'moderator', null],
    ['admin', 'moderator', 'admin', UPD],
    ['admin', 'admin', 'moderator', UPD],
    ['admin', 'owner', 'admin', OWNER],
    ['admin', 'moderator', 'owner', UPD],
    ['moderator', 'moderator', 'moderator', UPD],
    ['moderator', 'admin', 'moderator', UPD],
  ])('update: %s changes %s → %s = %s', (actor, target, role, code) => {
    expect(
      memberChangeRefusal(actor, {
        action: 'update',
        targetRole: target,
        newRoles: roleList(role)!,
      }),
    ).toBe(code);
  });

  it.each([
    ['owner', 'admin', null],
    ['owner', 'moderator', null],
    ['owner', 'owner', OWNER],
    ['admin', 'moderator', null],
    ['admin', 'admin', DEL],
    ['admin', 'owner', OWNER],
    ['moderator', 'moderator', DEL],
    ['moderator', 'admin', DEL],
  ])('remove: %s removes %s = %s', (actor, target, code) => {
    expect(
      memberChangeRefusal(actor, { action: 'remove', targetRole: target }),
    ).toBe(code);
  });

  it.each([
    ['owner', OWNER],
    ['admin', null],
    ['moderator', null],
  ])('leave: %s = %s', (actor, code) => {
    expect(memberChangeRefusal(actor, { action: 'leave' })).toBe(code);
  });

  it('assertMemberChange → 403 with the code', () => {
    const error = thrown(() =>
      assertMemberChange('owner', { action: 'leave' }),
    );
    expect(error.statusCode).toBe(403);
    expect(error.body?.code).toBe('WORKSPACE_OWNER_PROTECTED');
    expect(() =>
      assertMemberChange('owner', { action: 'remove', targetRole: 'admin' }),
    ).not.toThrow();
  });
});

describe('sign-up from an invite (D8, M7-T6)', () => {
  const ID = '019A0000-0000-7000-8000-0000000000B1';
  const live = {
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    email: 'rina@example.com',
  };

  it('signUpInvitationId: absent → undefined; valid → lower-cased id', () => {
    expect(signUpInvitationId({ email: 'a@b.c' })).toBeUndefined();
    expect(signUpInvitationId({ workspaceName: 'Shop' })).toBeUndefined();
    expect(signUpInvitationId(undefined)).toBeUndefined();
    expect(signUpInvitationId({ invitationId: ID })).toBe(ID.toLowerCase());
  });

  it('signUpInvitationId: with workspaceName → 400; malformed → 400 INVITATION_NOT_FOUND', () => {
    const both = thrown(() =>
      signUpInvitationId({ invitationId: ID, workspaceName: 'Shop' }),
    );
    expect(both.statusCode).toBe(400);
    expect(both.body?.code).toBe('WORKSPACE_NAME_WITH_INVITATION');
    for (const invitationId of ['nope', 42, null, '']) {
      const bad = thrown(() => signUpInvitationId({ invitationId }));
      expect(bad.statusCode).toBe(400);
      expect(bad.body?.code).toBe('INVITATION_NOT_FOUND');
    }
  });

  it('assertSignUpInvite: live + same email (any case) passes', () => {
    expect(() => assertSignUpInvite(live, 'Rina@Example.com')).not.toThrow();
    // Malformed email: Better Auth's own 400 answers.
    expect(() => assertSignUpInvite(live, undefined)).not.toThrow();
  });

  it('assertSignUpInvite: missing, cancelled, accepted or expired → 400; other email → 403', () => {
    for (const invite of [
      undefined,
      { ...live, status: 'canceled' },
      { ...live, status: 'accepted' },
      { ...live, expiresAt: new Date(Date.now() - 1) },
    ]) {
      const e = thrown(() => assertSignUpInvite(invite, live.email));
      expect(e.statusCode).toBe(400);
      expect(e.body?.code).toBe('INVITATION_NOT_FOUND');
    }
    const wrong = thrown(() => assertSignUpInvite(live, 'other@example.com'));
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body?.code).toBe(
      'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION',
    );
  });
});

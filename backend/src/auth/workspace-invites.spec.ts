import { APIError } from 'better-auth';
import { EmailSendError } from '../email/email.service.js';
import {
  assertInviteRole,
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

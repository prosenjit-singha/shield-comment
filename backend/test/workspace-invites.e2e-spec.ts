import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { LimitService } from '../src/billing/limit.service.js';
import { workspaceInvitations } from '../src/db/schema/index.js';
import { EmailService, EmailSendError } from '../src/email/email.service.js';
import {
  type Actor,
  createAuthActors,
  TRUSTED_ORIGIN,
} from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import {
  createEmailServiceFake,
  type FakeEmailService,
} from './utils/fake-email.js';

const CLIENT_APP_URL = 'http://app.localhost:5174';
const DAY_MS = 24 * 3_600_000;

/**
 * M7-T5 (Module 7 D2, D7, D9, D10): invites through the Better Auth organization endpoints, the
 * role rules, pooled seats (members + pending unexpired invites) and the invitation email.
 */
describe('Workspace invites (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let email: FakeEmailService;
  let limits: LimitService;
  let seq = 0;

  const newEmail = (tag: string) =>
    `m7t5-${tag}-${Date.now()}-${++seq}@example.com`;
  const invite = (
    actor: Actor,
    body: { email: string; role: string; resend?: boolean },
    workspaceId = actor.workspaceId,
  ) =>
    actors
      .http()
      .post('/api/auth/organization/invite-member')
      .set('Cookie', actor.cookie)
      .set('Origin', TRUSTED_ORIGIN)
      .send({ ...body, organizationId: workspaceId });
  const cancel = (actor: Actor, invitationId: string) =>
    actors
      .http()
      .post('/api/auth/organization/cancel-invitation')
      .set('Cookie', actor.cookie)
      .set('Origin', TRUSTED_ORIGIN)
      .send({ invitationId });
  const invitationsOf = (workspaceId: string) =>
    actors.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.workspaceId, workspaceId));
  const statusOf = async (id: string) =>
    (
      await actors.db
        .select({ status: workspaceInvitations.status })
        .from(workspaceInvitations)
        .where(eq(workspaceInvitations.id, id))
    )[0]?.status;

  /** A Growth (3 seats) owner. */
  const growthOwner = async (tag: string) => {
    const owner = await actors.signUp(`m7t5-${tag}`);
    await actors.activatePlan(owner, 'growth');
    return owner;
  };

  beforeAll(async () => {
    email = createEmailServiceFake();
    app = await createTestApp((b) =>
      b.overrideProvider(EmailService).useValue(email),
    );
    actors = createAuthActors(app);
    limits = app.get(LimitService);
  });

  afterEach(() => {
    expect(email.unexpected).toEqual([]);
    expect(email.pending).toBe(0);
    email.reset();
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('owner invites a moderator → 200, 7-day pending invite, exactly one bilingual email with /invite/<id>', async () => {
    const owner = await growthOwner('owner');
    const to = newEmail('mod');
    email.expectSends(1);
    const res = await invite(owner, { email: to, role: 'moderator' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const id = res.body.id as string;
    expect(res.body).toMatchObject({
      email: to,
      role: 'moderator',
      status: 'pending',
    });
    const expiresIn = Date.parse(res.body.expiresAt as string) - Date.now();
    expect(expiresIn).toBeGreaterThan(7 * DAY_MS - 60_000);
    expect(expiresIn).toBeLessThanOrEqual(7 * DAY_MS);

    expect(email.sent).toHaveLength(1);
    const [sent] = email.sent;
    expect(sent!.to).toBe(to);
    expect(sent!.subject).toContain('invited you to');
    expect(sent!.subject).toContain('আমন্ত্রণ');
    expect(sent!.text).toContain(`${CLIENT_APP_URL}/invite/${id}`);
    expect(sent!.text).toContain('as a moderator');
    expect(sent!.idempotencyKey).toMatch(
      new RegExp(`^workspace-invite:${id}:`),
    );
    // No other ids in the email (owner, workspace).
    expect(sent!.text).not.toContain(owner.id);
    expect(sent!.text).not.toContain(owner.workspaceId);
  });

  it('role rules (D7): moderator 403; admin → admin 403, → moderator 200; owner → owner 403', async () => {
    const owner = await growthOwner('roles');
    const admin = await actors.signUp('m7t5-roles-admin');
    const mod = await actors.signUp('m7t5-roles-mod');
    await actors.addMember(owner.workspaceId, admin.id, 'admin');
    await actors.addMember(owner.workspaceId, mod.id, 'moderator');

    const byMod = await invite(
      mod,
      { email: newEmail('x'), role: 'moderator' },
      owner.workspaceId,
    );
    expect(byMod.status).toBe(403);

    const adminAdmin = await invite(
      admin,
      { email: newEmail('x'), role: 'admin' },
      owner.workspaceId,
    );
    expect(adminAdmin.status).toBe(403);
    expect(adminAdmin.body.code).toBe(
      'YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE',
    );

    const ownerOwner = await invite(owner, {
      email: newEmail('x'),
      role: 'owner',
    });
    expect(ownerOwner.status).toBe(403);
    const multi = await invite(owner, {
      email: newEmail('x'),
      role: 'admin,moderator',
    });
    expect(multi.status).toBe(403);
    expect(await invitationsOf(owner.workspaceId)).toEqual([]);

    // 3 seats: owner + admin + mod are full, so the allowed role still hits the seat limit.
    const full = await invite(
      admin,
      { email: newEmail('x'), role: 'moderator' },
      owner.workspaceId,
    );
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({
      code: 'SEAT_LIMIT_REACHED',
      details: { limit: 3, used: 3 },
    });

    await actors.activatePlan(owner, 'pro');
    email.expectSends(1);
    const ok = await invite(
      admin,
      { email: newEmail('x'), role: 'moderator' },
      owner.workspaceId,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('Starter (1 seat) is owner-only → 409 SEAT_LIMIT_REACHED { limit 1, used 1 }, nothing created', async () => {
    const owner = await actors.signUp('m7t5-starter', { trial: true });
    const res = await invite(owner, {
      email: newEmail('s'),
      role: 'moderator',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'SEAT_LIMIT_REACHED',
      details: { limit: 1, used: 1 },
    });
    expect(await invitationsOf(owner.workspaceId)).toEqual([]);
  });

  it('no live plan → 409 NO_ACTIVE_PLAN', async () => {
    const owner = await growthOwner('ended');
    await actors.expirePlan(owner);
    const res = await invite(owner, {
      email: newEmail('e'),
      role: 'moderator',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_ACTIVE_PLAN');
  });

  it('Growth (3): pending invites take seats, pooled across workspaces; an expired one does not', async () => {
    const owner = await growthOwner('pool');
    const account = await actors.accountIdOf(owner);
    const second = await actors
      .http()
      .post('/api/auth/organization/create')
      .set('Cookie', owner.cookie)
      .set('Origin', TRUSTED_ORIGIN)
      .send({ name: 'M7T5 second', slug: `m7t5-${Date.now()}` })
      .expect(200);
    actors.trackWorkspace(second.body.id as string);

    email.expectSends(2);
    const a = await invite(owner, { email: newEmail('a'), role: 'admin' });
    expect(a.status).toBe(200);
    expect(await limits.seatsLeft(account)).toBe(1);
    const b = await invite(
      owner,
      { email: newEmail('b'), role: 'moderator' },
      second.body.id as string,
    );
    expect(b.status).toBe(200);
    expect(await limits.seatsLeft(account)).toBe(0);

    const c = newEmail('c');
    const refused = await invite(owner, { email: c, role: 'moderator' });
    expect(refused.status).toBe(409);
    expect(refused.body.details).toEqual({ limit: 3, used: 3 });

    await actors.db
      .update(workspaceInvitations)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceInvitations.id, a.body.id as string));
    expect(await limits.seatsLeft(account)).toBe(1);
    email.expectSends(1);
    expect((await invite(owner, { email: c, role: 'moderator' })).status).toBe(
      200,
    );
  });

  it('re-invite cancels the older pending invite (and reuses its seat); resend keeps the id and emails again', async () => {
    const owner = await growthOwner('reinvite');
    const to = newEmail('re');
    email.expectSends(2);
    const first = await invite(owner, { email: to, role: 'moderator' });
    expect(
      (await invite(owner, { email: newEmail('fill'), role: 'moderator' }))
        .status,
    ).toBe(200);
    // Seats full (owner + 2 pending); re-inviting `to` frees its old seat first.
    email.expectSends(1);
    const second = await invite(owner, { email: to, role: 'admin' });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.id).not.toBe(first.body.id);
    expect(await statusOf(first.body.id as string)).toBe('canceled');
    expect(await statusOf(second.body.id as string)).toBe('pending');

    email.expectSends(1);
    const resent = await invite(owner, {
      email: to,
      role: 'admin',
      resend: true,
    });
    expect(resent.status).toBe(200);
    expect(resent.body.id).toBe(second.body.id);
    const keys = email.sent.map((m) => m.idempotencyKey);
    expect(email.sent.at(-1)!.text).toContain(`/invite/${second.body.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a failed email is logged only: the invite exists and can be resent', async () => {
    const owner = await growthOwner('mailfail');
    email.failNext(new EmailSendError('Resend 503', 503, true));
    const res = await invite(owner, {
      email: newEmail('f'),
      role: 'moderator',
    });
    expect(res.status).toBe(200);
    expect(await statusOf(res.body.id as string)).toBe('pending');
    expect(email.sent).toHaveLength(0);
  });

  it('inviting an existing member → the plugin’s own 400', async () => {
    const owner = await growthOwner('member');
    const mod = await actors.signUp('m7t5-member-mod');
    await actors.addMember(owner.workspaceId, mod.id, 'moderator');
    const res = await invite(owner, { email: mod.email, role: 'moderator' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION');
  });

  it('cancel: admin may cancel a pending invite, a moderator may not', async () => {
    const owner = await growthOwner('cancel');
    const admin = await actors.signUp('m7t5-cancel-admin');
    const mod = await actors.signUp('m7t5-cancel-mod');
    await actors.addMember(owner.workspaceId, admin.id, 'admin');
    await actors.addMember(owner.workspaceId, mod.id, 'moderator');
    await actors.activatePlan(owner, 'pro');
    email.expectSends(1);
    const inv = await invite(owner, { email: newEmail('c'), role: 'admin' });
    expect(inv.status).toBe(200);
    expect((await cancel(mod, inv.body.id as string)).status).toBe(403);
    expect(await statusOf(inv.body.id as string)).toBe('pending');
    expect((await cancel(admin, inv.body.id as string)).status).toBe(200);
    expect(await statusOf(inv.body.id as string)).toBe('canceled');
  });

  it('impersonated sessions (D2): invite, resend and cancel → 403 IMPERSONATION_READ_ONLY', async () => {
    const superAdmin = await actors.signUpSuperAdmin('m7t5-super');
    const owner = await growthOwner('imp');
    email.expectSends(1);
    const to = newEmail('imp');
    const inv = await invite(owner, { email: to, role: 'moderator' });
    expect(inv.status).toBe(200);

    const cookie = await actors.signIn(owner.email);
    await actors.patchStoredSession(cookie, {
      impersonatedBy: superAdmin.id,
      activeOrganizationId: owner.workspaceId,
    });
    const as = { ...owner, cookie };
    for (const res of [
      await invite(as, { email: newEmail('imp2'), role: 'moderator' }),
      await invite(as, { email: to, role: 'moderator', resend: true }),
      await cancel(as, inv.body.id as string),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('IMPERSONATION_READ_ONLY');
    }
    expect(await invitationsOf(owner.workspaceId)).toHaveLength(1);
    expect(await statusOf(inv.body.id as string)).toBe('pending');
  });
});

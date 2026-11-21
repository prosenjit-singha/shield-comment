import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  billingAccounts,
  workspaceInvitations,
  workspaceMembers,
} from '../src/db/schema/index.js';
import { EmailService } from '../src/email/email.service.js';
import {
  type Actor,
  createAuthActors,
  PASSWORD,
  sessionCookie,
  TRUSTED_ORIGIN,
} from './utils/auth-actors.js';
import { createTestApp, uniqueEmail } from './utils/create-test-app.js';
import {
  createEmailServiceFake,
  type FakeEmailService,
  linkToken,
} from './utils/fake-email.js';

/**
 * M7-T6 (Module 7 D2, D7, D8, D9, D10, D11, M7-D18): sign-up from an invite, accept (seat
 * re-check, active workspace), member role changes / removal / leave through the Better Auth
 * organization endpoints, and `GET /api/workspaces/:workspaceId/team`.
 */
describe('Team members (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let email: FakeEmailService;

  const post = (path: string, cookie: string, body: object) =>
    actors
      .http()
      .post(`/api/auth/organization/${path}`)
      .set('Cookie', cookie)
      .set('Origin', TRUSTED_ORIGIN)
      .send(body);
  const invite = async (owner: Actor, to: string, role = 'moderator') => {
    email.expectSends(1);
    const res = await post('invite-member', owner.cookie, {
      email: to,
      role,
      organizationId: owner.workspaceId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.id as string;
  };
  const accept = (cookie: string, invitationId: string) =>
    post('accept-invitation', cookie, { invitationId });
  const signUpFromInvite = (to: string, invitationId: string, extra = {}) =>
    actors
      .http()
      .post('/api/auth/sign-up/email')
      .send({
        name: 'Invitee',
        email: to,
        password: PASSWORD,
        invitationId,
        ...extra,
      });
  const team = (cookie: string, workspaceId: string) =>
    actors
      .http()
      .get(`/api/workspaces/${workspaceId}/team`)
      .set('Cookie', cookie);
  const memberOf = async (userId: string, workspaceId: string) =>
    (
      await actors.db
        .select({ id: workspaceMembers.id, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, workspaceId),
          ),
        )
    )[0];
  const roleOf = async (userId: string, workspaceId: string) =>
    (await memberOf(userId, workspaceId))?.role;
  const memberIdOf = async (userId: string, workspaceId: string) =>
    (await memberOf(userId, workspaceId))!.id;
  const statusOf = async (id: string) =>
    (
      await actors.db
        .select({ status: workspaceInvitations.status })
        .from(workspaceInvitations)
        .where(eq(workspaceInvitations.id, id))
    )[0]?.status;
  const activeWorkspace = async (cookie: string) =>
    (
      await actors
        .http()
        .get('/api/auth/get-session')
        .set('Cookie', cookie)
        .expect(200)
    ).body.session.activeOrganizationId as string | null;

  const growthOwner = async (tag: string) => {
    const owner = await actors.signUp(`m7t6-${tag}`);
    await actors.activatePlan(owner, 'growth');
    return owner;
  };
  /** A Pro owner with an admin and a moderator. */
  const teamOf = async (tag: string) => {
    const owner = await actors.signUp(`m7t6-${tag}`);
    await actors.activatePlan(owner, 'pro');
    const admin = await actors.signUp(`m7t6-${tag}-admin`);
    const admin2 = await actors.signUp(`m7t6-${tag}-admin2`);
    const mod = await actors.signUp(`m7t6-${tag}-mod`);
    await actors.addMember(owner.workspaceId, admin.id, 'admin');
    await actors.addMember(owner.workspaceId, admin2.id, 'admin');
    await actors.addMember(owner.workspaceId, mod.id, 'moderator');
    return { owner, admin, admin2, mod };
  };

  beforeAll(async () => {
    email = createEmailServiceFake();
    app = await createTestApp((b) =>
      b.overrideProvider(EmailService).useValue(email),
    );
    actors = createAuthActors(app);
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

  it('sign up from an invite (D8): no own workspace, billing account or trial → accept → member + active workspace (cookie cache refreshed)', async () => {
    const owner = await growthOwner('signup');
    const to = uniqueEmail('m7t6-invitee');
    const id = await invite(owner, to, 'admin');

    email.expectSends(1); // verification (M9-T5)
    const res = await signUpFromInvite(to.toUpperCase(), id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const userId = res.body.user.id as string;
    actors.trackUser(userId);
    expect(
      await actors.db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId)),
    ).toEqual([]);
    expect(
      await actors.db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.ownerUserId, userId)),
    ).toEqual([]);
    // The emailed link verifies and signs in (M9-T5).
    const verified = await actors
      .http()
      .get('/api/auth/verify-email')
      .query({ token: linkToken(email.sent.at(-1)!, '/verify-email') })
      .expect(200);
    const token = sessionCookie(verified);
    expect(await activeWorkspace(token)).toBeNull();

    // Full cookie jar (token + 5-min cookie cache) like a browser.
    const jar = (r: { headers: Record<string, unknown> }) =>
      (r.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]!);
    const signUpCookies = jar(verified);
    const accepted = await accept(signUpCookies.join('; '), id);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.member).toMatchObject({
      userId,
      role: 'admin',
      organizationId: owner.workspaceId,
    });
    expect(await statusOf(id)).toBe('accepted');
    expect(await activeWorkspace(token)).toBe(owner.workspaceId);
    const cache = jar(accepted).find((c) =>
      c.startsWith('better-auth.session_data='),
    );
    expect(cache, 'refreshed cookie cache').toBeDefined();
    expect(await activeWorkspace(`${token}; ${cache}`)).toBe(owner.workspaceId);
  });

  it('existing user logs in → accept → member; the invited workspace becomes active', async () => {
    const owner = await growthOwner('login');
    const user = await actors.signUp('m7t6-login-user');
    const id = await invite(owner, user.email);
    expect(await activeWorkspace(user.cookie)).toBe(user.workspaceId);
    const res = await accept(user.cookie, id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await roleOf(user.id, owner.workspaceId)).toBe('moderator');
    expect(await activeWorkspace(user.cookie)).toBe(owner.workspaceId);
  });

  it('wrong email: sign-up 403, accept 403 (plugin code); both workspaceName + invitationId 400', async () => {
    const owner = await growthOwner('wrong');
    const id = await invite(owner, uniqueEmail('m7t6-right'));
    const signUp = await signUpFromInvite(uniqueEmail('m7t6-other'), id);
    expect(signUp.status).toBe(403);
    expect(signUp.body.code).toBe(
      'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION',
    );
    const both = await signUpFromInvite(uniqueEmail('m7t6-both'), id, {
      workspaceName: 'Shop',
    });
    expect(both.status).toBe(400);
    expect(both.body.code).toBe('WORKSPACE_NAME_WITH_INVITATION');

    const other = await actors.signUp('m7t6-wrong-other');
    const res = await accept(other.cookie, id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION');
    expect(await statusOf(id)).toBe('pending');
  });

  it('expired or cancelled invite: sign-up and accept → 400 INVITATION_NOT_FOUND', async () => {
    const owner = await growthOwner('stale');
    const user = await actors.signUp('m7t6-stale-user');
    const toNew = uniqueEmail('m7t6-stale-new');
    const expired = await invite(owner, toNew);
    await actors.db
      .update(workspaceInvitations)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceInvitations.id, expired));
    const cancelled = await invite(owner, user.email);
    expect(
      (
        await post('cancel-invitation', owner.cookie, {
          invitationId: cancelled,
        })
      ).status,
    ).toBe(200);

    const signUp = await signUpFromInvite(toNew, expired);
    expect(signUp.status).toBe(400);
    expect(signUp.body.code).toBe('INVITATION_NOT_FOUND');
    const malformed = await signUpFromInvite(toNew, 'not-an-id');
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('INVITATION_NOT_FOUND');
    const res = await accept(user.cookie, cancelled);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVITATION_NOT_FOUND');
  });

  it('seats at accept (D9/D10): Growth with the invite counted passes; over the limit after a downgrade → 409; no plan → 409 NO_ACTIVE_PLAN', async () => {
    const owner = await growthOwner('seats');
    const a = await actors.signUp('m7t6-seats-a');
    const b = await actors.signUp('m7t6-seats-b');
    const c = await actors.signUp('m7t6-seats-c');
    const idA = await invite(owner, a.email);
    const idB = await invite(owner, b.email);
    // Owner + 2 pending = 3 of 3: accepting one keeps 3.
    const okA = await accept(a.cookie, idA);
    expect(okA.status, JSON.stringify(okA.body)).toBe(200);

    await actors.activatePlan(owner, 'starter');
    const refused = await accept(b.cookie, idB);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'SEAT_LIMIT_REACHED',
      details: { limit: 1, used: 3 },
    });
    expect(await statusOf(idB)).toBe('pending');
    expect(await roleOf(b.id, owner.workspaceId)).toBeUndefined();

    await actors.activatePlan(owner, 'pro');
    const idC = await invite(owner, c.email);
    await actors.expirePlan(owner);
    const noPlan = await accept(c.cookie, idC);
    expect(noPlan.status).toBe(409);
    expect(noPlan.body.code).toBe('NO_ACTIVE_PLAN');
  });

  it('owner protection (D11): the owner can’t be removed, demoted or leave; nobody is made owner', async () => {
    const { owner, admin } = await teamOf('owner');
    const ownerMember = await memberIdOf(owner.id, owner.workspaceId);
    const adminMember = await memberIdOf(admin.id, owner.workspaceId);
    const ws = owner.workspaceId;
    for (const [res, code] of [
      [
        await post('remove-member', admin.cookie, {
          memberIdOrEmail: ownerMember,
          organizationId: ws,
        }),
        'WORKSPACE_OWNER_PROTECTED',
      ],
      [
        await post('remove-member', admin.cookie, {
          memberIdOrEmail: owner.email,
          organizationId: ws,
        }),
        'WORKSPACE_OWNER_PROTECTED',
      ],
      [
        await post('update-member-role', owner.cookie, {
          memberId: ownerMember,
          role: 'admin',
          organizationId: ws,
        }),
        'WORKSPACE_OWNER_PROTECTED',
      ],
      [
        await post('leave', owner.cookie, { organizationId: ws }),
        'WORKSPACE_OWNER_PROTECTED',
      ],
      [
        await post('update-member-role', owner.cookie, {
          memberId: adminMember,
          role: 'owner',
          organizationId: ws,
        }),
        'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER',
      ],
    ] as const) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.code).toBe(code);
    }
    expect(await roleOf(owner.id, ws)).toBe('owner');
    expect(await roleOf(admin.id, ws)).toBe('admin');
  });

  it('roles (D7): admin can’t remove/demote an admin or promote a moderator, can remove a moderator; owner can demote and remove an admin; moderator can’t; anyone else may leave', async () => {
    const { owner, admin, admin2, mod } = await teamOf('roles');
    const ws = owner.workspaceId;
    const admin2Member = await memberIdOf(admin2.id, ws);
    const modMember = await memberIdOf(mod.id, ws);

    const adminRemovesAdmin = await post('remove-member', admin.cookie, {
      memberIdOrEmail: admin2Member,
      organizationId: ws,
    });
    expect(adminRemovesAdmin.status).toBe(403);
    expect(adminRemovesAdmin.body.code).toBe(
      'YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER',
    );
    for (const body of [
      { memberId: admin2Member, role: 'moderator' },
      { memberId: modMember, role: 'admin' },
    ]) {
      const res = await post('update-member-role', admin.cookie, {
        ...body,
        organizationId: ws,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER');
    }
    const modRemoves = await post('remove-member', mod.cookie, {
      memberIdOrEmail: admin2Member,
      organizationId: ws,
    });
    expect(modRemoves.status).toBe(403);

    const demote = await post('update-member-role', owner.cookie, {
      memberId: admin2Member,
      role: 'moderator',
      organizationId: ws,
    });
    expect(demote.status, JSON.stringify(demote.body)).toBe(200);
    expect(await roleOf(admin2.id, ws)).toBe('moderator');

    const adminRemovesMod = await post('remove-member', admin.cookie, {
      memberIdOrEmail: modMember,
      organizationId: ws,
    });
    expect(adminRemovesMod.status, JSON.stringify(adminRemovesMod.body)).toBe(
      200,
    );
    expect(await roleOf(mod.id, ws)).toBeUndefined();

    const ownerRemovesAdmin = await post('remove-member', owner.cookie, {
      memberIdOrEmail: admin.email,
      organizationId: ws,
    });
    expect(ownerRemovesAdmin.status).toBe(200);
    expect(await roleOf(admin.id, ws)).toBeUndefined();
    // Reading 6: the removed admin loses access on the next request.
    expect((await team(admin.cookie, ws)).status).toBe(404);

    const leave = await post('leave', admin2.cookie, { organizationId: ws });
    expect(leave.status, JSON.stringify(leave.body)).toBe(200);
    expect(await roleOf(admin2.id, ws)).toBeUndefined();
  });

  it('impersonated (D2): accept, role change and remove → 403 IMPERSONATION_READ_ONLY; the team route still reads', async () => {
    const superAdmin = await actors.signUpSuperAdmin('m7t6-super');
    const { owner, mod } = await teamOf('imp');
    const user = await actors.signUp('m7t6-imp-user');
    const id = await invite(owner, user.email);
    const ws = owner.workspaceId;
    const modMember = await memberIdOf(mod.id, ws);

    const ownerImp = await actors.signIn(owner.email);
    await actors.patchStoredSession(ownerImp, {
      impersonatedBy: superAdmin.id,
      activeOrganizationId: ws,
    });
    const userImp = await actors.signIn(user.email);
    await actors.patchStoredSession(userImp, {
      impersonatedBy: superAdmin.id,
      activeOrganizationId: user.workspaceId,
    });
    for (const res of [
      await accept(userImp, id),
      await post('update-member-role', ownerImp, {
        memberId: modMember,
        role: 'admin',
        organizationId: ws,
      }),
      await post('remove-member', ownerImp, {
        memberIdOrEmail: modMember,
        organizationId: ws,
      }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('IMPERSONATION_READ_ONLY');
    }
    expect(await statusOf(id)).toBe('pending');
    expect(await roleOf(mod.id, ws)).toBe('moderator');
    expect((await team(ownerImp, ws)).status).toBe(200);
  });

  it('GET /team: members (owner first), pending unexpired invites, seats; every member reads it; non-member 404', async () => {
    const { owner, admin, admin2, mod } = await teamOf('read');
    const ws = owner.workspaceId;
    const to = uniqueEmail('m7t6-read-inv');
    const pending = await invite(owner, to, 'admin');
    const old = await invite(owner, uniqueEmail('m7t6-read-old'));
    await actors.db
      .update(workspaceInvitations)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceInvitations.id, old));

    for (const who of [owner, admin, mod]) {
      const res = await team(who.cookie, ws);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.body.members.map((m: { userId: string }) => m.userId)).toEqual(
        [owner.id, admin.id, admin2.id, mod.id],
      );
      expect(res.body.members[0]).toEqual({
        memberId: await memberIdOf(owner.id, ws),
        userId: owner.id,
        name: 'm7t6-read',
        email: owner.email,
        role: 'owner',
        joinedAt: expect.any(String),
      });
      expect(res.body.invitations).toEqual([
        {
          id: pending,
          email: to,
          role: 'admin',
          expiresAt: expect.any(String),
          inviterName: 'm7t6-read',
        },
      ]);
      // Pro: 10 seats; owner + 3 members + 1 pending.
      expect(res.body.seats).toEqual({ used: 5, limit: 10 });
    }

    await actors.expirePlan(owner);
    expect((await team(owner.cookie, ws)).body.seats).toEqual({
      used: 5,
      limit: null,
    });
    const stranger = await actors.signUp('m7t6-read-stranger');
    expect((await team(stranger.cookie, ws)).status).toBe(404);
  });
});

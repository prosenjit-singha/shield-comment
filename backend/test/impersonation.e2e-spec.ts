import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  accounts,
  impersonationAuditLogs,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from '../src/db/schema/index.js';
import {
  generateImpersonationToken,
  hashImpersonationToken,
} from '../src/impersonation/impersonation-token.js';
import {
  type Actor,
  createAuthActors,
  PASSWORD,
  sessionCookie,
  TRUSTED_ORIGIN,
  tokenOf,
} from './utils/auth-actors.js';
import { createTestApp, uniqueEmail } from './utils/create-test-app.js';

const CLIENT_ORIGIN = 'http://localhost:5174'; // trusted (vitest.config.e2e.ts)
const REDIRECT_BASE = 'http://app.localhost:5174/impersonate?token='; // CLIENT_APP_URL
const EXCHANGE = '/api/auth/impersonate-exchange';
const HOUR_MS = 60 * 60 * 1000;
const impersonatePath = (workspaceId: string) =>
  `/api/admin/clients/${workspaceId}/impersonate`;

/**
 * 1-click impersonation (M1-T3): `POST /api/admin/clients/:workspaceId/impersonate` issues a 60 s
 * single-use token (hash in `impersonation_audit_logs`); `POST /api/auth/impersonate-exchange` burns
 * it and signs in as the workspace's oldest unbanned owner with `impersonatedBy`, for exactly 1 hour.
 * Better Auth's own `admin/impersonate-user` / `admin/stop-impersonating` are disabled.
 */
describe('Impersonation (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;

  let owner: Actor; // owns workspace W (the impersonation target)
  let wsAdmin: Actor; // admin in W; owner is also a moderator in wsAdmin's workspace
  let superAdmin: Actor;

  const http = () => actors.http();
  const db = () => actors.db;
  const setUser = (
    id: string,
    patch: { role?: string; banned?: boolean; banExpires?: Date | null },
  ) => db().update(users).set(patch).where(eq(users.id, id));
  const setStatus = (id: string, status: 'ACTIVE' | 'SUSPENDED') =>
    db().update(workspaces).set({ status }).where(eq(workspaces.id, id));
  const auditRowsFor = (workspaceId: string) =>
    db()
      .select()
      .from(impersonationAuditLogs)
      .where(eq(impersonationAuditLogs.targetWorkspaceId, workspaceId));

  const impersonate = (cookie: string, workspaceId: string) =>
    http().post(impersonatePath(workspaceId)).set('Cookie', cookie);

  async function issueToken(
    workspaceId: string,
    cookie = superAdmin.cookie,
  ): Promise<string> {
    const res = await impersonate(cookie, workspaceId).expect(200);
    return res.body.token as string;
  }

  const exchange = (token: unknown) =>
    http().post(EXCHANGE).set('Origin', CLIENT_ORIGIN).send({ token });

  async function storedSession(cookie: string) {
    const [row] = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.token, tokenOf(cookie)));
    return row!;
  }

  function cookieNames(res: request.Response): string[] {
    const raw =
      (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    return raw.map((c) => c.split('=')[0]!);
  }

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    owner = await actors.signUp('imp-owner');
    wsAdmin = await actors.signUp('imp-wsadmin');
    await actors.addMember(owner.workspaceId, wsAdmin.id, 'admin');
    await actors.addMember(wsAdmin.workspaceId, owner.id, 'moderator');
    superAdmin = await actors.signUpSuperAdmin('imp-super');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('POST /api/admin/clients/:workspaceId/impersonate', () => {
    it('401 without a session', async () => {
      await http().post(impersonatePath(owner.workspaceId)).expect(401);
    });

    it('403 for non-admins (workspace owner, workspace admin), and no audit row', async () => {
      for (const actor of [owner, wsAdmin]) {
        const res = await impersonate(actor.cookie, owner.workspaceId);
        expect(res.status, actor.email).toBe(403);
        expect(res.body).not.toHaveProperty('token');
      }
      expect(await auditRowsFor(owner.workspaceId)).toHaveLength(0);
    });

    it('403 for an impersonated session (even a super admin’s own)', async () => {
      const cookie = await actors.signIn(superAdmin.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      await impersonate(cookie, owner.workspaceId).expect(403);
    });

    it('403 for a banned super admin', async () => {
      await setUser(superAdmin.id, { banned: true });
      try {
        await impersonate(superAdmin.cookie, owner.workspaceId).expect(403);
      } finally {
        await setUser(superAdmin.id, { banned: false });
      }
      expect(await auditRowsFor(owner.workspaceId)).toHaveLength(0);
    });

    it.each([
      ['unknown', '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'],
      ['malformed', 'not-a-uuid'],
    ])('404 for an %s workspace', async (_label, id) => {
      const res = await impersonate(superAdmin.cookie, id).expect(404);
      expect(res.body).toMatchObject({
        statusCode: 404,
        message: 'Workspace not found',
      });
    });

    it('200 for a super admin: { token, redirectUrl }; only the hash is stored, with admin id and IP', async () => {
      const res = await impersonate(superAdmin.cookie, owner.workspaceId)
        .set('X-Forwarded-For', '203.0.113.7, 10.0.0.1')
        .expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['redirectUrl', 'token']);
      const token = res.body.token as string;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.body.redirectUrl).toBe(`${REDIRECT_BASE}${token}`);

      const [row] = await db()
        .select()
        .from(impersonationAuditLogs)
        .where(
          eq(impersonationAuditLogs.tokenHash, hashImpersonationToken(token)),
        );
      expect(row).toMatchObject({
        adminId: superAdmin.id,
        targetWorkspaceId: owner.workspaceId,
        usedAt: null,
        ipAddress: '203.0.113.7',
      });
      expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeCloseTo(
        60_000,
        -3,
      );
      expect(JSON.stringify(row)).not.toContain(token);
    });
  });

  describe('POST /api/auth/impersonate-exchange', () => {
    let token: string;
    let res: request.Response;
    let cookie: string;

    beforeAll(async () => {
      token = await issueToken(owner.workspaceId);
      res = await exchange(token);
      cookie = sessionCookie(res);
    });

    it('signs in as the owner with impersonatedBy + the workspace, and burns the token', async () => {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        user: { id: owner.id, email: owner.email },
        session: {
          impersonatedBy: superAdmin.id,
          activeOrganizationId: owner.workspaceId,
        },
      });
      expect(JSON.stringify(res.body)).not.toContain(tokenOf(cookie));
      // Browser-session cookie ("don't remember me"), host-only on the calling origin.
      expect(cookieNames(res)).toEqual(
        expect.arrayContaining([
          'better-auth.session_token',
          'better-auth.dont_remember',
        ]),
      );
      const raw = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('better-auth.session_token='),
      )!;
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).not.toMatch(/Max-Age|Expires|Domain=/i);

      const [audit] = await db()
        .select()
        .from(impersonationAuditLogs)
        .where(
          eq(impersonationAuditLogs.tokenHash, hashImpersonationToken(token)),
        );
      expect(audit!.usedAt).toBeInstanceOf(Date);

      const stored = await storedSession(cookie);
      expect(stored).toMatchObject({
        userId: owner.id,
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
    });

    it('get-session and /api/me expose impersonatedBy', async () => {
      const session = await http()
        .get('/api/auth/get-session')
        .set('Cookie', cookie)
        .expect(200);
      expect(session.body.session).toMatchObject({
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      const me = await http().get('/api/me').set('Cookie', cookie).expect(200);
      expect(me.body.impersonatedBy).toBe(superAdmin.id);
      expect(me.body.workspaces.map((w: { id: string }) => w.id)).toEqual([
        owner.workspaceId,
      ]);
    });

    it('is locked to the workspace and is not a super admin', async () => {
      await http()
        .get(`/api/workspaces/${owner.workspaceId}`)
        .set('Cookie', cookie)
        .expect(200);
      // The owner is also a member here, but the impersonated session can't reach it.
      await http()
        .get(`/api/workspaces/${wsAdmin.workspaceId}`)
        .set('Cookie', cookie)
        .expect(404);
      await http().get('/api/admin/clients').set('Cookie', cookie).expect(403);
      await impersonate(cookie, owner.workspaceId).expect(403);
      const switchRes = await http()
        .post('/api/auth/organization/set-active')
        .set('Origin', CLIENT_ORIGIN)
        .set('Cookie', cookie)
        .send({ organizationId: wsAdmin.workspaceId });
      expect(switchRes.status).toBe(403);
      expect((await storedSession(cookie)).activeOrganizationId).toBe(
        owner.workspaceId,
      );
    });

    it('lasts exactly 1 hour and is never extended by get-session / guarded requests', async () => {
      const before = await storedSession(cookie);
      expect(
        before.expiresAt.getTime() - before.createdAt.getTime(),
      ).toBeGreaterThan(HOUR_MS - 2_000);
      expect(
        before.expiresAt.getTime() - before.createdAt.getTime(),
      ).toBeLessThanOrEqual(HOUR_MS);

      // Only the session_token cookie (no dont_remember, no cookie cache): Better Auth's updateAge
      // check is always due for a 1-hour session, so without the guard this would refresh to +7 days.
      for (let i = 0; i < 2; i++) {
        await http()
          .get('/api/auth/get-session')
          .set('Cookie', cookie)
          .expect(200);
        await http().get('/api/me').set('Cookie', cookie).expect(200);
      }
      const after = await storedSession(cookie);
      expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
      const cached = JSON.parse(
        (await actors.storage.get(tokenOf(cookie))) as string,
      ) as {
        session: { expiresAt: string };
      };
      expect(new Date(cached.session.expiresAt).getTime()).toBe(
        before.expiresAt.getTime(),
      );
    });

    it('a used token is rejected (4xx) and creates no session', async () => {
      const count = async () =>
        (
          await db()
            .select()
            .from(sessions)
            .where(eq(sessions.userId, owner.id))
        ).length;
      const sessionsBefore = await count();
      const again = await exchange(token);
      expect(again.status).toBe(401);
      expect(again.body.code).toBe('INVALID_IMPERSONATION_TOKEN');
      expect(cookieNames(again)).not.toContain('better-auth.session_token');
      expect(await count()).toBe(sessionsBefore);
    });

    it('two concurrent exchanges of one token: exactly one wins', async () => {
      const fresh = await issueToken(owner.workspaceId);
      const results = await Promise.all([
        exchange(fresh),
        exchange(fresh),
        exchange(fresh),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 401, 401,
      ]);
    });

    it('an expired token is rejected (4xx) and stays unused', async () => {
      const expired = await issueToken(owner.workspaceId);
      const tokenHash = hashImpersonationToken(expired);
      await db()
        .update(impersonationAuditLogs)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(impersonationAuditLogs.tokenHash, tokenHash));
      const res = await exchange(expired);
      expect(res.status).toBe(401);
      const [row] = await db()
        .select()
        .from(impersonationAuditLogs)
        .where(eq(impersonationAuditLogs.tokenHash, tokenHash));
      expect(row!.usedAt).toBeNull();
    });

    it('unknown token 401, malformed or missing token 400', async () => {
      expect((await exchange(generateImpersonationToken())).status).toBe(401);
      for (const bad of [undefined, '', 'short', 42, `${'a'.repeat(43)}x`]) {
        expect((await exchange(bad)).status, JSON.stringify(bad)).toBe(400);
      }
    });

    it('re-checks at exchange time: suspended since issue → 409, admin demoted since issue → 403', async () => {
      const suspendedLater = await issueToken(owner.workspaceId);
      await setStatus(owner.workspaceId, 'SUSPENDED');
      try {
        expect((await exchange(suspendedLater)).status).toBe(409);
      } finally {
        await setStatus(owner.workspaceId, 'ACTIVE');
      }

      const demotedLater = await issueToken(owner.workspaceId);
      await setUser(superAdmin.id, { role: 'user' });
      try {
        expect((await exchange(demotedLater)).status).toBe(403);
      } finally {
        await setUser(superAdmin.id, { role: 'super_admin' });
      }
    });

    it('an impersonated super-admin owner gets no admin plugin powers', async () => {
      // The super admin's own sign-up workspace: its owner is a super admin.
      const res = await exchange(
        await issueToken(superAdmin.workspaceId),
      ).expect(200);
      const adminOwned = sessionCookie(res);
      expect(res.body.user.id).toBe(superAdmin.id);
      await http()
        .get('/api/auth/admin/list-users')
        .set('Cookie', adminOwned)
        .expect(403);
      await http()
        .get('/api/admin/clients')
        .set('Cookie', adminOwned)
        .expect(403);
    });
  });

  describe('suspended workspace (409, no token, no audit row)', () => {
    it('refuses to impersonate a SUSPENDED workspace', async () => {
      const client = await actors.signUp('imp-suspended');
      await setStatus(client.workspaceId, 'SUSPENDED');
      const res = await impersonate(
        superAdmin.cookie,
        client.workspaceId,
      ).expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        message: 'Workspace is suspended',
      });
      expect(res.body).not.toHaveProperty('token');
      expect(await auditRowsFor(client.workspaceId)).toHaveLength(0);
    });
  });

  describe('several owners: oldest unbanned owner', () => {
    let first: Actor; // created the workspace (owner, membership at sign-up)
    let second: Actor; // added as owner later
    let workspaceId: string;

    const exchangedUser = async () => {
      const res = await exchange(await issueToken(workspaceId)).expect(200);
      return res.body.user.id as string;
    };
    const setOwnerSince = (userId: string, createdAt: Date) =>
      db()
        .update(workspaceMembers)
        .set({ createdAt })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );

    beforeAll(async () => {
      first = await actors.signUp('imp-owner1');
      second = await actors.signUp('imp-owner2');
      workspaceId = first.workspaceId;
      await actors.addMember(workspaceId, second.id, 'owner');
    });

    afterEach(async () => {
      await setUser(first.id, { banned: false, banExpires: null });
      await setUser(second.id, { banned: false, banExpires: null });
    });

    it('picks the oldest owner membership', async () => {
      expect(await exchangedUser()).toBe(first.id);
    });

    it('orders by membership created_at, not insertion or user', async () => {
      await setOwnerSince(second.id, new Date('2020-01-01T00:00:00Z'));
      try {
        expect(await exchangedUser()).toBe(second.id);
      } finally {
        await setOwnerSince(second.id, new Date());
      }
    });

    it('skips a banned owner; an expired ban does not count', async () => {
      await setUser(first.id, { banned: true });
      expect(await exchangedUser()).toBe(second.id);
      await setUser(first.id, {
        banned: true,
        banExpires: new Date(Date.now() - 60_000),
      });
      expect(await exchangedUser()).toBe(first.id);
    });

    it('409 before any token when every owner is banned', async () => {
      const before = (await auditRowsFor(workspaceId)).length;
      await setUser(first.id, { banned: true });
      await setUser(second.id, { banned: true });
      const res = await impersonate(superAdmin.cookie, workspaceId).expect(409);
      expect(res.body).toMatchObject({
        message: 'Workspace has no owner that can be impersonated',
      });
      expect(res.body).not.toHaveProperty('token');
      expect(await auditRowsFor(workspaceId)).toHaveLength(before);
    });
  });

  describe('account routes are blocked while impersonating (M1-GATE decision)', () => {
    let cookie: string; // impersonated session for `owner`

    const post = (path: string, body: object, as = cookie) =>
      http()
        .post(`/api/auth${path}`)
        .set('Origin', CLIENT_ORIGIN)
        .set('Cookie', as)
        .send(body);
    const ownerRow = async () => {
      const [user] = await db()
        .select()
        .from(users)
        .where(eq(users.id, owner.id));
      const ownerAccounts = await db()
        .select()
        .from(accounts)
        .where(eq(accounts.userId, owner.id));
      return { user, accounts: ownerAccounts };
    };

    beforeAll(async () => {
      cookie = sessionCookie(
        await exchange(await issueToken(owner.workspaceId)).expect(200),
      );
    });

    it.each<[string, () => object]>([
      [
        '/change-password',
        () => ({
          currentPassword: PASSWORD,
          newPassword: 'hijacked-password-1',
          revokeOtherSessions: true,
        }),
      ],
      ['/verify-password', () => ({ password: PASSWORD })],
      ['/change-email', () => ({ newEmail: uniqueEmail('imp-hijack') })],
      [
        '/update-user',
        () => ({ name: 'Hijacked', image: 'https://x.test/a.png' }),
      ],
      ['/delete-user', () => ({ password: PASSWORD })],
      ['/revoke-session', () => ({ token: tokenOf(owner.cookie) })],
      ['/revoke-sessions', () => ({})],
      ['/revoke-other-sessions', () => ({})],
      ['/link-social', () => ({ provider: 'google' })],
      ['/unlink-account', () => ({ providerId: 'credential' })],
      ['/get-access-token', () => ({ providerId: 'credential' })],
      ['/refresh-token', () => ({ providerId: 'credential' })],
    ])('POST %s → 403 and the owner is unchanged', async (path, body) => {
      const before = await ownerRow();
      const res = await post(path, body());
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Not allowed while impersonating');
      expect(await ownerRow()).toEqual(before);
      // The owner's own session and the impersonated one both survive.
      await http()
        .get('/api/auth/get-session')
        .set('Cookie', owner.cookie)
        .expect(200);
      const mine = await http()
        .get('/api/auth/get-session')
        .set('Cookie', cookie)
        .expect(200);
      expect(mine.body.session.impersonatedBy).toBe(superAdmin.id);
    });

    it('GET /delete-user/callback → 403; /set-password has no HTTP route (404)', async () => {
      await http()
        .get('/api/auth/delete-user/callback?token=whatever')
        .set('Cookie', cookie)
        .expect(403);
      expect(
        (await post('/set-password', { newPassword: 'x'.repeat(12) })).status,
      ).toBe(404);
      expect((await ownerRow()).user).toBeDefined();
    });

    it("the owner's own (non-impersonated) session can still use them: update-user 200", async () => {
      const res = await post(
        '/update-user',
        { name: 'Owner Renamed' },
        owner.cookie,
      );
      expect(res.status).toBe(200);
      expect((await ownerRow()).user!.name).toBe('Owner Renamed');
    });

    it('sign-out still works for the impersonated session', async () => {
      await post('/sign-out', {}).expect(200);
      const after = await http()
        .get('/api/auth/get-session')
        .set('Cookie', cookie);
      expect(after.body).toBeNull();
      // The owner's own session is untouched.
      await http().get('/api/me').set('Cookie', owner.cookie).expect(200);
    });
  });

  describe('Better Auth built-in impersonation is blocked', () => {
    it.each([
      '/api/auth/admin/impersonate-user',
      '/api/auth/admin/stop-impersonating',
    ])('%s → 404 for a super admin', async (path) => {
      const res = await http()
        .post(path)
        .set('Origin', TRUSTED_ORIGIN)
        .set('Cookie', superAdmin.cookie)
        .send(path.endsWith('impersonate-user') ? { userId: owner.id } : {});
      expect(res.status).toBe(404);
      expect(cookieNames(res)).not.toContain('better-auth.session_token');
    });

    it('stop-impersonating is 404 for an impersonated session too', async () => {
      const cookie = sessionCookie(
        await exchange(await issueToken(owner.workspaceId)).expect(200),
      );
      const res = await http()
        .post('/api/auth/admin/stop-impersonating')
        .set('Origin', CLIENT_ORIGIN)
        .set('Cookie', cookie)
        .send({});
      expect(res.status).toBe(404);
      // Our exchange's session still carries impersonatedBy.
      expect((await storedSession(cookie)).impersonatedBy).toBe(superAdmin.id);
    });
  });
});

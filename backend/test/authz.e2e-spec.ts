import type { INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { BetterAuth } from '../src/auth/better-auth.js';
import { ensureSuperAdmin } from '../src/auth/super-admin.js';
import type { Database } from '../src/db/database.js';
import {
  users,
  workspaceMembers,
  workspaces,
  type WorkspaceRole,
} from '../src/db/schema/index.js';
import { AUTH_SECONDARY_STORAGE } from '../src/redis/redis-secondary-storage.js';
import { createTestApp, uniqueEmail } from './utils/create-test-app.js';
import type { createMemorySecondaryStorage } from './utils/memory-secondary-storage.js';

const PASSWORD = 'correct-horse-battery';
const ARGON2ID_HASH = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/;
const MISSING_WORKSPACE = '01970000-0000-7000-8000-0000000000ff';

interface Actor {
  id: string;
  email: string;
  cookie: string;
  /** Workspace created at sign-up (owner). */
  workspaceId: string;
}

function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('better-auth.session_token='));
  expect(cookie, 'session cookie').toBeDefined();
  return cookie!.split(';')[0]!;
}

/** The session token inside the signed cookie = the secondary-storage key. */
function tokenOf(cookie: string): string {
  return decodeURIComponent(cookie.split('=')[1]!).split('.')[0]!;
}

describe('Guards + /me, /workspaces, /admin/clients (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let storage: ReturnType<typeof createMemorySecondaryStorage>;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  let owner: Actor; // owner of workspace A
  let other: Actor; // owner of workspace B, not a member of A
  let moderator: Actor; // moderator in A
  let wsAdmin: Actor; // admin in A
  let superAdmin: Actor;

  const http = () => request(app.getHttpServer());

  async function signUp(prefix: string): Promise<Actor> {
    const email = uniqueEmail(prefix);
    const res = await http()
      .post('/api/auth/sign-up/email')
      .send({ name: prefix, email, password: PASSWORD })
      .expect(200);
    const id = res.body.user.id as string;
    userIds.push(id);
    const [member] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, id));
    workspaceIds.push(member!.workspaceId);
    return {
      id,
      email,
      cookie: sessionCookie(res),
      workspaceId: member!.workspaceId,
    };
  }

  async function signIn(email: string): Promise<string> {
    const res = await http()
      .post('/api/auth/sign-in/email')
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return sessionCookie(res);
  }

  async function addMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ) {
    await db.insert(workspaceMembers).values({ workspaceId, userId, role });
  }

  /** Edits the cached session the way M1-T3's impersonation exchange will create it. */
  async function patchStoredSession(
    cookie: string,
    patch: Record<string, unknown>,
  ) {
    const token = tokenOf(cookie);
    const raw = await storage.get(token);
    expect(raw, 'cached session').toBeTruthy();
    const cached = JSON.parse(raw as string) as {
      session: Record<string, unknown>;
    };
    Object.assign(cached.session, patch);
    await storage.set(token, JSON.stringify(cached));
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(getDrizzleToken());
    storage = app.get(AUTH_SECONDARY_STORAGE);

    owner = await signUp('authz-owner');
    other = await signUp('authz-other');
    moderator = await signUp('authz-mod');
    wsAdmin = await signUp('authz-admin');
    superAdmin = await signUp('authz-super');
    await addMember(owner.workspaceId, moderator.id, 'moderator');
    await addMember(owner.workspaceId, wsAdmin.id, 'admin');

    const auth = app.get(AuthService).instance as BetterAuth;
    expect(
      await ensureSuperAdmin(db, auth, { email: superAdmin.email, name: 'x' }),
    ).toBe('promoted');
    // The cached session still says role=user: sign in again.
    superAdmin.cookie = await signIn(superAdmin.email);
  });

  afterAll(async () => {
    if (workspaceIds.length)
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
    if (userIds.length)
      await db.delete(users).where(inArray(users.id, userIds));
    await app.close();
  });

  describe('401 without a session', () => {
    it.each([
      ['get', '/api/me'],
      ['get', `/api/workspaces/${MISSING_WORKSPACE}`],
      ['patch', `/api/workspaces/${MISSING_WORKSPACE}`],
      ['get', '/api/admin/clients'],
    ] as const)('%s %s', async (method, path) => {
      const res = await http()[method](path).send({ name: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/me', () => {
    it('returns the user, their workspaces + roles and the active workspace', async () => {
      const res = await http()
        .get('/api/me')
        .set('Cookie', owner.cookie)
        .expect(200);
      expect(res.body).toMatchObject({
        user: {
          id: owner.id,
          email: owner.email,
          role: 'user',
          emailVerified: false,
        },
        activeWorkspaceId: owner.workspaceId,
        impersonatedBy: null,
      });
      expect(res.body.workspaces).toEqual([
        expect.objectContaining({
          id: owner.workspaceId,
          role: 'owner',
          status: 'ACTIVE',
        }),
      ]);
    });

    it('lists every membership, oldest first', async () => {
      const res = await http()
        .get('/api/me')
        .set('Cookie', moderator.cookie)
        .expect(200);
      expect(
        res.body.workspaces.map((w: { id: string; role: string }) => [
          w.id,
          w.role,
        ]),
      ).toEqual([
        [moderator.workspaceId, 'owner'],
        [owner.workspaceId, 'moderator'],
      ]);
    });
  });

  describe('GET/PATCH /api/workspaces/:workspaceId', () => {
    it('200 for the owner and a workspace admin', async () => {
      const res = await http()
        .get(`/api/workspaces/${owner.workspaceId}`)
        .set('Cookie', owner.cookie)
        .expect(200);
      expect(res.body).toMatchObject({
        id: owner.workspaceId,
        status: 'ACTIVE',
        role: 'owner',
        memberCount: 3,
      });
      const asAdmin = await http()
        .get(`/api/workspaces/${owner.workspaceId}`)
        .set('Cookie', wsAdmin.cookie)
        .expect(200);
      expect(asAdmin.body.role).toBe('admin');
    });

    it('404 for a non-member, an unknown id and a malformed id (same body)', async () => {
      for (const id of [owner.workspaceId, MISSING_WORKSPACE, 'not-a-uuid']) {
        for (const method of ['get', 'patch'] as const) {
          const res = await http()
            [method](`/api/workspaces/${id}`)
            .set('Cookie', other.cookie)
            .send({ name: 'Hijack' });
          expect(res.status, `${method} ${id}`).toBe(404);
          expect(res.body.message).toBe('Workspace not found');
        }
      }
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, owner.workspaceId));
      expect(ws!.name).not.toBe('Hijack');
    });

    it('403 for a moderator (role too low)', async () => {
      for (const method of ['get', 'patch'] as const) {
        const res = await http()
          [method](`/api/workspaces/${owner.workspaceId}`)
          .set('Cookie', moderator.cookie)
          .send({ name: 'Nope' });
        expect(res.status, method).toBe(403);
      }
    });

    it('403 while the workspace is suspended', async () => {
      await db
        .update(workspaces)
        .set({ status: 'SUSPENDED' })
        .where(eq(workspaces.id, owner.workspaceId));
      try {
        const res = await http()
          .get(`/api/workspaces/${owner.workspaceId}`)
          .set('Cookie', owner.cookie);
        expect(res.status).toBe(403);
        expect(res.body.message).toBe('Workspace is suspended');
      } finally {
        await db
          .update(workspaces)
          .set({ status: 'ACTIVE' })
          .where(eq(workspaces.id, owner.workspaceId));
      }
    });

    it('PATCH renames (trimmed) and validates the name (1-80 chars, no extra fields)', async () => {
      const ok = await http()
        .patch(`/api/workspaces/${owner.workspaceId}`)
        .set('Cookie', wsAdmin.cookie)
        .send({ name: '  রহিম শপ  ' })
        .expect(200);
      expect(ok.body).toMatchObject({
        id: owner.workspaceId,
        name: 'রহিম শপ',
        role: 'admin',
      });

      for (const body of [
        {},
        { name: '   ' },
        { name: 'x'.repeat(81) },
        { name: 7 },
        { name: 'Ok', status: 'ACTIVE' },
      ]) {
        const res = await http()
          .patch(`/api/workspaces/${owner.workspaceId}`)
          .set('Cookie', owner.cookie)
          .send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, owner.workspaceId));
      expect(ws!.name).toBe('রহিম শপ');
      expect(ws!.status).toBe('ACTIVE');
    });
  });

  describe('GET /api/admin/clients', () => {
    it('403 for a regular user', async () => {
      await http()
        .get('/api/admin/clients')
        .set('Cookie', owner.cookie)
        .expect(403);
    });

    it('200 for a super admin: newest first, with owner and member count', async () => {
      const res = await http()
        .get('/api/admin/clients?take=100')
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      expect(res.body).toMatchObject({ skip: 0, take: 100 });
      expect(res.body.total).toBeGreaterThanOrEqual(5);
      const a = res.body.items.find(
        (w: { id: string }) => w.id === owner.workspaceId,
      );
      expect(a).toMatchObject({
        status: 'ACTIVE',
        memberCount: 3,
        owner: { id: owner.id, email: owner.email },
      });
      const created = res.body.items.map(
        (w: { createdAt: string }) => w.createdAt,
      );
      expect([...created].sort((x, y) => y.localeCompare(x))).toEqual(created);
    });

    it('paginates and validates skip/take', async () => {
      const page = await http()
        .get('/api/admin/clients?skip=1&take=2')
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      expect(page.body).toMatchObject({ skip: 1, take: 2 });
      expect(page.body.items).toHaveLength(2);
      for (const q of [
        'take=0',
        'take=101',
        'skip=-1',
        'take=abc',
        'search=x',
      ]) {
        const res = await http()
          .get(`/api/admin/clients?${q}`)
          .set('Cookie', superAdmin.cookie);
        expect(res.status, q).toBe(400);
      }
    });

    it('403 once the role is revoked in Postgres, even with a cached super_admin session', async () => {
      await db
        .update(users)
        .set({ role: 'user' })
        .where(eq(users.id, superAdmin.id));
      try {
        await http()
          .get('/api/admin/clients')
          .set('Cookie', superAdmin.cookie)
          .expect(403);
      } finally {
        await db
          .update(users)
          .set({ role: 'super_admin' })
          .where(eq(users.id, superAdmin.id));
      }
    });
  });

  describe('impersonated sessions', () => {
    it('are locked to their active workspace and never pass SuperAdminGuard', async () => {
      // `other` also becomes an admin of A, so only the impersonation lock can hide A.
      await addMember(owner.workspaceId, other.id, 'admin');
      const cookie = await signIn(other.email);
      await http()
        .get(`/api/workspaces/${owner.workspaceId}`)
        .set('Cookie', cookie)
        .expect(200);

      await patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: other.workspaceId,
      });
      await http()
        .get(`/api/workspaces/${other.workspaceId}`)
        .set('Cookie', cookie)
        .expect(200);
      await http()
        .get(`/api/workspaces/${owner.workspaceId}`)
        .set('Cookie', cookie)
        .expect(404);
      const me = await http().get('/api/me').set('Cookie', cookie).expect(200);
      expect(me.body).toMatchObject({
        impersonatedBy: superAdmin.id,
        activeWorkspaceId: other.workspaceId,
      });
      expect(me.body.workspaces.map((w: { id: string }) => w.id)).toEqual([
        other.workspaceId,
      ]);

      const adminCookie = await signIn(superAdmin.email);
      await http()
        .get('/api/admin/clients')
        .set('Cookie', adminCookie)
        .expect(200);
      await patchStoredSession(adminCookie, { impersonatedBy: superAdmin.id });
      await http()
        .get('/api/admin/clients')
        .set('Cookie', adminCookie)
        .expect(403);
    });
  });

  describe('ensureSuperAdmin (npm run create-super-admin)', () => {
    it('creates an argon2id super admin without a workspace, then is idempotent', async () => {
      const email = uniqueEmail('authz-created');
      const auth = app.get(AuthService).instance as BetterAuth;
      const input = { email, password: PASSWORD, name: 'Created Admin' };
      expect(await ensureSuperAdmin(db, auth, input)).toBe('created');
      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
        with: { accounts: true, memberships: true },
      });
      userIds.push(user!.id);
      expect(user).toMatchObject({
        role: 'super_admin',
        name: 'Created Admin',
      });
      expect(user!.accounts[0]!.password).toMatch(ARGON2ID_HASH);
      expect(user!.memberships).toHaveLength(0);

      expect(
        await ensureSuperAdmin(db, auth, {
          ...input,
          password: 'other-password',
        }),
      ).toBe('unchanged');
      const cookie = await signIn(email); // original password still works
      await http().get('/api/admin/clients').set('Cookie', cookie).expect(200);
      await expect(
        ensureSuperAdmin(db, auth, { email: uniqueEmail('x'), name: 'x' }),
      ).rejects.toThrow(/SUPER_ADMIN_PASSWORD/);
    });
  });
});

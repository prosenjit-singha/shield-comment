import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { users } from '../src/db/schema/index.js';
import {
  type Actor,
  createAuthActors,
  TRUSTED_ORIGIN,
  tokenOf,
} from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const CLIENTS = '/api/admin/clients';

/**
 * `SuperAdminGuard` on `GET /api/admin/clients`, plus Better Auth's own `admin` plugin routes:
 * only a current, unbanned, non-impersonated super admin gets through.
 */
describe('Super admin guard (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;

  let owner: Actor; // owner of workspace A
  let wsAdmin: Actor; // admin in A
  let regular: Actor; // moderator in A (every user also owns their sign-up workspace)
  let superAdmin: Actor;

  const http = () => actors.http();
  const setUser = (id: string, patch: { role?: string; banned?: boolean }) =>
    actors.db.update(users).set(patch).where(eq(users.id, id));

  async function expectForbidden(cookie: string) {
    const res = await http().get(CLIENTS).set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      statusCode: 403,
      message: 'Super admin only',
      path: CLIENTS,
    });
    expect(res.body).not.toHaveProperty('items');
  }

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    owner = await actors.signUp('admguard-owner');
    wsAdmin = await actors.signUp('admguard-admin');
    regular = await actors.signUp('admguard-user');
    await actors.addMember(owner.workspaceId, wsAdmin.id, 'admin');
    await actors.addMember(owner.workspaceId, regular.id, 'moderator');
    superAdmin = await actors.signUpSuperAdmin('admguard-super');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('401 without a session', async () => {
    const res = await http().get(CLIENTS);
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('items');
  });

  it.each([
    ['regular user', () => regular],
    ['workspace owner', () => owner],
    ['workspace admin', () => wsAdmin],
  ])('403 for a %s', async (_label, who) => {
    await expectForbidden(who().cookie);
  });

  it('200 for a super admin, with no secrets in the response', async () => {
    const res = await http()
      .get(`${CLIENTS}?take=100`)
      .set('Cookie', superAdmin.cookie)
      .expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'items',
      'skip',
      'take',
      'total',
    ]);
    const mine = res.body.items.find(
      (w: { id: string }) => w.id === owner.workspaceId,
    );
    expect(mine).toBeDefined();
    for (const item of res.body.items as Record<string, unknown>[]) {
      expect(Object.keys(item).sort()).toEqual([
        'createdAt',
        'id',
        'memberCount',
        'name',
        'owner',
        'slug',
        'status',
      ]);
      if (item.owner !== null) {
        expect(Object.keys(item.owner as object).sort()).toEqual([
          'email',
          'id',
          'name',
        ]);
      }
    }
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/argon2|password|token|session/i);
    for (const actor of [owner, wsAdmin, regular, superAdmin]) {
      expect(json).not.toContain(tokenOf(actor.cookie));
    }
  });

  it('403 for a banned super admin (users.banned in the DB), with the cached session', async () => {
    try {
      await setUser(superAdmin.id, { banned: true });
      await expectForbidden(superAdmin.cookie);
    } finally {
      await setUser(superAdmin.id, { banned: false });
    }
    await http().get(CLIENTS).set('Cookie', superAdmin.cookie).expect(200);
  });

  it('403 for a super admin demoted in the DB, with the cached super_admin session', async () => {
    try {
      await setUser(superAdmin.id, { role: 'user' });
      await expectForbidden(superAdmin.cookie);
    } finally {
      await setUser(superAdmin.id, { role: 'super_admin' });
    }
    await http().get(CLIENTS).set('Cookie', superAdmin.cookie).expect(200);
  });

  it('403 for a user session promoted in the DB until it signs in again', async () => {
    // Both the session and Postgres must say super_admin.
    const cookie = await actors.signIn(regular.email);
    try {
      await setUser(regular.id, { role: 'super_admin' });
      await expectForbidden(cookie);
    } finally {
      await setUser(regular.id, { role: 'user' });
    }
  });

  describe('impersonated sessions', () => {
    it('403 for a client session impersonated by a super admin', async () => {
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      await expectForbidden(cookie);
    });

    it('403 for a super admin’s own session once it carries impersonatedBy', async () => {
      const cookie = await actors.signIn(superAdmin.email);
      await http().get(CLIENTS).set('Cookie', cookie).expect(200);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      await expectForbidden(cookie);
    });
  });

  describe('Better Auth admin plugin (/api/auth/admin/*) is locked too', () => {
    it('list-users: 401 without a session, 403 for non-admins, 200 for a super admin', async () => {
      await http()
        .get('/api/auth/admin/list-users')
        .expect((res) => expect([401, 403]).toContain(res.status));
      for (const actor of [regular, owner, wsAdmin]) {
        const res = await http()
          .get('/api/auth/admin/list-users')
          .set('Cookie', actor.cookie);
        expect([401, 403], actor.email).toContain(res.status);
        expect(res.body).not.toHaveProperty('users');
      }
      const ok = await http()
        .get('/api/auth/admin/list-users')
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      expect(Array.isArray(ok.body.users)).toBe(true);
      expect(JSON.stringify(ok.body)).not.toMatch(/argon2|password/i);
    });

    it('a workspace owner cannot promote themselves or impersonate via the plugin', async () => {
      for (const [path, body] of [
        ['/api/auth/admin/set-role', { userId: owner.id, role: 'super_admin' }],
        ['/api/auth/admin/impersonate-user', { userId: wsAdmin.id }],
      ] as const) {
        const res = await http()
          .post(path)
          .set('Origin', TRUSTED_ORIGIN)
          .set('Cookie', owner.cookie)
          .send(body);
        // impersonate-user is disabled outright (404, M1-T3).
        expect([401, 403, 404], path).toContain(res.status);
      }
      const [row] = await actors.db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, owner.id));
      expect(row!.role).toBe('user');
      await expectForbidden(owner.cookie);
    });
  });
});

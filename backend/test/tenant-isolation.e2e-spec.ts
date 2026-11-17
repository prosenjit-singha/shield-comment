import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  workspaceMembers,
  workspaces,
  type WorkspaceRole,
} from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

type Tenant = 'A' | 'B';
type Method = 'get' | 'patch';

interface TenantActor extends Actor {
  tenant: Tenant;
  role: WorkspaceRole;
}

const ACTOR_ROLES: WorkspaceRole[] = ['owner', 'admin', 'moderator'];
/** Expected status on the actor's own workspace (`@Roles('owner', 'admin')`). */
const OWN_STATUS: Record<WorkspaceRole, number> = {
  owner: 200,
  admin: 200,
  moderator: 403,
};
const FAKE_ADMIN_ID = '01970000-0000-7000-8000-00000000aaaa';

/** Alternates the case of every letter: `ab12cd` → `Ab12Cd`. */
function mixedCase(id: string): string {
  let n = 0;
  return id.replace(/[a-f]/g, (c) => (n++ % 2 === 0 ? c.toUpperCase() : c));
}

/**
 * Tenant isolation on every `:workspaceId` route. Workspaces A and B each have an owner, an
 * admin and a moderator; nobody else's data may appear and cross-tenant writes are no-ops.
 */
describe('Tenant isolation (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const tenants = {} as Record<
    Tenant,
    { id: string; name: string; slug: string }
  >;
  const people: TenantActor[] = [];

  const http = () => actors.http();
  const other = (t: Tenant): Tenant => (t === 'A' ? 'B' : 'A');
  const actor = (tenant: Tenant, role: WorkspaceRole) =>
    people.find((p) => p.tenant === tenant && p.role === role)!;

  async function readWorkspace(id: string) {
    const [row] = await actors.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id));
    return row!;
  }

  /** PATCH sends `name` (default: a hijack attempt that must never land). */
  function call(
    method: Method,
    workspaceId: string,
    cookie: string,
    name = `Hijacked ${workspaceId}`,
  ) {
    const req = http()
      [method](`/api/workspaces/${workspaceId}`)
      .set('Cookie', cookie);
    return method === 'patch' ? req.send({ name }) : req;
  }

  /**
   * Nothing about `tenant` (id, name, slug) may appear in `body`. An error's `path` is the
   * caller's own URL, so it's left out.
   */
  function expectNoLeak(body: unknown, tenant: Tenant) {
    const { path: _path, ...rest } = (body ?? {}) as Record<string, unknown>;
    const json = JSON.stringify(rest);
    const { id, name, slug } = tenants[tenant];
    expect(json).not.toContain(id);
    expect(json).not.toContain(name);
    expect(json).not.toContain(slug);
  }

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);

    for (const tenant of ['A', 'B'] as const) {
      const owner = await actors.signUp(`iso-${tenant}-owner`);
      // Distinctive names so leaks are easy to spot.
      const name = `Tenant ${tenant} ${crypto.randomUUID()}`;
      const [row] = await actors.db
        .update(workspaces)
        .set({ name })
        .where(eq(workspaces.id, owner.workspaceId))
        .returning();
      tenants[tenant] = { id: row!.id, name: row!.name, slug: row!.slug };
      people.push({ ...owner, tenant, role: 'owner' });
      for (const role of ['admin', 'moderator'] as const) {
        const member = await actors.signUp(`iso-${tenant}-${role}`);
        await actors.addMember(owner.workspaceId, member.id, role);
        people.push({ ...member, tenant, role });
      }
    }
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('actor × workspace matrix on GET/PATCH /api/workspaces/:workspaceId', () => {
    const cases = (['A', 'B'] as const).flatMap((tenant) =>
      ACTOR_ROLES.flatMap((role) =>
        (['A', 'B'] as const).flatMap((target) =>
          (['get', 'patch'] as const).map((method) => ({
            tenant,
            role,
            target,
            method,
            status: tenant === target ? OWN_STATUS[role] : 404,
          })),
        ),
      ),
    );

    it.each(cases)(
      '$role of $tenant: $method $target → $status',
      async ({ tenant, role, target, method, status }) => {
        const me = actor(tenant, role);
        const ws = tenants[target];
        const before = await readWorkspace(ws.id);

        // Allowed PATCHes keep the current name, so the matrix never changes state.
        const res = await call(
          method,
          ws.id,
          me.cookie,
          status === 200 ? ws.name : undefined,
        );
        expect(res.status).toBe(status);

        if (status === 200) {
          expect(res.body).toMatchObject({ id: ws.id, name: ws.name, role });
        } else {
          // Errors never echo the workspace, and 404 looks the same as an unknown id.
          expectNoLeak(res.body, target);
          expect(res.body.message).toBe(
            status === 404
              ? 'Workspace not found'
              : 'Insufficient workspace role',
          );
        }
        // Responses never carry the other tenant's data.
        expectNoLeak(res.body, other(target));

        if (status !== 200) {
          expect(await readWorkspace(ws.id)).toEqual(before);
        }
      },
    );
  });

  describe('membership is read from Postgres on every request', () => {
    it('a role change in the DB applies to the next request (same session)', async () => {
      const admin = actor('A', 'admin');
      const moderator = actor('A', 'moderator');
      const setRole = (userId: string, role: WorkspaceRole) =>
        actors.db
          .update(workspaceMembers)
          .set({ role })
          .where(
            and(
              eq(workspaceMembers.workspaceId, tenants.A.id),
              eq(workspaceMembers.userId, userId),
            ),
          );
      const get = (cookie: string) =>
        http().get(`/api/workspaces/${tenants.A.id}`).set('Cookie', cookie);

      try {
        await setRole(admin.id, 'moderator');
        await setRole(moderator.id, 'admin');
        expect((await get(admin.cookie)).status).toBe(403);
        const promoted = await get(moderator.cookie);
        expect(promoted.status).toBe(200);
        expect(promoted.body.role).toBe('admin');
      } finally {
        await setRole(admin.id, 'admin');
        await setRole(moderator.id, 'moderator');
      }
      expect((await get(admin.cookie)).status).toBe(200);
      expect((await get(moderator.cookie)).status).toBe(403);
    });

    it('a removed membership gives 404 (GET and PATCH), not 403', async () => {
      // B's moderator becomes an admin of A, then is removed again.
      const guest = actor('B', 'moderator');
      await actors.addMember(tenants.A.id, guest.id, 'admin');
      await http()
        .get(`/api/workspaces/${tenants.A.id}`)
        .set('Cookie', guest.cookie)
        .expect(200);

      await actors.db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, tenants.A.id),
            eq(workspaceMembers.userId, guest.id),
          ),
        );
      const before = await readWorkspace(tenants.A.id);
      for (const method of ['get', 'patch'] as const) {
        const res = await call(method, tenants.A.id, guest.cookie);
        expect(res.status, method).toBe(404);
        expect(res.body.message).toBe('Workspace not found');
        expectNoLeak(res.body, 'A');
      }
      expect(await readWorkspace(tenants.A.id)).toEqual(before);
    });
  });

  describe('mixed-case workspace ids', () => {
    it('resolve to the same workspace for members and stay 404 for others', async () => {
      const id = mixedCase(tenants.A.id);
      expect(id).not.toBe(tenants.A.id);
      expect(id.toLowerCase()).toBe(tenants.A.id);

      for (const variant of [id, tenants.A.id.toUpperCase()]) {
        const res = await http()
          .get(`/api/workspaces/${variant}`)
          .set('Cookie', actor('A', 'owner').cookie)
          .expect(200);
        expect(res.body).toMatchObject({ id: tenants.A.id, role: 'owner' });

        const before = await readWorkspace(tenants.A.id);
        for (const method of ['get', 'patch'] as const) {
          const res = await call(method, variant, actor('B', 'owner').cookie);
          expect(res.status, `${method} ${variant}`).toBe(404);
          expectNoLeak(res.body, 'A');
        }
        expect(await readWorkspace(tenants.A.id)).toEqual(before);
        const mod = await call('get', variant, actor('A', 'moderator').cookie);
        expect(mod.status).toBe(403);
      }

      const renamed = await call(
        'patch',
        id,
        actor('A', 'admin').cookie,
        tenants.A.name,
      );
      expect(renamed.status).toBe(200);
      expect(renamed.body.id).toBe(tenants.A.id);
    });
  });

  describe('impersonated sessions', () => {
    it('are locked to their workspace even when the user is an admin of B', async () => {
      const ownerA = actor('A', 'owner');
      await actors.addMember(tenants.B.id, ownerA.id, 'admin');
      try {
        const cookie = await actors.signIn(ownerA.email);
        await http()
          .get(`/api/workspaces/${tenants.B.id}`)
          .set('Cookie', cookie)
          .expect(200);

        // Locked to A; the stored id may come back in any case.
        await actors.patchStoredSession(cookie, {
          impersonatedBy: FAKE_ADMIN_ID,
          activeOrganizationId: tenants.A.id.toUpperCase(),
        });
        await http()
          .get(`/api/workspaces/${mixedCase(tenants.A.id)}`)
          .set('Cookie', cookie)
          .expect(200);

        const before = await readWorkspace(tenants.B.id);
        for (const id of [tenants.B.id, mixedCase(tenants.B.id)]) {
          for (const method of ['get', 'patch'] as const) {
            const res = await call(method, id, cookie);
            expect(res.status, `${method} ${id}`).toBe(404);
            expectNoLeak(res.body, 'B');
          }
        }
        expect(await readWorkspace(tenants.B.id)).toEqual(before);

        const me = await http()
          .get('/api/me')
          .set('Cookie', cookie)
          .expect(200);
        expect(me.body.impersonatedBy).toBe(FAKE_ADMIN_ID);
        expect(me.body.workspaces.map((w: { id: string }) => w.id)).toEqual([
          tenants.A.id,
        ]);
        expectNoLeak(me.body, 'B');

        // Without an active workspace an impersonated session reaches nothing.
        await actors.patchStoredSession(cookie, {
          activeOrganizationId: null,
        });
        for (const tenant of ['A', 'B'] as const) {
          await http()
            .get(`/api/workspaces/${tenants[tenant].id}`)
            .set('Cookie', cookie)
            .expect(404);
        }
        const empty = await http()
          .get('/api/me')
          .set('Cookie', cookie)
          .expect(200);
        expect(empty.body.workspaces).toEqual([]);
      } finally {
        await actors.db
          .delete(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, tenants.B.id),
              eq(workspaceMembers.userId, ownerA.id),
            ),
          );
      }
    });
  });

  describe('GET /api/me', () => {
    it('lists only the caller’s own memberships', async () => {
      for (const person of people) {
        const res = await http()
          .get('/api/me')
          .set('Cookie', person.cookie)
          .expect(200);
        // Owners: their tenant only. Admins/moderators: their own sign-up workspace + their tenant.
        const expected =
          person.role === 'owner'
            ? [[tenants[person.tenant].id, 'owner']]
            : [
                [person.workspaceId, 'owner'],
                [tenants[person.tenant].id, person.role],
              ];
        expect(
          res.body.workspaces.map((w: { id: string; role: string }) => [
            w.id,
            w.role,
          ]),
          `${person.role} of ${person.tenant}`,
        ).toEqual(expected);
        expect(res.body.user.id).toBe(person.id);
        expectNoLeak(res.body, other(person.tenant));
      }
    });
  });
});

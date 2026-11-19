import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { normalizeFeatureConfig } from '../src/admin/plan-rules.js';
import {
  plans,
  users,
  workspaces,
  workspaceStatusAuditLogs,
} from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { WalletService } from '../src/wallet/wallet.service.js';

const CLIENTS = '/api/admin/clients';
const UNKNOWN_ID = '019a0000-0000-7000-8000-00000000dead';

interface Item {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  plan: { id: string; slug: string; name: string } | null;
  owner: { id: string; email: string; name: string } | null;
  memberCount: number;
  subscription: {
    status: string;
    interval: string;
    trialEndsAt: string | null;
    termEndsAt: string;
  } | null;
  comments: { used: number; limit: number; resetsAt: string | null } | null;
}

/** The billing fields of an untouched sign-up (PW-T3: live 7-day Starter trial, 300 comments). */
const signUpTrial = () => ({
  subscription: {
    status: 'TRIALING',
    interval: 'month',
    trialEndsAt: expect.any(String) as string,
    termEndsAt: expect.any(String) as string,
  },
  comments: {
    used: 0,
    limit: 300,
    resetsAt: expect.any(String) as string,
  },
});

/**
 * M2-T3: `GET /api/admin/clients` search/filters/sort and `PATCH /api/admin/clients/:id/status`
 * (audit row with a required reason; suspension = guard only, no session revocation).
 */
describe('Admin clients: list filters + status (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const http = () => actors.http();

  // Random tag in every list workspace's name, so list queries only see this spec's rows.
  const T = `m2t3${randomBytes(4).toString('hex')}`;

  let superAdmin: Actor;
  // List fixtures: A..D + M (M is owned by `mod`, who is only a moderator in A).
  let a: Actor;
  let b: Actor;
  let c: Actor;
  let d: Actor;
  let mod: Actor;
  // Status fixtures: `target` owns P; `member` is an admin of P and owns their own workspace.
  let target: Actor;
  let member: Actor;

  const db = () => actors.db;
  const auditRows = (workspaceId: string) =>
    db()
      .select()
      .from(workspaceStatusAuditLogs)
      .where(eq(workspaceStatusAuditLogs.workspaceId, workspaceId))
      .orderBy(workspaceStatusAuditLogs.createdAt, workspaceStatusAuditLogs.id);
  const statusOf = async (workspaceId: string) => {
    const [ws] = await db()
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return ws!.status;
  };

  async function list(query: string, cookie = superAdmin.cookie) {
    const res = await http()
      .get(`${CLIENTS}?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return res.body as {
      items: Item[];
      total: number;
      skip: number;
      take: number;
    };
  }
  /** Ids of a tagged-scope query, in response order. */
  async function ids(query: string) {
    const body = await list(`q=${T}&take=100&${query}`);
    expect(body.total).toBe(body.items.length);
    return body.items.map((i) => i.id);
  }

  const patchStatus = (id: string, body: unknown, cookie = superAdmin.cookie) =>
    http()
      .patch(`${CLIENTS}/${id}/status`)
      .set('Cookie', cookie)
      .send(body as object);

  async function setWorkspace(
    actor: Actor,
    values: {
      name: string;
      slug: string;
      createdAt: string;
      status?: 'SUSPENDED';
    },
    ownerName: string,
  ) {
    await db()
      .update(workspaces)
      .set({ ...values, createdAt: new Date(values.createdAt) })
      .where(eq(workspaces.id, actor.workspaceId));
    await db()
      .update(users)
      .set({ name: ownerName })
      .where(eq(users.id, actor.id));
  }

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    superAdmin = await actors.signUpSuperAdmin('m2t3-super');

    a = await actors.signUp(`${T}ea`);
    b = await actors.signUp(`${T}eb`);
    c = await actors.signUp(`${T}mailmark`);
    d = await actors.signUp(`${T}ed`);
    mod = await actors.signUp(`${T}em`);
    await setWorkspace(
      a,
      {
        name: `Zeta Store ${T}x1`,
        slug: `ws-${T}-a`,
        createdAt: '2026-01-15T12:00:00Z',
      },
      `Owner ${T} A`,
    );
    await setWorkspace(
      b,
      {
        name: `alpha shop ${T}`,
        slug: `ws-${T}-b-slugmark`,
        createdAt: '2026-02-15T12:00:00Z',
      },
      `Owner ${T} B`,
    );
    await setWorkspace(
      c,
      {
        name: `Middle ${T}`,
        slug: `ws-${T}-c`,
        createdAt: '2026-03-15T12:00:00Z',
        status: 'SUSPENDED',
      },
      `Owner ${T} C`,
    );
    await setWorkspace(
      d,
      {
        name: `beta ${T}`,
        slug: `ws-${T}-d`,
        createdAt: '2026-04-15T12:00:00Z',
      },
      `Rahim ${T}ownermark`,
    );
    await setWorkspace(
      mod,
      {
        name: `own-of-mod ${T}`,
        slug: `ws-${T}-m`,
        createdAt: '2026-05-15T12:00:00Z',
      },
      `Mod ${T}modmark`,
    );
    await actors.addMember(a.workspaceId, mod.id, 'moderator');

    target = await actors.signUp('m2t3-target');
    member = await actors.signUp('m2t3-member');
    await actors.addMember(target.workspaceId, member.id, 'admin');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('GET /api/admin/clients filters', () => {
    it('keeps the { items, total, skip, take } shape with owner fields and member count', async () => {
      const body = await list(`q=${T}&sort=oldest&take=100`);
      expect(Object.keys(body).sort()).toEqual([
        'items',
        'skip',
        'take',
        'total',
      ]);
      expect(body).toMatchObject({ total: 5, skip: 0, take: 100 });
      expect(body.items[0]).toEqual({
        id: a.workspaceId,
        name: `Zeta Store ${T}x1`,
        slug: `ws-${T}-a`,
        status: 'ACTIVE',
        createdAt: '2026-01-15T12:00:00.000Z',
        plan: { id: expect.any(String), slug: 'starter', name: 'Starter' },
        owner: { id: a.id, email: a.email, name: `Owner ${T} A` },
        memberCount: 2,
        ...signUpTrial(),
      });
      expect(body.items[0]).not.toHaveProperty('credits');
    });

    it.each([
      ['workspace name', () => `STORE ${T}X1`, () => [a.workspaceId]],
      ['workspace slug', () => `${T}-B-SLUG`, () => [b.workspaceId]],
      ['owner email', () => `${T}MailMark`, () => [c.workspaceId]],
      ['owner name', () => `${T}OWNERMARK`, () => [d.workspaceId]],
    ])(
      'q matches the %s (case-insensitive, partial)',
      async (_f, q, expected) => {
        const body = await list(`q=${encodeURIComponent(q())}`);
        expect(body.items.map((i) => i.id)).toEqual(expected());
        expect(body.total).toBe(1);
      },
    );

    it('q matches owners only, not other members', async () => {
      // `mod` is a moderator in A and the owner of M.
      const body = await list(`q=${T}modmark`);
      expect(body.items.map((i) => i.id)).toEqual([mod.workspaceId]);
    });

    it('q treats % and _ literally and ignores surrounding blanks', async () => {
      expect((await list(`q=${T}%25`)).total).toBe(0);
      expect((await list(`q=${T}_`)).total).toBe(0);
      expect((await list(`q=${encodeURIComponent(`  ${T}x1  `)}`)).total).toBe(
        1,
      );
    });

    it('filters by status', async () => {
      expect(await ids('status=SUSPENDED')).toEqual([c.workspaceId]);
      expect(await ids('status=ACTIVE&sort=oldest')).toEqual([
        a.workspaceId,
        b.workspaceId,
        d.workspaceId,
        mod.workspaceId,
      ]);
    });

    it('filters by an inclusive created-at range (dates and date-times with offset)', async () => {
      expect(
        await ids('createdFrom=2026-02-01&createdTo=2026-03-15&sort=oldest'),
      ).toEqual([b.workspaceId, c.workspaceId]);
      expect(await ids('createdFrom=2026-03-15T12:00:00Z&sort=oldest')).toEqual(
        [c.workspaceId, d.workspaceId, mod.workspaceId],
      );
      expect(
        await ids('createdTo=2026-03-15T12:00:00.000Z&sort=oldest'),
      ).toEqual([a.workspaceId, b.workspaceId, c.workspaceId]);
      // 2026-02-15T17:59:59.999+06:00 = 11:59:59.999Z, one ms before B.
      expect(
        await ids(
          `createdTo=${encodeURIComponent('2026-02-15T17:59:59.999+06:00')}`,
        ),
      ).toEqual([a.workspaceId]);
      expect(
        await ids('status=ACTIVE&createdFrom=2026-03-01&createdTo=2026-04-30'),
      ).toEqual([d.workspaceId]);
    });

    it.each([
      ['newest (default)', '', () => [mod, d, c, b, a]],
      ['newest', 'sort=newest', () => [mod, d, c, b, a]],
      ['oldest', 'sort=oldest', () => [a, b, c, d, mod]],
      // alpha shop, beta, Middle, own-of-mod, Zeta Store: case-insensitive A–Z.
      ['name', 'sort=name', () => [b, d, c, mod, a]],
    ])('sorts %s', async (_label, query, expected) => {
      expect(await ids(query)).toEqual(expected().map((x) => x.workspaceId));
    });

    it('paginates the filtered result and counts every match', async () => {
      const body = await list(`q=${T}&sort=oldest&skip=1&take=2`);
      expect(body).toMatchObject({ total: 5, skip: 1, take: 2 });
      expect(body.items.map((i) => i.id)).toEqual([
        b.workspaceId,
        c.workspaceId,
      ]);
    });

    it.each([
      'sort=createdAt',
      'sort=',
      'status=active',
      'status=DELETED',
      'createdFrom=yesterday',
      'createdFrom=2026-02-30',
      'createdTo=2026-11-18T10:00:00',
      'createdFrom=2026-11-19&createdTo=2026-11-18',
      `q=${'x'.repeat(101)}`,
      'plan=',
      'plan=Growth',
      'plan=growth%20plan',
      'plan=growth&plan=pro',
      'search=x',
      'take=101',
    ])('400 for %s', async (query) => {
      const res = await http()
        .get(`${CLIENTS}?${query}`)
        .set('Cookie', superAdmin.cookie);
      expect(res.status).toBe(400);
      expect(res.body).not.toHaveProperty('items');
    });

    it('403 for a normal user', async () => {
      const res = await http().get(`${CLIENTS}?q=${T}`).set('Cookie', a.cookie);
      expect(res.status).toBe(403);
      expect(res.body).not.toHaveProperty('items');
    });
  });

  /**
   * M2-T12b, PW-T6b: `plan` = the live subscription's plan, `subscription` (same status rule as the
   * client billing summary), `comments` from the pooled wallet, and the `plan` filter on the live
   * subscription. A + D on Growth (A's account pools a second workspace), B on the sign-up trial,
   * C expired, M without a billing account.
   */
  describe('plans, subscriptions + comments (PW-T6b)', () => {
    type PlanRef = { id: string; slug: string; name: string };
    let plan: Record<string, PlanRef>;
    let growthLimit: number;
    let pooled: string;
    // Its own random tag (the list's `q` is case-insensitive, so no `T` in its name or slug).
    const P = `pw${randomBytes(4).toString('hex')}`;

    beforeAll(async () => {
      const rows = await db()
        .select({
          id: plans.id,
          slug: plans.slug,
          name: plans.name,
          featureConfig: plans.featureConfig,
        })
        .from(plans);
      plan = Object.fromEntries(
        rows.map(({ id, slug, name }) => [slug, { id, slug, name }]),
      );
      growthLimit = normalizeFeatureConfig(
        rows.find((r) => r.slug === 'growth')!.featureConfig,
      ).limits.monthlyComments;
      await actors.activatePlan(a, 'growth');
      await actors.activatePlan(d, 'growth');
      await actors.expirePlan(c);
      await actors.removeBilling(mod);
      // A second workspace on A's account, outside the tagged list scope.
      const [row] = await db()
        .insert(workspaces)
        .values({
          name: `Pooled ${P}`,
          slug: `pooled-${P}`,
          billingAccountId: await actors.accountIdOf(a),
        })
        .returning({ id: workspaces.id });
      pooled = row!.id;
      actors.trackWorkspace(pooled);
      const wallet = app.get(WalletService);
      for (const [ws, n] of [
        [a.workspaceId, 5],
        [pooled, 2],
      ] as const) {
        expect(await wallet.consume(ws, 'monthlyComments', n)).toBe('ok');
      }
    });

    it('plan + subscription + comments per item: Growth, trial, expired, Growth, no account', async () => {
      const body = await list(`q=${T}&sort=oldest`);
      const byId = new Map(body.items.map((i) => [i.id, i]));
      const growth = {
        plan: plan.growth,
        subscription: {
          status: 'ACTIVE',
          interval: 'month',
          trialEndsAt: null,
          termEndsAt: expect.any(String),
        },
      };
      expect(byId.get(a.workspaceId)).toMatchObject({
        ...growth,
        comments: { used: 7, limit: growthLimit },
      });
      expect(byId.get(d.workspaceId)).toMatchObject({
        ...growth,
        comments: { used: 0, limit: growthLimit },
      });
      for (const ws of [a.workspaceId, d.workspaceId]) {
        const { comments, subscription } = byId.get(ws)!;
        const resetsAt = new Date(comments!.resetsAt!).getTime();
        expect(resetsAt).toBeGreaterThan(Date.now());
        expect(resetsAt).toBeLessThanOrEqual(
          new Date(subscription!.termEndsAt).getTime(),
        );
      }
      const trial = byId.get(b.workspaceId)!;
      expect(trial).toMatchObject({ plan: plan.starter, ...signUpTrial() });
      expect(trial.subscription!.trialEndsAt).toBe(
        trial.subscription!.termEndsAt,
      );
      expect(trial.comments!.resetsAt).toBe(trial.subscription!.trialEndsAt);
      expect(byId.get(c.workspaceId)).toMatchObject({
        plan: null,
        subscription: {
          status: 'EXPIRED',
          interval: 'month',
          trialEndsAt: expect.any(String),
          termEndsAt: expect.any(String),
        },
        comments: { used: 0, limit: 0, resetsAt: null },
      });
      expect(byId.get(mod.workspaceId)).toMatchObject({
        plan: null,
        subscription: null,
        comments: { used: 0, limit: 0, resetsAt: null },
      });
      for (const item of body.items) expect(item).not.toHaveProperty('credits');
    });

    it("pooled: the account's other workspace shows the same plan and comments", async () => {
      const [first] = (await list(`q=pooled-${P}`)).items;
      const [owner] = (
        await list(`q=${encodeURIComponent(`Zeta Store ${T}x1`)}`)
      ).items;
      expect(first).toMatchObject({
        id: pooled,
        plan: plan.growth,
        owner: null,
        memberCount: 0,
      });
      expect(first!.subscription).toEqual(owner!.subscription);
      expect(first!.comments).toEqual(owner!.comments);
      expect(first!.comments).toMatchObject({ used: 7 });
    });

    it.each([
      ['plan=growth', () => [a, d]],
      ['plan=starter', () => [b]],
      ['plan=pro', () => []],
      // C expired, M has no billing account.
      ['plan=none', () => [c, mod]],
      ['plan=none&status=ACTIVE', () => [mod]],
      ['plan=growth&createdFrom=2026-02-01', () => [d]],
    ])('filters %s on the live subscription', async (query, expected) => {
      expect(await ids(`${query}&sort=oldest`)).toEqual(
        expected().map((x) => x.workspaceId),
      );
    });

    it('plan=free (inactive, never live) → no rows, not a 400', async () => {
      expect(await ids('plan=free')).toEqual([]);
    });

    it('400 for an unknown plan slug', async () => {
      const res = await http()
        .get(`${CLIENTS}?plan=platinum`)
        .set('Cookie', superAdmin.cookie)
        .expect(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        message: 'Unknown plan: platinum',
      });
    });

    it('PATCH status answers with the same item shape (plan, subscription, comments)', async () => {
      const res = await patchStatus(a.workspaceId, {
        status: 'ACTIVE',
        reason: 'no-op check',
      }).expect(200);
      expect(res.body).toEqual({
        changed: false,
        client: (await list(`q=${encodeURIComponent(`Zeta Store ${T}x1`)}`))
          .items[0],
      });
      expect(res.body.client).toMatchObject({
        plan: plan.growth,
        subscription: { status: 'ACTIVE' },
        comments: { used: 7, limit: growthLimit },
      });
      expect(res.body.client).not.toHaveProperty('credits');
      expect(await auditRows(a.workspaceId)).toEqual([]);
    });

    it('403 for a normal user', async () => {
      await http().get(`${CLIENTS}?q=${T}`).set('Cookie', a.cookie).expect(403);
    });
  });

  describe('PATCH /api/admin/clients/:id/status', () => {
    const suspend = {
      status: 'SUSPENDED',
      reason: 'Repeated bKash scam reports',
    };

    async function expectUntouched() {
      expect(await statusOf(target.workspaceId)).toBe('ACTIVE');
      expect(await auditRows(target.workspaceId)).toEqual([]);
    }

    it('401 without a session', async () => {
      const res = await http()
        .patch(`${CLIENTS}/${target.workspaceId}/status`)
        .send(suspend);
      expect(res.status).toBe(401);
      await expectUntouched();
    });

    it('403 for a normal user (even the workspace owner)', async () => {
      for (const who of [target, member]) {
        const res = await patchStatus(target.workspaceId, suspend, who.cookie);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ message: 'Super admin only' });
      }
      await expectUntouched();
    });

    it('403 for impersonated sessions (super admin or client)', async () => {
      const adminCookie = await actors.signIn(superAdmin.email);
      await actors.patchStoredSession(adminCookie, {
        impersonatedBy: superAdmin.id,
      });
      const ownerCookie = await actors.signIn(target.email);
      await actors.patchStoredSession(ownerCookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: target.workspaceId,
      });
      for (const cookie of [adminCookie, ownerCookie]) {
        const res = await patchStatus(target.workspaceId, suspend, cookie);
        expect(res.status).toBe(403);
      }
      await expectUntouched();
    });

    it.each([
      ['unknown id', UNKNOWN_ID],
      ['malformed id', 'not-a-uuid'],
      ['SQL-ish id', "1'%20or%20'1'='1"],
    ])('404 for an %s', async (_label, id) => {
      const res = await patchStatus(id, suspend);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        statusCode: 404,
        message: 'Workspace not found',
      });
      expect(
        await db()
          .select()
          .from(workspaceStatusAuditLogs)
          .where(eq(workspaceStatusAuditLogs.adminId, superAdmin.id)),
      ).toEqual([]);
    });

    it.each([
      ['missing status', { reason: 'x' }],
      ['lower-case status', { status: 'suspended', reason: 'x' }],
      ['unknown status', { status: 'DELETED', reason: 'x' }],
      ['missing reason', { status: 'SUSPENDED' }],
      ['empty reason', { status: 'SUSPENDED', reason: '' }],
      ['blank reason', { status: 'SUSPENDED', reason: '   ' }],
      ['non-string reason', { status: 'SUSPENDED', reason: 7 }],
      ['501-char reason', { status: 'SUSPENDED', reason: 'x'.repeat(501) }],
      ['extra field', { ...suspend, note: 'x' }],
    ])('400 for %s', async (_label, body) => {
      const res = await patchStatus(target.workspaceId, body);
      expect(res.status).toBe(400);
      await expectUntouched();
    });

    it('a member is not blocked before the suspension', async () => {
      await http()
        .get(`/api/workspaces/${target.workspaceId}`)
        .set('Cookie', member.cookie)
        .expect(200);
    });

    it('suspends: 200 with the client item, one audit row with the trimmed reason', async () => {
      const before = Date.now();
      const res = await patchStatus(target.workspaceId, {
        status: 'SUSPENDED',
        reason: '  Repeated bKash scam reports  ',
      }).expect(200);
      expect(res.body).toEqual({
        changed: true,
        client: {
          id: target.workspaceId,
          name: expect.any(String),
          slug: expect.any(String),
          status: 'SUSPENDED',
          createdAt: expect.any(String),
          plan: { id: expect.any(String), slug: 'starter', name: 'Starter' },
          owner: { id: target.id, email: target.email, name: 'm2t3-target' },
          memberCount: 2,
          ...signUpTrial(),
        },
      });
      expect(await statusOf(target.workspaceId)).toBe('SUSPENDED');
      const rows = await auditRows(target.workspaceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        workspaceId: target.workspaceId,
        adminId: superAdmin.id,
        oldStatus: 'ACTIVE',
        newStatus: 'SUSPENDED',
        reason: 'Repeated bKash scam reports',
      });
      expect(Object.keys(rows[0]!).sort()).toEqual([
        'adminId',
        'createdAt',
        'id',
        'newStatus',
        'oldStatus',
        'reason',
        'workspaceId',
      ]);
      expect(rows[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );
    });

    it('is idempotent: same status again → 200, changed false, no new audit row', async () => {
      const res = await patchStatus(target.workspaceId.toUpperCase(), {
        status: 'SUSPENDED',
        reason: 'clicked twice',
      }).expect(200);
      expect(res.body).toMatchObject({
        changed: false,
        client: { id: target.workspaceId, status: 'SUSPENDED' },
      });
      expect(await auditRows(target.workspaceId)).toHaveLength(1);
    });

    it("guard only: members get 403 on the suspended workspace's routes but keep their sessions and other workspaces", async () => {
      for (const who of [member, target]) {
        const res = await http()
          .get(`/api/workspaces/${target.workspaceId}`)
          .set('Cookie', who.cookie);
        expect(res.status).toBe(403);
        expect(res.body).not.toHaveProperty('name');
      }
      const patch = await http()
        .patch(`/api/workspaces/${target.workspaceId}`)
        .set('Cookie', target.cookie)
        .send({ name: 'renamed while suspended' });
      expect(patch.status).toBe(403);
      // Sessions are not revoked: the member still works in their own (active) workspace.
      await http().get('/api/me').set('Cookie', member.cookie).expect(200);
      await http()
        .get(`/api/workspaces/${member.workspaceId}`)
        .set('Cookie', member.cookie)
        .expect(200);
    });

    it('the list shows the new status', async () => {
      const body = await list(
        `q=${encodeURIComponent(target.email)}&status=SUSPENDED`,
      );
      expect(body.items.map((i) => i.id)).toEqual([target.workspaceId]);
    });

    it('activates again: second audit row, members get access back', async () => {
      const res = await patchStatus(target.workspaceId, {
        status: 'ACTIVE',
        reason: 'Owner verified identity',
      }).expect(200);
      expect(res.body).toMatchObject({
        changed: true,
        client: { status: 'ACTIVE' },
      });
      const rows = await auditRows(target.workspaceId);
      expect(rows.map((r) => [r.oldStatus, r.newStatus, r.reason])).toEqual([
        ['ACTIVE', 'SUSPENDED', 'Repeated bKash scam reports'],
        ['SUSPENDED', 'ACTIVE', 'Owner verified identity'],
      ]);
      await http()
        .get(`/api/workspaces/${target.workspaceId}`)
        .set('Cookie', member.cookie)
        .expect(200);
    });
  });
});

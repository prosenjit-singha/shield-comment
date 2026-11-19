import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { asc, count, desc, eq, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import type { PlanAuditList } from '../src/admin/dto/plan-audit.dto.js';
import type {
  AdminPlansResponse,
  AdminPlanUpdateResponse,
} from '../src/admin/dto/plans.dto.js';
import { planAuditLogs, plans, workspaces } from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const PLANS = '/api/admin/settings/plans';
const AUDIT = `${PLANS}/audit`;
const OFFERS_MIGRATION = join(
  import.meta.dirname,
  '../drizzle/0008_plan_launch_offers.sql',
);
const CREDITS_MIGRATION = join(
  import.meta.dirname,
  '../drizzle/0018_plan_ai_credits.sql',
);
const UNKNOWN_ID = '01a1ecf3-0000-7000-8000-000000000000';

/**
 * M2-T11: plans table (seeded by migration `0007_seed_plans`, launch offers `0008_plan_launch_offers`)
 * + A7 plan settings API; M2-T15: plan audit log. Every plan this spec edits is restored in
 * `afterAll` and its audit rows are removed by `cleanup()`, so the test DB keeps exactly the
 * seeded rows and no audit rows.
 */
describe('Admin plan settings (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const http = () => actors.http();

  let superAdmin: Actor;
  let client: Actor;
  let seeded: (typeof plans.$inferSelect)[];

  const readPlans = () =>
    actors.db.select().from(plans).orderBy(asc(plans.sortOrder));
  const planBySlug = (slug: string) => seeded.find((p) => p.slug === slug)!;
  const auditRows = (planId?: string) =>
    actors.db
      .select()
      .from(planAuditLogs)
      .where(planId ? eq(planAuditLogs.planId, planId) : undefined)
      .orderBy(desc(planAuditLogs.createdAt), desc(planAuditLogs.id));
  const auditCount = async () =>
    (await actors.db.select({ n: count() }).from(planAuditLogs))[0]!.n;
  const patch = (id: string, body: unknown, cookie = superAdmin.cookie) =>
    http()
      .patch(`${PLANS}/${id}`)
      .set('Cookie', cookie)
      .send(body as object);

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    seeded = await readPlans();
    superAdmin = await actors.signUpSuperAdmin('m2t11-super');
    client = await actors.signUp('m2t11-client');
  });

  afterAll(async () => {
    if (actors && seeded) {
      // Restore every column (incl. `updatedAt`) of the plans this spec may have edited.
      for (const { id, ...row } of seeded) {
        await actors.db.update(plans).set(row).where(eq(plans.id, id));
      }
      expect(await readPlans()).toEqual(seeded);
    }
    await actors?.cleanup();
    await app?.close();
  });

  it('the migrations seeded the four tiers with the launch offers (client.md §7)', async () => {
    expect(
      seeded.map((p) => [
        p.slug,
        p.name,
        p.originalPriceBdt,
        p.offerPriceBdt,
        p.offerBadge,
      ]),
    ).toEqual([
      ['free', 'Free', 0, null, null],
      ['starter', 'Starter', 999, 499, '50% Launch Offer'],
      ['growth', 'Growth', 2499, 1499, '40% Off'],
      ['pro', 'Pro', 5999, 3999, '33% Off'],
    ]);
    // Data migrations write no audit rows.
    expect(await auditCount()).toBe(0);
  });

  it('the launch-offer migration is idempotent and only touches plans still at their seed values', async () => {
    const offersSql = readFileSync(OFFERS_MIGRATION, 'utf8');
    const rollback = new Error('rollback');
    await expect(
      actors.db.transaction(async (tx) => {
        // Already applied: running it again changes nothing.
        await tx.execute(sql.raw(offersSql));
        expect(
          await tx.select().from(plans).orderBy(asc(plans.sortOrder)),
        ).toEqual(seeded);
        // Back to the 0007 seed values, except growth (edited by an admin) and pro's badge.
        await tx
          .update(plans)
          .set({ offerPriceBdt: null, offerBadge: null })
          .where(sql`${plans.slug} in ('starter', 'growth', 'pro')`);
        await tx
          .update(plans)
          .set({ originalPriceBdt: 499 })
          .where(eq(plans.slug, 'starter'));
        await tx
          .update(plans)
          .set({ originalPriceBdt: 1799 })
          .where(eq(plans.slug, 'growth'));
        await tx
          .update(plans)
          .set({ originalPriceBdt: 3999, offerBadge: 'Hand-made' })
          .where(eq(plans.slug, 'pro'));
        await tx.execute(sql.raw(offersSql));
        const rows = await tx
          .select()
          .from(plans)
          .orderBy(asc(plans.sortOrder));
        expect(
          rows.map((p) => [
            p.slug,
            p.originalPriceBdt,
            p.offerPriceBdt,
            p.offerBadge,
          ]),
        ).toEqual([
          ['free', 0, null, null],
          ['starter', 999, 499, '50% Launch Offer'],
          ['growth', 1799, null, null],
          ['pro', 3999, null, 'Hand-made'],
        ]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await readPlans()).toEqual(seeded);
  });

  it('M5-T11: migration 0018 renamed monthlyComments → monthlyAiCredits (seeds kept, idempotent, admin edits kept)', async () => {
    // Applied: every plan carries the new key with the seed number, the old key is gone.
    expect(
      seeded.map((p) => [
        p.slug,
        (p.featureConfig.limits as Record<string, unknown>).monthlyAiCredits,
        'monthlyComments' in p.featureConfig.limits,
      ]),
    ).toEqual([
      ['free', 500, false],
      ['starter', 2500, false],
      ['growth', 15000, false],
      ['pro', 75000, false],
    ]);
    const creditsSql = readFileSync(CREDITS_MIGRATION, 'utf8');
    const rollback = new Error('rollback');
    await expect(
      actors.db.transaction(async (tx) => {
        // Already applied: running it again changes nothing.
        await tx.execute(sql.raw(creditsSql));
        expect(
          await tx.select().from(plans).orderBy(asc(plans.sortOrder)),
        ).toEqual(seeded);
        // Pre-0018 shapes: starter = admin-edited old key, growth = both keys (new wins).
        await tx.execute(sql`
          update plans set feature_config = jsonb_set(
            feature_config, '{limits}',
            ((feature_config->'limits') - 'monthlyAiCredits') || '{"monthlyComments": 3333}'::jsonb)
          where slug = 'starter'`);
        await tx.execute(sql`
          update plans set feature_config = jsonb_set(
            feature_config, '{limits}',
            (feature_config->'limits') || '{"monthlyComments": 1}'::jsonb)
          where slug = 'growth'`);
        await tx.execute(sql.raw(creditsSql));
        const rows = await tx
          .select()
          .from(plans)
          .orderBy(asc(plans.sortOrder));
        expect(rows.map((p) => [p.slug, p.featureConfig.limits])).toEqual([
          ['free', { connectedPages: 1, monthlyAiCredits: 500, teamSeats: 1 }],
          [
            'starter',
            { connectedPages: 1, monthlyAiCredits: 3333, teamSeats: 1 },
          ],
          [
            'growth',
            { connectedPages: 5, monthlyAiCredits: 15000, teamSeats: 3 },
          ],
          [
            'pro',
            { connectedPages: 25, monthlyAiCredits: 75000, teamSeats: 10 },
          ],
        ]);
        // `updated_at` untouched (data migration, same value).
        expect(rows.map((p) => p.updatedAt)).toEqual(
          seeded.map((p) => p.updatedAt),
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await readPlans()).toEqual(seeded);
    expect(await auditCount()).toBe(0);
  });

  describe('access', () => {
    it('401 when signed out (GET and PATCH)', async () => {
      await http().get(PLANS).expect(401);
      await http()
        .patch(`${PLANS}/${planBySlug('growth').id}`)
        .send({ originalPriceBdt: 1 })
        .expect(401);
    });

    it('403 for a normal user (workspace owner)', async () => {
      const res = await http()
        .get(PLANS)
        .set('Cookie', client.cookie)
        .expect(403);
      expect(res.body).toMatchObject({ message: 'Super admin only' });
      await patch(
        planBySlug('growth').id,
        { originalPriceBdt: 1 },
        client.cookie,
      ).expect(403);
    });

    it('403 for impersonated sessions (super admin or client)', async () => {
      const adminCookie = await actors.signIn(superAdmin.email);
      await actors.patchStoredSession(adminCookie, {
        impersonatedBy: superAdmin.id,
      });
      const ownerCookie = await actors.signIn(client.email);
      await actors.patchStoredSession(ownerCookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: client.workspaceId,
      });
      for (const cookie of [adminCookie, ownerCookie]) {
        await http().get(PLANS).set('Cookie', cookie).expect(403);
        await patch(
          planBySlug('growth').id,
          { originalPriceBdt: 1 },
          cookie,
        ).expect(403);
      }
      expect(await readPlans()).toEqual(seeded);
    });
  });

  describe('GET', () => {
    it('lists every plan ordered by sortOrder with a complete featureConfig', async () => {
      const res = await http()
        .get(PLANS)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      const body = res.body as AdminPlansResponse;
      expect(Object.keys(body)).toEqual(['items']);
      expect(body.items.map((p) => p.slug)).toEqual([
        'free',
        'starter',
        'growth',
        'pro',
      ]);
      expect(body.items.map((p) => p.sortOrder)).toEqual([0, 1, 2, 3]);
      const growth = body.items[2]!;
      expect(growth).toEqual({
        id: planBySlug('growth').id,
        slug: 'growth',
        name: 'Growth',
        sortOrder: 2,
        isActive: true,
        originalPriceBdt: 2499,
        offerPriceBdt: 1499,
        offerBadge: '40% Off',
        featureConfig: {
          limits: { connectedPages: 5, monthlyAiCredits: 15000, teamSeats: 3 },
          features: {
            banglaAiFilter: true,
            autoHideScams: true,
            customBlocklist: true,
            autoReplyTemplates: true,
            messengerAlerts: true,
            whiteLabelReports: false,
            prioritySupportApi: false,
          },
        },
        createdAt: expect.any(String) as string,
        updatedAt: expect.any(String) as string,
      });
      expect(body.items[3]!.featureConfig.limits).toEqual({
        connectedPages: 25,
        monthlyAiCredits: 75000,
        teamSeats: 10,
      });
      expect(
        Object.values(body.items[3]!.featureConfig.features).every(Boolean),
      ).toBe(true);
    });

    it('400 for any query param', async () => {
      await http()
        .get(`${PLANS}?active=true`)
        .set('Cookie', superAdmin.cookie)
        .expect(400);
    });
  });

  describe('PATCH /:planId', () => {
    it('updates prices, badge and featureConfig and persists them', async () => {
      const growth = planBySlug('growth');
      const res = await patch(growth.id, {
        originalPriceBdt: 2999,
        offerPriceBdt: 1999,
        offerBadge: '  33% Off  ',
        featureConfig: {
          limits: { teamSeats: 4 },
          features: { whiteLabelReports: true },
        },
      }).expect(200);
      const { plan } = res.body as AdminPlanUpdateResponse;
      expect(plan).toMatchObject({
        id: growth.id,
        slug: 'growth',
        originalPriceBdt: 2999,
        offerPriceBdt: 1999,
        offerBadge: '33% Off',
        featureConfig: {
          limits: { connectedPages: 5, monthlyAiCredits: 15000, teamSeats: 4 },
          features: { customBlocklist: true, whiteLabelReports: true },
        },
      });
      expect(Date.parse(plan.updatedAt)).toBeGreaterThan(
        growth.updatedAt.getTime(),
      );

      const list = await http()
        .get(PLANS)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      const items = (list.body as AdminPlansResponse).items;
      expect(items.find((p) => p.id === growth.id)).toEqual(plan);
      // Other plans are untouched.
      const others = (await readPlans()).filter((p) => p.id !== growth.id);
      expect(others).toEqual(seeded.filter((p) => p.id !== growth.id));
    });

    it('merges a partial featureConfig and keeps the other values', async () => {
      const growth = planBySlug('growth');
      const res = await patch(growth.id, {
        featureConfig: { features: { prioritySupportApi: true } },
      }).expect(200);
      const { plan } = res.body as AdminPlanUpdateResponse;
      expect(plan).toMatchObject({
        originalPriceBdt: 2999,
        offerPriceBdt: 1999,
        offerBadge: '33% Off',
      });
      expect(plan.featureConfig.limits.teamSeats).toBe(4);
      expect(plan.featureConfig.features).toMatchObject({
        whiteLabelReports: true,
        prioritySupportApi: true,
      });
    });

    it('null clears the offer and the badge', async () => {
      const res = await patch(planBySlug('growth').id, {
        offerPriceBdt: null,
        offerBadge: null,
      }).expect(200);
      expect((res.body as AdminPlanUpdateResponse).plan).toMatchObject({
        originalPriceBdt: 2999,
        offerPriceBdt: null,
        offerBadge: null,
      });
    });

    it('400 when the offer is above the original (body or stored value)', async () => {
      const starter = planBySlug('starter');
      const inBody = await patch(starter.id, {
        originalPriceBdt: 499,
        offerPriceBdt: 500,
      }).expect(400);
      expect(inBody.body).toMatchObject({
        message: expect.stringContaining('offerPriceBdt') as string,
      });
      await patch(starter.id, { offerPriceBdt: 299 }).expect(200);
      // Lowering the original below the stored offer is refused too.
      await patch(starter.id, { originalPriceBdt: 199 }).expect(400);
      const [row] = await actors.db
        .select()
        .from(plans)
        .where(eq(plans.id, starter.id));
      expect(row).toMatchObject({ originalPriceBdt: 999, offerPriceBdt: 299 });
    });

    it.each([
      ['empty body', {}],
      ['empty featureConfig', { featureConfig: {} }],
      ['negative price', { originalPriceBdt: -1 }],
      ['fractional price', { originalPriceBdt: 499.5 }],
      ['string price', { originalPriceBdt: '499' }],
      ['null original', { originalPriceBdt: null }],
      ['price above max', { originalPriceBdt: 1_000_001 }],
      ['negative offer', { offerPriceBdt: -1 }],
      ['badge over 40 chars', { offerBadge: 'x'.repeat(41) }],
      ['unknown field', { name: 'Gold' }],
      ['read-only field', { isActive: false }],
      ['featureConfig null', { featureConfig: null }],
      ['unknown limit key', { featureConfig: { limits: { storageGb: 5 } } }],
      [
        'unknown feature key',
        { featureConfig: { features: { aiImages: true } } },
      ],
      ['negative limit', { featureConfig: { limits: { teamSeats: -1 } } }],
      [
        'string flag',
        { featureConfig: { features: { customBlocklist: 'yes' } } },
      ],
    ])('400 for %s (plan unchanged, no audit row)', async (_label, body) => {
      const pro = planBySlug('pro');
      const res = await patch(pro.id, body);
      expect(res.status).toBe(400);
      expect(res.body).not.toHaveProperty('plan');
      expect(await auditRows(pro.id)).toEqual([]);
      const [row] = await actors.db
        .select()
        .from(plans)
        .where(eq(plans.id, pro.id));
      expect(row).toEqual(pro);
    });

    it('404 for an unknown or malformed plan id', async () => {
      const before = await auditCount();
      const res = await patch(UNKNOWN_ID, { originalPriceBdt: 1 }).expect(404);
      expect(res.body).toMatchObject({ message: 'Plan not found' });
      await patch('not-a-uuid', { originalPriceBdt: 1 }).expect(404);
      expect(await auditCount()).toBe(before);
    });
  });

  describe('audit log (M2-T15)', () => {
    const UA = 'Mozilla/5.0 (M2-T15 e2e)';

    it('a real change writes exactly one row: who, changed fields before → after, IP and UA', async () => {
      const free = planBySlug('free');
      const before = await auditCount();
      const res = await patch(free.id, {
        offerBadge: 'Always free',
        // Same values as stored: not part of the diff.
        originalPriceBdt: 0,
        featureConfig: {
          limits: { monthlyAiCredits: 750, teamSeats: 1 },
          features: { customBlocklist: true, banglaAiFilter: true },
        },
      })
        .set('X-Forwarded-For', '203.0.113.7, 10.0.0.2')
        .set('User-Agent', UA)
        .expect(200);
      // Response shape unchanged.
      expect(Object.keys(res.body as object)).toEqual(['plan']);
      expect(await auditCount()).toBe(before + 1);
      const rows = await auditRows(free.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: expect.any(String) as string,
        planId: free.id,
        adminId: superAdmin.id,
        action: 'UPDATE',
        changes: [
          { field: 'offerBadge', before: null, after: 'Always free' },
          {
            field: 'featureConfig.limits.monthlyAiCredits',
            before: 500,
            after: 750,
          },
          {
            field: 'featureConfig.features.customBlocklist',
            before: false,
            after: true,
          },
        ],
        ipAddress: '203.0.113.7',
        userAgent: UA,
        createdAt: expect.any(Date) as Date,
      });
    });

    it('a no-op PATCH (stored values re-sent) writes no row and keeps updatedAt', async () => {
      const [stored] = await actors.db
        .select()
        .from(plans)
        .where(eq(plans.slug, 'free'));
      const before = await auditCount();
      const res = await patch(stored!.id, {
        offerBadge: '  Always free ',
        offerPriceBdt: null,
        featureConfig: { limits: { monthlyAiCredits: 750 } },
      }).expect(200);
      const { plan } = res.body as AdminPlanUpdateResponse;
      expect(plan.updatedAt).toBe(stored!.updatedAt.toISOString());
      expect(plan.featureConfig.limits.monthlyAiCredits).toBe(750);
      expect(await auditCount()).toBe(before);
      const [row] = await actors.db
        .select()
        .from(plans)
        .where(eq(plans.id, stored!.id));
      expect(row).toEqual(stored);
    });

    it('400 (validation or offer > original) and impersonated 403 write no row', async () => {
      const free = planBySlug('free');
      const before = await auditCount();
      await patch(free.id, { originalPriceBdt: 'x' }).expect(400);
      // The old limit name is an unknown key now (M5-T11).
      await patch(free.id, {
        featureConfig: { limits: { monthlyComments: 600 } },
      }).expect(400);
      await patch(free.id, { offerPriceBdt: 1 }).expect(400);
      const cookie = await actors.signIn(superAdmin.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
      });
      await patch(free.id, { offerBadge: 'Nope' }, cookie).expect(403);
      expect(await auditCount()).toBe(before);
    });

    it('records clearing values as → null and keeps rows per plan', async () => {
      const growth = planBySlug('growth');
      await patch(growth.id, {
        offerPriceBdt: 1299,
        offerBadge: 'Flash sale',
      }).expect(200);
      await patch(growth.id, { offerPriceBdt: null }).expect(200);
      const [latest] = await auditRows(growth.id);
      expect(latest!.changes).toEqual([
        { field: 'offerPriceBdt', before: 1299, after: null },
      ]);
      expect(latest!.ipAddress).toEqual(expect.any(String));
    });

    describe('GET /audit', () => {
      it('401 signed out, 403 for a normal user and impersonated sessions', async () => {
        await http().get(AUDIT).expect(401);
        await http().get(AUDIT).set('Cookie', client.cookie).expect(403);
        const adminCookie = await actors.signIn(superAdmin.email);
        await actors.patchStoredSession(adminCookie, {
          impersonatedBy: superAdmin.id,
        });
        const ownerCookie = await actors.signIn(client.email);
        await actors.patchStoredSession(ownerCookie, {
          impersonatedBy: superAdmin.id,
          activeOrganizationId: client.workspaceId,
        });
        for (const cookie of [adminCookie, ownerCookie]) {
          await http().get(AUDIT).set('Cookie', cookie).expect(403);
        }
      });

      it('lists every edit newest first with plan + admin, default paging', async () => {
        const res = await http()
          .get(AUDIT)
          .set('Cookie', superAdmin.cookie)
          .expect(200);
        const body = res.body as PlanAuditList;
        const rows = await auditRows();
        expect(rows.length).toBeGreaterThanOrEqual(5);
        expect(body).toMatchObject({ total: rows.length, skip: 0, take: 50 });
        expect(body.items.map((i) => i.id)).toEqual(rows.map((r) => r.id));
        const times = body.items.map((i) => Date.parse(i.createdAt));
        expect(times).toEqual([...times].sort((a, b) => b - a));
        // Newest = the growth "offer cleared" edit.
        expect(body.items[0]).toEqual({
          id: rows[0]!.id,
          plan: { id: planBySlug('growth').id, slug: 'growth', name: 'Growth' },
          admin: {
            id: superAdmin.id,
            name: expect.any(String) as string,
            email: superAdmin.email,
          },
          action: 'UPDATE',
          changes: [{ field: 'offerPriceBdt', before: 1299, after: null }],
          ip: rows[0]!.ipAddress,
          userAgent: rows[0]!.userAgent,
          createdAt: rows[0]!.createdAt.toISOString(),
        });
        const freeEntry = body.items.find(
          (i) => i.plan.slug === 'free' && i.userAgent === UA,
        );
        expect(freeEntry).toMatchObject({ ip: '203.0.113.7' });
      });

      it('pages with skip/take and filters by planId', async () => {
        const all = await auditRows();
        const page = await http()
          .get(`${AUDIT}?skip=1&take=2`)
          .set('Cookie', superAdmin.cookie)
          .expect(200);
        const body = page.body as PlanAuditList;
        expect(body).toMatchObject({ total: all.length, skip: 1, take: 2 });
        expect(body.items.map((i) => i.id)).toEqual(
          all.slice(1, 3).map((r) => r.id),
        );

        const growth = planBySlug('growth');
        const filtered = await http()
          .get(`${AUDIT}?planId=${growth.id.toUpperCase()}`)
          .set('Cookie', superAdmin.cookie)
          .expect(200);
        const growthRows = await auditRows(growth.id);
        const fBody = filtered.body as PlanAuditList;
        expect(fBody.total).toBe(growthRows.length);
        expect(fBody.items.map((i) => i.id)).toEqual(
          growthRows.map((r) => r.id),
        );
        expect(fBody.items.every((i) => i.plan.id === growth.id)).toBe(true);

        const unknown = await http()
          .get(`${AUDIT}?planId=${UNKNOWN_ID}`)
          .set('Cookie', superAdmin.cookie)
          .expect(200);
        expect(unknown.body).toEqual({
          items: [],
          total: 0,
          skip: 0,
          take: 50,
        });

        const beyond = await http()
          .get(`${AUDIT}?skip=1000`)
          .set('Cookie', superAdmin.cookie)
          .expect(200);
        expect(beyond.body).toMatchObject({ items: [], total: all.length });
      });

      it.each([
        ['unknown param', 'action=UPDATE'],
        ['malformed planId', 'planId=not-a-uuid'],
        ['take above 100', 'take=101'],
        ['take 0', 'take=0'],
        ['negative skip', 'skip=-1'],
        ['text skip', 'skip=abc'],
      ])('400 for %s', async (_label, query) => {
        await http()
          .get(`${AUDIT}?${query}`)
          .set('Cookie', superAdmin.cookie)
          .expect(400);
      });
    });
  });

  it('M5-T11: an old audit row keeps its old field name (featureConfig.limits.monthlyComments)', async () => {
    const pro = planBySlug('pro');
    const [old] = await actors.db
      .insert(planAuditLogs)
      .values({
        planId: pro.id,
        adminId: superAdmin.id,
        action: 'UPDATE',
        changes: [
          {
            field: 'featureConfig.limits.monthlyComments',
            before: 75000,
            after: 80000,
          },
        ],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      .returning();
    const res = await http()
      .get(`${AUDIT}?planId=${pro.id}&take=100`)
      .set('Cookie', superAdmin.cookie)
      .expect(200);
    const entry = (res.body as PlanAuditList).items.find(
      (i) => i.id === old!.id,
    );
    expect(entry?.changes).toEqual([
      {
        field: 'featureConfig.limits.monthlyComments',
        before: 75000,
        after: 80000,
      },
    ]);
  });

  describe('workspaces.plan_id', () => {
    it('is null by default and a plan in use cannot be deleted (FK restrict)', async () => {
      const [ws] = await actors.db
        .select({ planId: workspaces.planId })
        .from(workspaces)
        .where(eq(workspaces.id, client.workspaceId));
      expect(ws).toEqual({ planId: null });

      const free = planBySlug('free');
      await actors.db
        .update(workspaces)
        .set({ planId: free.id })
        .where(eq(workspaces.id, client.workspaceId));
      await expect(
        actors.db.delete(plans).where(eq(plans.id, free.id)),
      ).rejects.toThrow();
      await actors.db
        .update(workspaces)
        .set({ planId: null })
        .where(eq(workspaces.id, client.workspaceId));
    });
  });
});

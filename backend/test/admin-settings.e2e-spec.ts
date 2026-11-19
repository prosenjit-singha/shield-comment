import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { asc, count, desc, eq, type SQL, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import type { PlanAuditList } from '../src/admin/dto/plan-audit.dto.js';
import type {
  AdminPlansResponse,
  AdminPlanUpdateResponse,
} from '../src/admin/dto/plans.dto.js';
import { planAuditLogs, plans } from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const PLANS = '/api/admin/settings/plans';
const AUDIT = `${PLANS}/audit`;
const OFFERS_MIGRATION = join(
  import.meta.dirname,
  '../drizzle/0008_plan_launch_offers.sql',
);
const PLAN_DATA_MIGRATION = join(
  import.meta.dirname,
  '../drizzle/0022_plan_trial_yearly_workspaces.sql',
);
const UNKNOWN_ID = '01a1ecf3-0000-7000-8000-000000000000';

/**
 * Replays a data migration written before 0027 (it names `original_price_bdt`): the column gets
 * its old name for the statement only. Callers run it inside a rolled-back transaction.
 */
async function runPre0027Sql(
  tx: { execute: (query: SQL) => PromiseLike<unknown> },
  text: string,
): Promise<void> {
  await tx.execute(
    sql`alter table plans rename column monthly_price_bdt to original_price_bdt`,
  );
  await tx.execute(sql.raw(text));
  await tx.execute(
    sql`alter table plans rename column original_price_bdt to monthly_price_bdt`,
  );
}

/**
 * M2-T11: plans table (seeded by migration `0007_seed_plans`, launch offers `0008_plan_launch_offers`,
 * PW data `0022_plan_trial_yearly_workspaces`) + A7 plan settings API; M2-T15: plan audit log;
 * PW-T1b: yearly price, trial fields, `monthlyComments` + `workspaces` limits, inactive `free`. Every plan this spec edits is restored in
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
        p.monthlyPriceBdt,
        p.offerPriceBdt,
        p.offerBadge,
        p.yearlyMonthlyPriceBdt,
        p.trialDays,
        p.trialCommentLimit,
        p.isActive,
      ]),
    ).toEqual([
      ['free', 'Free', 0, null, null, null, null, null, false],
      // Yearly = list price since 0027 (PR-T1): 449 / 1,349 / 3,599 + the launch offer value.
      ['starter', 'Starter', 999, 499, '50% Launch Offer', 949, 7, 300, true],
      ['growth', 'Growth', 2499, 1499, '40% Off', 2349, null, null, true],
      ['pro', 'Pro', 5999, 3999, '33% Off', 5599, null, null, true],
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
        await runPre0027Sql(tx, offersSql);
        expect(
          await tx.select().from(plans).orderBy(asc(plans.sortOrder)),
        ).toEqual(seeded);
        // Back to the 0007 seed values, except growth (edited by an admin) and pro's badge.
        await tx
          .update(plans)
          // The yearly list price (0027) would exceed the lowered list prices below.
          .set({
            offerPriceBdt: null,
            offerBadge: null,
            yearlyMonthlyPriceBdt: null,
          })
          .where(sql`${plans.slug} in ('starter', 'growth', 'pro')`);
        await tx
          .update(plans)
          .set({ monthlyPriceBdt: 499 })
          .where(eq(plans.slug, 'starter'));
        await tx
          .update(plans)
          .set({ monthlyPriceBdt: 1799 })
          .where(eq(plans.slug, 'growth'));
        await tx
          .update(plans)
          .set({ monthlyPriceBdt: 3999, offerBadge: 'Hand-made' })
          .where(eq(plans.slug, 'pro'));
        await runPre0027Sql(tx, offersSql);
        const rows = await tx
          .select()
          .from(plans)
          .orderBy(asc(plans.sortOrder));
        expect(
          rows.map((p) => [
            p.slug,
            p.monthlyPriceBdt,
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

  it('PW-T1b: migration 0022 (monthlyComments + workspaces, Starter trial, yearly prices, free inactive; idempotent, admin edits kept)', async () => {
    // Applied: the renamed key with the seed numbers, the workspace limits, no old key.
    expect(seeded.map((p) => [p.slug, p.featureConfig.limits])).toEqual([
      [
        'free',
        {
          connectedPages: 1,
          monthlyComments: 500,
          teamSeats: 1,
          workspaces: 1,
        },
      ],
      [
        'starter',
        {
          connectedPages: 1,
          monthlyComments: 2500,
          teamSeats: 1,
          workspaces: 1,
        },
      ],
      [
        'growth',
        {
          connectedPages: 5,
          monthlyComments: 15000,
          teamSeats: 3,
          workspaces: 3,
        },
      ],
      [
        'pro',
        {
          connectedPages: 25,
          monthlyComments: 75000,
          teamSeats: 10,
          workspaces: 10,
        },
      ],
    ]);
    const dataSql = readFileSync(PLAN_DATA_MIGRATION, 'utf8');
    const rollback = new Error('rollback');
    const pick = (rows: (typeof plans.$inferSelect)[]) =>
      rows.map((p) => [
        p.slug,
        p.featureConfig.limits,
        p.yearlyMonthlyPriceBdt,
        p.trialDays,
        p.trialCommentLimit,
        p.isActive,
      ]);
    await expect(
      actors.db.transaction(async (tx) => {
        const read = () =>
          tx.select().from(plans).orderBy(asc(plans.sortOrder));
        // Already applied: running it again changes nothing.
        await runPre0027Sql(tx, dataSql);
        expect(await read()).toEqual(seeded);
        // Back to the pre-0022 shape (raw SQL: `updated_at` untouched): old key, no workspaces,
        // no yearly/trial values, free active. Admin edits made before the migration:
        // starter = edited old key 3333 + trial days 14 · growth = both keys (new wins) + offer
        // lowered to ৳1,000 (below the ৳1,349 yearly seed) · pro = workspaces 7 + yearly ৳3,000.
        await tx.execute(sql`
          update plans set
            feature_config = jsonb_set(feature_config, '{limits}',
              ((feature_config->'limits') - 'monthlyComments' - 'workspaces')
                || jsonb_build_object('monthlyAiCredits', feature_config->'limits'->'monthlyComments')),
            yearly_monthly_price_bdt = null, trial_days = null, trial_comment_limit = null,
            is_active = true`);
        await tx.execute(sql`
          update plans set trial_days = 14,
            feature_config = jsonb_set(feature_config, '{limits,monthlyAiCredits}', '3333')
          where slug = 'starter'`);
        await tx.execute(sql`
          update plans set offer_price_bdt = 1000,
            feature_config = jsonb_set(feature_config, '{limits,monthlyComments}', '1')
          where slug = 'growth'`);
        await tx.execute(sql`
          update plans set yearly_monthly_price_bdt = 3000,
            feature_config = jsonb_set(feature_config, '{limits,workspaces}', '7')
          where slug = 'pro'`);
        await runPre0027Sql(tx, dataSql);
        const once = await read();
        expect(pick(once)).toEqual([
          [
            'free',
            {
              connectedPages: 1,
              monthlyComments: 500,
              teamSeats: 1,
              workspaces: 1,
            },
            null,
            null,
            null,
            false,
          ],
          [
            'starter',
            {
              connectedPages: 1,
              monthlyComments: 3333,
              teamSeats: 1,
              workspaces: 1,
            },
            449,
            14,
            300,
            true,
          ],
          [
            'growth',
            {
              connectedPages: 5,
              monthlyComments: 1,
              teamSeats: 3,
              workspaces: 3,
            },
            // ৳1,349 > the ৳1,000 monthly price: skipped (the admin sets one in A7).
            null,
            null,
            null,
            true,
          ],
          [
            'pro',
            {
              connectedPages: 25,
              monthlyComments: 75000,
              teamSeats: 10,
              workspaces: 7,
            },
            3000,
            null,
            null,
            true,
          ],
        ]);
        expect(
          once.some((p) => 'monthlyAiCredits' in p.featureConfig.limits),
        ).toBe(false);
        // `updated_at` untouched (data migration, not an admin edit).
        expect(once.map((p) => p.updatedAt)).toEqual(
          seeded.map((p) => p.updatedAt),
        );
        // A second run changes nothing.
        await runPre0027Sql(tx, dataSql);
        expect(await read()).toEqual(once);
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
    it('lists the active plans ordered by sortOrder with a complete featureConfig (inactive free left out)', async () => {
      const res = await http()
        .get(PLANS)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      const body = res.body as AdminPlansResponse;
      expect(Object.keys(body)).toEqual(['items']);
      expect(body.items.map((p) => p.slug)).toEqual([
        'starter',
        'growth',
        'pro',
      ]);
      expect(body.items.map((p) => p.sortOrder)).toEqual([1, 2, 3]);
      expect(body.items[0]).toMatchObject({
        yearlyMonthlyPriceBdt: 949,
        trialDays: 7,
        trialCommentLimit: 300,
      });
      const growth = body.items[1]!;
      expect(growth).toEqual({
        id: planBySlug('growth').id,
        slug: 'growth',
        name: 'Growth',
        sortOrder: 2,
        isActive: true,
        originalPriceBdt: 2499,
        offerPriceBdt: 1499,
        offerBadge: '40% Off',
        yearlyMonthlyPriceBdt: 2349,
        trialDays: null,
        trialCommentLimit: null,
        featureConfig: {
          limits: {
            connectedPages: 5,
            monthlyComments: 15000,
            teamSeats: 3,
            workspaces: 3,
          },
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
      expect(body.items[2]!.featureConfig.limits).toEqual({
        connectedPages: 25,
        monthlyComments: 75000,
        teamSeats: 10,
        workspaces: 10,
      });
      expect(
        Object.values(body.items[2]!.featureConfig.features).every(Boolean),
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
          limits: {
            connectedPages: 5,
            monthlyComments: 15000,
            teamSeats: 4,
            workspaces: 3,
          },
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
      // Offer and yearly together (the yearly price is capped by the list price since PR-T1).
      await patch(starter.id, {
        offerPriceBdt: 299,
        yearlyMonthlyPriceBdt: 249,
      }).expect(200);
      // Lowering the original below the stored offer is refused too.
      await patch(starter.id, { originalPriceBdt: 199 }).expect(400);
      const [row] = await actors.db
        .select()
        .from(plans)
        .where(eq(plans.id, starter.id));
      expect(row).toMatchObject({
        monthlyPriceBdt: 999,
        offerPriceBdt: 299,
        yearlyMonthlyPriceBdt: 249,
      });
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
      // PW-T1b
      [
        'old limit name monthlyAiCredits',
        { featureConfig: { limits: { monthlyAiCredits: 600 } } },
      ],
      [
        'workspaces above max',
        { featureConfig: { limits: { workspaces: 1001 } } },
      ],
      ['negative yearly price', { yearlyMonthlyPriceBdt: -1 }],
      ['string yearly price', { yearlyMonthlyPriceBdt: '3000' }],
      ['yearly above the monthly list price', { yearlyMonthlyPriceBdt: 6000 }],
      [
        'list price lowered below the stored yearly price',
        { originalPriceBdt: 5500 },
      ],
      [
        'offer cleared + original lowered below the stored yearly price',
        { offerPriceBdt: null, originalPriceBdt: 3000 },
      ],
      ['trialDays on a non-Starter plan', { trialDays: 7 }],
      ['trialCommentLimit on a non-Starter plan', { trialCommentLimit: 0 }],
      ['trialDays 0', { trialDays: 0 }],
      ['trialDays 91', { trialDays: 91 }],
      ['trialCommentLimit above max', { trialCommentLimit: 10_000_001 }],
      ['negative trialCommentLimit', { trialCommentLimit: -1 }],
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
          limits: { monthlyComments: 750, teamSeats: 1 },
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
            field: 'featureConfig.limits.monthlyComments',
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
        featureConfig: { limits: { monthlyComments: 750 } },
      }).expect(200);
      const { plan } = res.body as AdminPlanUpdateResponse;
      expect(plan.updatedAt).toBe(stored!.updatedAt.toISOString());
      expect(plan.featureConfig.limits.monthlyComments).toBe(750);
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
      // The M5-T11 limit name is an unknown key now (PW-T1b).
      await patch(free.id, {
        featureConfig: { limits: { monthlyAiCredits: 600 } },
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
        offerPriceBdt: 1399,
        offerBadge: 'Flash sale',
      }).expect(200);
      await patch(growth.id, { offerPriceBdt: null }).expect(200);
      const [latest] = await auditRows(growth.id);
      expect(latest!.changes).toEqual([
        { field: 'offerPriceBdt', before: 1399, after: null },
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
          changes: [{ field: 'offerPriceBdt', before: 1399, after: null }],
          ip: rows[0]!.ipAddress,
          userAgent: rows[0]!.userAgent,
          createdAt: rows[0]!.createdAt.toISOString(),
        });
        // The inactive free plan (PW-D7) is left out of the editor list, but its rows still show.
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

  it('old audit rows keep their field names (pre-M5-T11 monthlyComments, M5-T11 monthlyAiCredits)', async () => {
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
          {
            field: 'featureConfig.limits.monthlyAiCredits',
            before: 80000,
            after: 75000,
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
    expect(entry?.changes).toEqual(old!.changes);
  });

  describe('PW-T1b: yearly price, trial fields, new limit keys', () => {
    it('round-trips the yearly price and the new limits; null clears; one audit row per edit', async () => {
      const pro = planBySlug('pro');
      const res = await patch(pro.id, {
        yearlyMonthlyPriceBdt: 3499,
        featureConfig: { limits: { monthlyComments: 80000, workspaces: 12 } },
      }).expect(200);
      expect((res.body as AdminPlanUpdateResponse).plan).toMatchObject({
        yearlyMonthlyPriceBdt: 3499,
        trialDays: null,
        trialCommentLimit: null,
        featureConfig: {
          limits: {
            connectedPages: 25,
            monthlyComments: 80000,
            teamSeats: 10,
            workspaces: 12,
          },
        },
      });
      let [latest] = await auditRows(pro.id);
      expect(latest!.changes).toEqual([
        { field: 'yearlyMonthlyPriceBdt', before: 5599, after: 3499 },
        {
          field: 'featureConfig.limits.monthlyComments',
          before: 75000,
          after: 80000,
        },
        { field: 'featureConfig.limits.workspaces', before: 10, after: 12 },
      ]);

      // Equal to the monthly list price is allowed (PR-T1: above the offer is fine too).
      await patch(pro.id, { yearlyMonthlyPriceBdt: 5999 }).expect(200);
      const cleared = await patch(pro.id, {
        yearlyMonthlyPriceBdt: null,
      }).expect(200);
      expect(
        (cleared.body as AdminPlanUpdateResponse).plan.yearlyMonthlyPriceBdt,
      ).toBeNull();
      [latest] = await auditRows(pro.id);
      expect(latest!.changes).toEqual([
        { field: 'yearlyMonthlyPriceBdt', before: 5999, after: null },
      ]);
      await patch(pro.id, { offerPriceBdt: 2999 }).expect(200);

      const list = await http()
        .get(PLANS)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      expect(
        (list.body as AdminPlansResponse).items.find((p) => p.id === pro.id),
      ).toMatchObject({
        offerPriceBdt: 2999,
        yearlyMonthlyPriceBdt: null,
        featureConfig: { limits: { monthlyComments: 80000, workspaces: 12 } },
      });
    });

    it('edits and clears the Starter trial fields (audited under plain field names)', async () => {
      const starter = planBySlug('starter');
      const set = await patch(starter.id, {
        trialDays: 14,
        trialCommentLimit: 500,
      }).expect(200);
      expect((set.body as AdminPlanUpdateResponse).plan).toMatchObject({
        trialDays: 14,
        trialCommentLimit: 500,
      });
      let [latest] = await auditRows(starter.id);
      expect(latest!.changes).toEqual([
        { field: 'trialDays', before: 7, after: 14 },
        { field: 'trialCommentLimit', before: 300, after: 500 },
      ]);
      // Bounds are accepted.
      await patch(starter.id, {
        trialDays: 90,
        trialCommentLimit: 10_000_000,
      }).expect(200);
      await patch(starter.id, { trialDays: 1, trialCommentLimit: 0 }).expect(
        200,
      );
      const cleared = await patch(starter.id, {
        trialDays: null,
        trialCommentLimit: null,
      }).expect(200);
      expect((cleared.body as AdminPlanUpdateResponse).plan).toMatchObject({
        trialDays: null,
        trialCommentLimit: null,
      });
      [latest] = await auditRows(starter.id);
      expect(latest!.changes).toEqual([
        { field: 'trialDays', before: 1, after: null },
        { field: 'trialCommentLimit', before: 0, after: null },
      ]);
      // Out of range on Starter → 400, nothing written.
      const before = await auditCount();
      await patch(starter.id, { trialDays: 91 }).expect(400);
      await patch(starter.id, { trialCommentLimit: -1 }).expect(400);
      expect(await auditCount()).toBe(before);
    });

    it('a trial field on the inactive free plan → 400; free stays editable otherwise', async () => {
      const free = planBySlug('free');
      const res = await patch(free.id, { trialDays: 7 }).expect(400);
      expect(res.body).toMatchObject({
        message: expect.stringContaining('starter') as string,
      });
      // Clearing (already null) is a no-op, not an error.
      await patch(free.id, { trialDays: null }).expect(200);
    });
  });

  describe('plans in use', () => {
    it('a plan with subscriptions cannot be deleted (FK restrict; PW-T6b dropped workspaces.plan_id)', async () => {
      // Every sign-up runs a Starter trial (PW-T3).
      const starter = planBySlug('starter');
      await expect(
        actors.db.delete(plans).where(eq(plans.id, starter.id)),
      ).rejects.toThrow();
    });
  });
});

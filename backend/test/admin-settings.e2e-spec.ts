import type { INestApplication } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import type {
  AdminPlansResponse,
  AdminPlanUpdateResponse,
} from '../src/admin/dto/plans.dto.js';
import { plans, workspaces } from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const PLANS = '/api/admin/settings/plans';
const UNKNOWN_ID = '01a1ecf3-0000-7000-8000-000000000000';

/**
 * M2-T11: plans table (seeded by migration `0007_seed_plans`) + A7 plan settings API.
 * Every plan this spec edits is restored in `afterAll`, so the test DB keeps exactly the
 * seeded rows.
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

  it('the migration seeded the four tiers with the agreed monthly prices', () => {
    expect(
      seeded.map((p) => [p.slug, p.name, p.originalPriceBdt, p.offerPriceBdt]),
    ).toEqual([
      ['free', 'Free', 0, null],
      ['starter', 'Starter', 499, null],
      ['growth', 'Growth', 1499, null],
      ['pro', 'Pro', 3999, null],
    ]);
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
        originalPriceBdt: 1499,
        offerPriceBdt: null,
        offerBadge: null,
        featureConfig: {
          limits: { connectedPages: 5, monthlyComments: 15000, teamSeats: 3 },
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
        monthlyComments: 75000,
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
        originalPriceBdt: 2499,
        offerPriceBdt: 1499,
        offerBadge: '  40% Off  ',
        featureConfig: {
          limits: { teamSeats: 4 },
          features: { whiteLabelReports: true },
        },
      }).expect(200);
      const { plan } = res.body as AdminPlanUpdateResponse;
      expect(plan).toMatchObject({
        id: growth.id,
        slug: 'growth',
        originalPriceBdt: 2499,
        offerPriceBdt: 1499,
        offerBadge: '40% Off',
        featureConfig: {
          limits: { connectedPages: 5, monthlyComments: 15000, teamSeats: 4 },
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
        originalPriceBdt: 2499,
        offerPriceBdt: 1499,
        offerBadge: '40% Off',
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
        originalPriceBdt: 2499,
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
      expect(row).toMatchObject({ originalPriceBdt: 499, offerPriceBdt: 299 });
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
    ])('400 for %s (plan unchanged)', async (_label, body) => {
      const pro = planBySlug('pro');
      const res = await patch(pro.id, body);
      expect(res.status).toBe(400);
      expect(res.body).not.toHaveProperty('plan');
      const [row] = await actors.db
        .select()
        .from(plans)
        .where(eq(plans.id, pro.id));
      expect(row).toEqual(pro);
    });

    it('404 for an unknown or malformed plan id', async () => {
      const res = await patch(UNKNOWN_ID, { originalPriceBdt: 1 }).expect(404);
      expect(res.body).toMatchObject({ message: 'Plan not found' });
      await patch('not-a-uuid', { originalPriceBdt: 1 }).expect(404);
    });
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

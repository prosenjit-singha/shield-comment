import type { INestApplication } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import type {
  AdminPromotion,
  AdminPromotionRedemptionsResponse,
  AdminPromotionResponse,
  AdminPromotionsResponse,
} from '../src/admin/dto/promotions.dto.js';
import type { PlatformSettings } from '../src/admin/dto/platform-settings.dto.js';
import { dhakaDate } from '../src/admin/manual-activation.js';
import {
  platformSettings,
  plans,
  promotionPlans,
  promotions,
  workspaces,
} from '../src/db/schema/index.js';
import { PromotionService } from '../src/promotions/promotion.service.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const API = '/api/admin/promotions';
const PLATFORM = '/api/admin/settings/platform';
const UNKNOWN_ID = '01a1ecf3-0000-7000-8000-000000000000';
const DAY = 86_400_000;
/** Valid DISCOUNT money terms (no targets: the cases add them). */
const DISCOUNT_TERMS = {
  kind: 'DISCOUNT',
  discountType: 'FLAT',
  discountValue: 200,
  discountScope: 'PER_MONTH',
};

/**
 * PR-T4: admin promotions API (`/api/admin/promotions`) + support WhatsApp number
 * (`/api/admin/settings/platform`); user decisions 2026-11-20 PR-D2, D18, reading 8. Real
 * Postgres. Promotions the super admin creates (and their claims/targets) are removed by
 * `cleanup()`; seeds stopped here are un-stopped there; the `platform_settings` row is deleted in
 * `afterAll`.
 */
describe('Admin promotions API (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let service: PromotionService;
  let superAdmin: Actor;
  let client: Actor;
  let client2: Actor;
  const planIds: Record<string, string> = {};
  const tag = `${Date.now()}`.slice(-6);

  const http = () => actors.http();
  const as = (cookie: string) => ({
    get: (url: string) => http().get(url).set('Cookie', cookie),
    post: (url: string, body: object = {}) =>
      http().post(url).set('Cookie', cookie).send(body),
    patch: (url: string, body: object) =>
      http().patch(url).set('Cookie', cookie).send(body),
  });
  const admin = () => as(superAdmin.cookie);

  const create = async (body: object): Promise<AdminPromotion> =>
    ((await admin().post(API, body).expect(201)).body as AdminPromotionResponse)
      .promotion;
  const discountBody = (patch: object = {}) => ({
    kind: 'DISCOUNT',
    name: `PR-T4 discount ${tag}`,
    planIds: [planIds.growth],
    discountType: 'FLAT',
    discountValue: 200,
    discountScope: 'PER_MONTH',
    durationMonths: 3,
    ...patch,
  });
  const redeem = async (promotionId: string, actor: Actor, slug = 'growth') =>
    actors.db.transaction(async (tx) =>
      service.redeem(tx, {
        promotionId,
        accountId: await actors.accountIdOf(actor),
        planId: planIds[slug]!,
        discountBdtFirstTerm: 200,
        monthsUsed: 1,
      }),
    );

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    service = app.get(PromotionService);
    superAdmin = await actors.signUpSuperAdmin('prt4-super');
    client = await actors.signUp('prt4-client');
    client2 = await actors.signUp('prt4-client2');
    for (const row of await actors.db
      .select({ id: plans.id, slug: plans.slug })
      .from(plans))
      planIds[row.slug] = row.id;
  });

  afterAll(async () => {
    if (actors) await actors.db.delete(platformSettings);
    await actors?.cleanup();
    await app?.close();
  });

  describe('access (SuperAdminGuard)', () => {
    const routes = (): [string, string, object?][] => [
      ['get', API],
      ['post', API, discountBody()],
      ['patch', `${API}/${UNKNOWN_ID}`, { name: 'x' }],
      ['post', `${API}/${UNKNOWN_ID}/stop`],
      ['get', `${API}/${UNKNOWN_ID}/redemptions`],
      ['get', PLATFORM],
      ['patch', PLATFORM, { supportWhatsappNumber: null }],
    ];
    const call = (
      method: string,
      url: string,
      body: object | undefined,
      cookie?: string,
    ) => {
      const req =
        method === 'get'
          ? http().get(url)
          : method === 'post'
            ? http().post(url)
            : http().patch(url);
      if (cookie) req.set('Cookie', cookie);
      return method === 'get' ? req : req.send(body ?? {});
    };

    it('401 signed out, 403 for a client and for impersonated sessions; nothing written', async () => {
      const adminImpersonating = await actors.signIn(superAdmin.email);
      await actors.patchStoredSession(adminImpersonating, {
        impersonatedBy: superAdmin.id,
      });
      const clientImpersonated = await actors.signIn(client.email);
      await actors.patchStoredSession(clientImpersonated, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: client.workspaceId,
      });
      for (const [method, url, body] of routes()) {
        expect((await call(method, url, body)).status, url).toBe(401);
        for (const cookie of [
          client.cookie,
          adminImpersonating,
          clientImpersonated,
        ]) {
          const res = await call(method, url, body, cookie);
          expect(res.status, `${method} ${url}`).toBe(403);
          expect(res.body).toMatchObject({ message: 'Super admin only' });
        }
      }
      expect(
        await actors.db
          .select()
          .from(promotions)
          .where(eq(promotions.createdBy, superAdmin.id)),
      ).toEqual([]);
      expect(await actors.db.select().from(platformSettings)).toEqual([]);
    });
  });

  describe('create', () => {
    it('a TRIAL: 201 with targets, status LIVE, no end, unlocked', async () => {
      const p = await create({
        kind: 'TRIAL',
        name: '  Growth 14-day trial ',
        planIds: [planIds.growth, planIds.starter],
        trialDays: 14,
        trialCommentLimit: 500,
      });
      expect(p).toEqual({
        id: expect.any(String) as string,
        kind: 'TRIAL',
        name: 'Growth 14-day trial',
        code: null,
        allPlans: false,
        plans: [
          { id: planIds.starter, slug: 'starter', name: 'Starter' },
          { id: planIds.growth, slug: 'growth', name: 'Growth' },
        ],
        endsAt: null,
        endsOn: null,
        maxRedemptions: null,
        redemptionCount: 0,
        status: 'LIVE',
        termsLocked: false,
        stoppedAt: null,
        trialDays: 14,
        trialCommentLimit: 500,
        discountType: null,
        discountValue: null,
        discountScope: null,
        durationMonths: null,
        createdByAdmin: true,
        createdAt: expect.any(String) as string,
        updatedAt: expect.any(String) as string,
      });
      const [row] = await actors.db
        .select()
        .from(promotions)
        .where(eq(promotions.id, p.id));
      expect(row).toMatchObject({ createdBy: superAdmin.id, kind: 'TRIAL' });
    });

    it('a DISCOUNT for all plans with an end date (end of that Dhaka day) and a cap', async () => {
      const today = dhakaDate(new Date());
      const p = await create(
        discountBody({
          planIds: undefined,
          allPlans: true,
          discountType: 'PERCENT',
          discountValue: 50,
          discountScope: 'TOTAL',
          durationMonths: null,
          endsOn: today,
          maxRedemptions: 10,
        }),
      );
      expect(p).toMatchObject({
        allPlans: true,
        plans: [],
        endsOn: today,
        maxRedemptions: 10,
        discountType: 'PERCENT',
        discountValue: 50,
        status: 'LIVE',
      });
      // 23:59:59.999 Dhaka = 17:59:59.999 UTC.
      expect(p.endsAt).toBe(
        new Date(Date.parse(`${today}T18:00:00.000Z`) - 1).toISOString(),
      );
      expect(
        await actors.db
          .select()
          .from(promotionPlans)
          .where(eq(promotionPlans.promotionId, p.id)),
      ).toEqual([]);
    });

    it('a COUPON: code trimmed + uppercased; the same code in any case → 409 PROMOTION_CODE_TAKEN', async () => {
      const p = await create(
        discountBody({ kind: 'COUPON', code: ` eid-${tag} ` }),
      );
      expect(p.code).toBe(`EID-${tag}`);
      const res = await admin()
        .post(API, discountBody({ kind: 'COUPON', code: `Eid-${tag}` }))
        .expect(409);
      expect(res.body).toMatchObject({ code: 'PROMOTION_CODE_TAKEN' });
      // Through PATCH too.
      const other = await create(
        discountBody({ kind: 'COUPON', code: `OTHER-${tag}` }),
      );
      const patched = await admin()
        .patch(`${API}/${other.id}`, { code: `eid-${tag}` })
        .expect(409);
      expect(patched.body).toMatchObject({ code: 'PROMOTION_CODE_TAKEN' });
    });

    it.each([
      [
        'TRIAL with a discount field',
        { kind: 'TRIAL', trialDays: 7, discountValue: 5 },
      ],
      ['TRIAL without days', { kind: 'TRIAL' }],
      ['DISCOUNT with trial days', { ...DISCOUNT_TERMS, trialDays: 7 }],
      ['DISCOUNT without a type', { ...DISCOUNT_TERMS, discountType: null }],
      ['COUPON without a code', { ...DISCOUNT_TERMS, kind: 'COUPON' }],
      ['code on a DISCOUNT', { ...DISCOUNT_TERMS, code: 'NOPE-1' }],
      [
        'PERCENT above 100',
        { ...DISCOUNT_TERMS, discountType: 'PERCENT', discountValue: 101 },
      ],
      ['no targets', { ...DISCOUNT_TERMS, planIds: [] }],
      ['allPlans + planIds', { ...DISCOUNT_TERMS, allPlans: true }],
    ])('400 PROMOTION_INVALID_TERMS: %s', async (_label, body) => {
      const res = await admin()
        .post(API, { name: 'Bad', planIds: [planIds.growth], ...body })
        .expect(400);
      expect(res.body).toMatchObject({ code: 'PROMOTION_INVALID_TERMS' });
    });

    it('400 for an inactive / unknown target, a past end date and DTO errors; nothing written', async () => {
      for (const target of [planIds.free, UNKNOWN_ID]) {
        const res = await admin()
          .post(API, discountBody({ planIds: [target] }))
          .expect(400);
        expect(res.body).toMatchObject({ code: 'PLAN_NOT_AVAILABLE' });
      }
      const yesterday = dhakaDate(new Date(Date.now() - DAY));
      const past = await admin()
        .post(API, discountBody({ endsOn: yesterday }))
        .expect(400);
      expect(past.body).toMatchObject({ code: 'PROMOTION_ENDS_IN_PAST' });
      for (const body of [
        discountBody({ kind: 'GIFT' }),
        discountBody({ name: '' }),
        discountBody({ code: 'a b' }),
        discountBody({ discountValue: 0 }),
        discountBody({ stoppedAt: new Date().toISOString() }),
      ])
        await admin().post(API, body).expect(400);
      const names = (
        await actors.db
          .select({ name: promotions.name })
          .from(promotions)
          .where(eq(promotions.name, 'Bad'))
      ).length;
      expect(names).toBe(0);
    });
  });

  describe('patch (reading 8)', () => {
    it('money terms are editable until the first redemption, then 409 PROMOTION_TERMS_LOCKED; name, end, cap, targets stay editable', async () => {
      const p = await create(discountBody());
      const edited = (
        (
          await admin()
            .patch(`${API}/${p.id}`, {
              discountValue: 300,
              durationMonths: null,
            })
            .expect(200)
        ).body as AdminPromotionResponse
      ).promotion;
      expect(edited).toMatchObject({
        discountValue: 300,
        durationMonths: null,
        termsLocked: false,
      });

      const redemption = await redeem(p.id, client);
      const locked = await admin()
        .patch(`${API}/${p.id}`, {
          discountValue: 100,
          discountScope: 'TOTAL',
          discountType: 'FLAT',
        })
        .expect(409);
      expect(locked.body).toMatchObject({
        code: 'PROMOTION_TERMS_LOCKED',
        details: { fields: ['discountValue', 'discountScope'] },
      });
      // Re-sending the stored money terms is fine.
      await admin()
        .patch(`${API}/${p.id}`, { discountValue: 300, discountType: 'FLAT' })
        .expect(200);

      const endsOn = dhakaDate(new Date(Date.now() + 30 * DAY));
      const after = (
        (
          await admin()
            .patch(`${API}/${p.id}`, {
              name: 'Renamed',
              endsOn,
              maxRedemptions: 5,
              planIds: [planIds.pro, planIds.growth],
            })
            .expect(200)
        ).body as AdminPromotionResponse
      ).promotion;
      expect(after).toMatchObject({
        name: 'Renamed',
        endsOn,
        maxRedemptions: 5,
        plans: [{ slug: 'growth' }, { slug: 'pro' }],
        redemptionCount: 1,
        termsLocked: true,
        discountValue: 300,
      });
      // allPlans on drops the stored targets; back off needs planIds.
      const all = (
        (await admin().patch(`${API}/${p.id}`, { allPlans: true }).expect(200))
          .body as AdminPromotionResponse
      ).promotion;
      expect(all).toMatchObject({ allPlans: true, plans: [] });
      const noTargets = await admin()
        .patch(`${API}/${p.id}`, { allPlans: false })
        .expect(400);
      expect(noTargets.body).toMatchObject({ code: 'PROMOTION_INVALID_TERMS' });
      await admin()
        .patch(`${API}/${p.id}`, { endsOn: null, maxRedemptions: null })
        .expect(200);
      // The claim kept its snapshot.
      expect(redemption.discountValue).toBe(300);
    });

    it('a TRIAL locks days + comment limit after its first claim', async () => {
      const p = await create({
        kind: 'TRIAL',
        name: `PR-T4 trial ${tag}`,
        planIds: [planIds.pro],
        trialDays: 3,
      });
      await redeem(p.id, client2, 'pro');
      const res = await admin()
        .patch(`${API}/${p.id}`, { trialDays: 30, trialCommentLimit: 5 })
        .expect(409);
      expect(res.body).toMatchObject({
        details: { fields: ['trialDays', 'trialCommentLimit'] },
      });
    });

    it('400 for an empty body, kind, per-kind breaks and a past end date; 404 unknown id', async () => {
      const p = await create(discountBody());
      await admin().patch(`${API}/${p.id}`, {}).expect(400);
      await admin().patch(`${API}/${p.id}`, { kind: 'TRIAL' }).expect(400);
      const terms = await admin()
        .patch(`${API}/${p.id}`, { trialDays: 7 })
        .expect(400);
      expect(terms.body).toMatchObject({ code: 'PROMOTION_INVALID_TERMS' });
      await admin()
        .patch(`${API}/${p.id}`, {
          discountType: 'PERCENT',
          discountValue: 500,
        })
        .expect(400);
      await admin()
        .patch(`${API}/${p.id}`, {
          endsOn: dhakaDate(new Date(Date.now() - DAY)),
        })
        .expect(400);
      await admin().patch(`${API}/${UNKNOWN_ID}`, { name: 'x' }).expect(404);
      await admin().patch(`${API}/not-a-uuid`, { name: 'x' }).expect(404);
    });
  });

  describe('stop, statuses, list filters, redemptions', () => {
    it('stop is idempotent (first stoppedAt kept) and records who; 404 unknown', async () => {
      const p = await create(discountBody());
      const first = (
        (await admin().post(`${API}/${p.id}/stop`).expect(200))
          .body as AdminPromotionResponse
      ).promotion;
      expect(first).toMatchObject({ status: 'STOPPED' });
      expect(first.stoppedAt).not.toBeNull();
      const again = (
        (await admin().post(`${API}/${p.id}/stop`).expect(200))
          .body as AdminPromotionResponse
      ).promotion;
      expect(again.stoppedAt).toBe(first.stoppedAt);
      const [row] = await actors.db
        .select({ stoppedBy: promotions.stoppedBy })
        .from(promotions)
        .where(eq(promotions.id, p.id));
      expect(row!.stoppedBy).toBe(superAdmin.id);
      // A stopped promotion is still editable (name).
      await admin().patch(`${API}/${p.id}`, { name: 'Old sale' }).expect(200);
      await admin().post(`${API}/${UNKNOWN_ID}/stop`).expect(404);
    });

    it('every status (Stopped > Ended > Used up > Live) and the kind / status filters', async () => {
      const live = await create(discountBody({ name: `live ${tag}` }));
      const ended = await create(discountBody({ name: `ended ${tag}` }));
      await actors.db
        .update(promotions)
        .set({ endsAt: new Date(Date.now() - 1000) })
        .where(eq(promotions.id, ended.id));
      const usedUp = await create(
        discountBody({ name: `used ${tag}`, maxRedemptions: 1 }),
      );
      await redeem(usedUp.id, client2);
      const stopped = await create(
        discountBody({ name: `stopped ${tag}`, maxRedemptions: 1 }),
      );
      await redeem(stopped.id, client);
      await actors.db
        .update(promotions)
        .set({ endsAt: new Date(Date.now() - 1000) })
        .where(eq(promotions.id, stopped.id));
      await admin().post(`${API}/${stopped.id}/stop`).expect(200);

      const list = async (query = '') =>
        (
          (await admin().get(`${API}${query}`).expect(200))
            .body as AdminPromotionsResponse
        ).items;
      const all = await list();
      const status = (id: string) => all.find((p) => p.id === id)?.status;
      expect([
        status(live.id),
        status(ended.id),
        status(usedUp.id),
        status(stopped.id),
      ]).toEqual(['LIVE', 'ENDED', 'USED_UP', 'STOPPED']);
      // Newest first; the 0027 seeds are listed too (created by a migration).
      const times = all.map((p) => Date.parse(p.createdAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      const seeds = all.filter((p) => !p.createdByAdmin);
      expect(seeds.map((p) => p.kind).sort()).toEqual([
        'DISCOUNT',
        'DISCOUNT',
        'DISCOUNT',
        'TRIAL',
      ]);
      expect(all.find((p) => p.id === usedUp.id)).toMatchObject({
        redemptionCount: 1,
        termsLocked: true,
      });

      for (const s of ['LIVE', 'ENDED', 'USED_UP', 'STOPPED'] as const) {
        const items = await list(`?status=${s}`);
        expect(items.every((p) => p.status === s)).toBe(true);
      }
      expect((await list('?status=ENDED')).map((p) => p.id)).toContain(
        ended.id,
      );
      const trials = await list('?kind=TRIAL&status=LIVE');
      expect(trials.length).toBeGreaterThan(0);
      expect(trials.every((p) => p.kind === 'TRIAL')).toBe(true);
      for (const q of ['?status=Live', '?kind=gift', '?take=5'])
        await admin().get(`${API}${q}`).expect(400);
    });

    it('redemptions: client, first workspace, plan of the subscription, saving and months; 404 unknown', async () => {
      const p = await create(discountBody());
      await redeem(p.id, client);
      const res = await admin().get(`${API}/${p.id}/redemptions`).expect(200);
      const [ws] = await actors.db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, client.workspaceId));
      expect(res.body as AdminPromotionRedemptionsResponse).toEqual({
        items: [
          {
            id: expect.any(String) as string,
            redeemedAt: expect.any(String) as string,
            billingAccountId: await actors.accountIdOf(client),
            client: {
              id: client.id,
              name: expect.any(String) as string,
              email: client.email,
            },
            workspace: { id: client.workspaceId, name: ws!.name },
            plan: null,
            discountBdtFirstTerm: 200,
            monthsUsed: 1,
          },
        ],
      });
      const empty = await create(discountBody());
      expect(
        (await admin().get(`${API}/${empty.id}/redemptions`).expect(200)).body,
      ).toEqual({ items: [] });
      await admin().get(`${API}/${UNKNOWN_ID}/redemptions`).expect(404);
    });

    it('the seeded promotions stay untouched by this spec', async () => {
      const seeds = await actors.db
        .select({ stoppedAt: promotions.stoppedAt, endsAt: promotions.endsAt })
        .from(promotions)
        .where(isNull(promotions.createdBy))
        .orderBy(asc(promotions.name));
      expect(seeds).toHaveLength(4);
      expect(seeds.every((s) => !s.stoppedAt && !s.endsAt)).toBe(true);
    });
  });

  describe('support WhatsApp number (PR-D18)', () => {
    it('GET is all null before the first save; PATCH stores, validates and clears', async () => {
      expect((await admin().get(PLATFORM).expect(200)).body).toEqual({
        supportWhatsappNumber: null,
        playgroundDailyLimit: 10,
        updatedAt: null,
      });
      const saved = (
        await admin()
          .patch(PLATFORM, { supportWhatsappNumber: ' 8801712345678 ' })
          .expect(200)
      ).body as PlatformSettings;
      expect(saved).toEqual({
        supportWhatsappNumber: '8801712345678',
        playgroundDailyLimit: 10,
        updatedAt: expect.any(String) as string,
      });
      expect((await admin().get(PLATFORM).expect(200)).body).toEqual(saved);
      const [row] = await actors.db.select().from(platformSettings);
      expect(row).toMatchObject({ id: 1, updatedById: superAdmin.id });
      // The public plans read it.
      const pub = await http().get('/api/plans').expect(200);
      expect(pub.body).toMatchObject({ contactWhatsapp: '8801712345678' });

      for (const body of [
        {},
        { supportWhatsappNumber: '01712345678' },
        { supportWhatsappNumber: '+8801712345678' },
        { supportWhatsappNumber: '8801212345678' },
        { supportWhatsappNumber: 8801712345678 },
        { supportWhatsappNumber: null, extra: 1 },
      ])
        await admin().patch(PLATFORM, body).expect(400);
      expect(
        ((await admin().get(PLATFORM).expect(200)).body as PlatformSettings)
          .supportWhatsappNumber,
      ).toBe('8801712345678');

      await admin()
        .patch(PLATFORM, { supportWhatsappNumber: null })
        .expect(200);
      expect(
        await actors.db
          .select({ n: platformSettings.supportWhatsappNumber })
          .from(platformSettings)
          .where(and(eq(platformSettings.id, 1))),
      ).toEqual([{ n: null }]);
      expect((await http().get('/api/plans').expect(200)).body).toMatchObject({
        contactWhatsapp: null,
      });
    });
  });
});

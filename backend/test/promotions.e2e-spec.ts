import type { HttpException, INestApplication } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  PLAN_FEATURE_KEYS,
  type PlanFeatureKey,
  platformSettings,
  plans,
  promotionPlans,
  promotionRedemptions,
  promotions,
} from '../src/db/schema/index.js';
import { PromotionService } from '../src/promotions/promotion.service.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

type PromotionInsert = typeof promotions.$inferInsert;

const HOUR = 3_600_000;
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

const PUBLIC_PLAN_KEYS = [
  'badge',
  'description',
  'features',
  'highlighted',
  'id',
  'limits',
  'monthly',
  'name',
  'slug',
  'trial',
  'yearly',
];

/** Seed card prices (0027, reading 4): monthly list / yearly list / Launch offer / shown. */
const SEED = {
  starter: { list: 999, yearly: 949, off: 500, month: 499, year: 449 },
  growth: { list: 2499, yearly: 2349, off: 1000, month: 1499, year: 1349 },
  pro: { list: 5999, yearly: 5599, off: 2000, month: 3999, year: 3599 },
} as const;

/** The `code` of a Nest HTTP exception (body `{ message, code }`), or the status for others. */
async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    const response = (error as HttpException).getResponse?.();
    return typeof response === 'object' && response && 'code' in response
      ? response.code
      : (error as HttpException).getStatus?.();
  }
  return 'resolved';
}

/**
 * PR-T2: `PromotionService` (live rules, `redeem()` with the cap lock, `validateCoupon`) and the
 * public `GET /api/plans` shape (plan doc §5.2, §5.5, §5.7; user decisions 2026-11-20 PR-D2…D7,
 * D11, D15, D16, D18; readings 1…3, 10). Real Postgres. Every promotion a test creates is deleted
 * after it (redemptions + targets first); seeds stopped by a test are restored.
 */
describe('Promotions service + public plans (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let service: PromotionService;
  let admin: Actor;
  const accounts: string[] = [];
  const planIds: Record<string, string> = {};
  let testPlanId: string;
  let otherTestPlanId: string;
  const created: string[] = [];
  const tag = `${Date.now()}`.slice(-8);

  const db = () => actors.db;
  const http = () => actors.http();

  async function insertPromotion(
    row: Partial<PromotionInsert> & Pick<PromotionInsert, 'kind'>,
    targetPlanIds: string[] = [],
  ): Promise<string> {
    const [inserted] = await db()
      .insert(promotions)
      .values({ name: `PR-T2 ${row.kind}`, createdBy: admin.id, ...row })
      .returning({ id: promotions.id });
    created.push(inserted!.id);
    if (targetPlanIds.length)
      await db()
        .insert(promotionPlans)
        .values(
          targetPlanIds.map((planId) => ({
            promotionId: inserted!.id,
            planId,
          })),
        );
    return inserted!.id;
  }
  const discount = (
    patch: Partial<PromotionInsert> = {},
    targets = [testPlanId],
  ) =>
    insertPromotion(
      {
        kind: 'DISCOUNT',
        discountType: 'FLAT',
        discountValue: 100,
        discountScope: 'PER_MONTH',
        ...patch,
      },
      targets,
    );
  const trial = (
    patch: Partial<PromotionInsert> = {},
    targets = [testPlanId],
  ) => insertPromotion({ kind: 'TRIAL', trialDays: 5, ...patch }, targets);
  const coupon = (
    code: string,
    patch: Partial<PromotionInsert> = {},
    targets = [planIds.growth!],
  ) =>
    insertPromotion(
      {
        kind: 'COUPON',
        code: `${code}-${tag}`,
        discountType: 'PERCENT',
        discountValue: 10,
        discountScope: 'TOTAL',
        ...patch,
      },
      targets,
    );

  const redeemIn = (
    promotionId: string,
    accountId: string,
    planId = testPlanId,
    discountBdtFirstTerm?: number,
  ) =>
    db().transaction((tx) =>
      service.redeem(tx, {
        promotionId,
        accountId,
        planId,
        discountBdtFirstTerm,
      }),
    );

  const seedPromotionId = async (
    planSlug: string,
    kind: 'DISCOUNT' | 'TRIAL',
  ) => {
    const [row] = await db()
      .select({ id: promotions.id })
      .from(promotions)
      .innerJoin(promotionPlans, eq(promotionPlans.promotionId, promotions.id))
      .where(
        and(
          eq(promotionPlans.planId, planIds[planSlug]!),
          eq(promotions.kind, kind),
          isNull(promotions.createdBy),
        ),
      );
    return row!.id;
  };

  const publicPlans = async () => {
    const res = await http().get('/api/plans').expect(200);
    return res.body as {
      items: Record<string, unknown>[];
      yearlySaveUpToPercent: number;
      contactWhatsapp: string | null;
    };
  };

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    service = app.get(PromotionService);
    admin = await actors.signUpSuperAdmin('prt2-admin');
    for (let i = 0; i < 6; i += 1) {
      const actor = await actors.signUp(`prt2-c${i}`);
      accounts.push(await actors.accountIdOf(actor));
    }
    for (const row of await db()
      .select({ id: plans.id, slug: plans.slug })
      .from(plans))
      planIds[row.slug] = row.id;
    const config = {
      limits: {
        connectedPages: 1,
        monthlyComments: 100,
        teamSeats: 1,
        workspaces: 1,
      },
      features: Object.fromEntries(
        PLAN_FEATURE_KEYS.map((key) => [key, false]),
      ) as Record<PlanFeatureKey, boolean>,
    };
    const inserted = await db()
      .insert(plans)
      .values(
        [`prt2-${tag}`, `prt2-other-${tag}`].map((slug) => ({
          slug,
          name: slug.toUpperCase(),
          sortOrder: 96,
          isActive: false,
          monthlyPriceBdt: 1000,
          yearlyMonthlyPriceBdt: 900,
          featureConfig: config,
        })),
      )
      .returning({ id: plans.id });
    testPlanId = inserted[0]!.id;
    otherTestPlanId = inserted[1]!.id;
  });

  afterEach(async () => {
    if (!created.length) return;
    const ids = created.splice(0);
    await db()
      .delete(promotionRedemptions)
      .where(inArray(promotionRedemptions.promotionId, ids));
    await db()
      .delete(promotionPlans)
      .where(inArray(promotionPlans.promotionId, ids));
    await db().delete(promotions).where(inArray(promotions.id, ids));
  });

  afterAll(async () => {
    if (actors) {
      await db().delete(platformSettings);
      await actors.cleanup();
      await db()
        .delete(plans)
        .where(
          inArray(plans.id, [testPlanId, otherTestPlanId].filter(Boolean)),
        );
    }
    await app?.close();
  });

  describe('liveDiscountsFor / liveTrialsFor', () => {
    it('targets, all_plans, end date, Stop and cap decide what is live; coupons and trials never', async () => {
      const now = new Date();
      const targeted = await discount();
      const all = await discount({ allPlans: true }, []);
      const future = await discount({ endsAt: new Date(now.getTime() + HOUR) });
      const ended = await discount({ endsAt: new Date(now.getTime() - HOUR) });
      const stopped = await discount({ stoppedAt: now, stoppedBy: admin.id });
      const capped = await discount({ maxRedemptions: 1 });
      const capLeft = await discount({ maxRedemptions: 2 });
      const otherPlan = await discount({}, [otherTestPlanId]);
      await coupon('LIVE', {}, [testPlanId]);
      await trial();
      await redeemIn(capped, accounts[0]!);
      await redeemIn(capLeft, accounts[0]!);

      const live = await service.liveDiscountsFor(
        [testPlanId, otherTestPlanId, planIds.starter!],
        now,
      );
      const ids = (planId: string) =>
        live
          .get(planId)!
          .map((d) => d.promotionId)
          .sort();
      expect(ids(testPlanId)).toEqual([targeted, all, future, capLeft].sort());
      expect(ids(otherTestPlanId)).toEqual([all, otherPlan].sort());
      expect(ids(planIds.starter!)).toEqual(
        [all, await seedPromotionId('starter', 'DISCOUNT')].sort(),
      );
      expect(ended && stopped).toBeTruthy();
      expect(
        live.get(testPlanId)!.find((d) => d.promotionId === future),
      ).toEqual({
        promotionId: future,
        discountType: 'FLAT',
        discountValue: 100,
        discountScope: 'PER_MONTH',
        durationMonths: null,
        endsAt: new Date(now.getTime() + HOUR),
      });
      expect(await service.liveDiscountsFor([], now)).toEqual(new Map());
    });

    it('seeded Starter trial; a plan without one → null; longest trial wins', async () => {
      const short = await trial({ trialDays: 3 });
      const long = await trial({ trialDays: 14, trialCommentLimit: 50 });
      await trial({
        trialDays: 30,
        stoppedAt: new Date(),
        stoppedBy: admin.id,
      });
      const trials = await service.liveTrialsFor([
        planIds.starter!,
        planIds.growth!,
        testPlanId,
      ]);
      expect(trials.get(planIds.starter!)).toEqual({
        promotionId: await seedPromotionId('starter', 'TRIAL'),
        days: 7,
        commentLimit: 300,
        endsAt: null,
      });
      expect(trials.get(planIds.growth!)).toBeNull();
      expect(trials.get(testPlanId)).toMatchObject({
        promotionId: long,
        days: 14,
        commentLimit: 50,
      });
      expect(short).toBeTruthy();
      expect(await service.liveTrialFor(otherTestPlanId)).toBeNull();
    });
  });

  describe('redeem()', () => {
    it('inserts the claim with the term snapshot; once per account (PR-D3)', async () => {
      const id = await discount({
        discountType: 'PERCENT',
        discountValue: 20,
        durationMonths: 3,
      });
      const row = await redeemIn(id, accounts[0]!, testPlanId, 200);
      expect(row).toMatchObject({
        promotionId: id,
        billingAccountId: accounts[0],
        subscriptionId: null,
        kind: 'DISCOUNT',
        discountType: 'PERCENT',
        discountValue: 20,
        discountScope: 'PER_MONTH',
        durationMonths: 3,
        trialDays: null,
        monthsUsed: 0,
        discountBdtFirstTerm: 200,
      });
      expect(await codeOf(redeemIn(id, accounts[0]!))).toBe(
        'PROMOTION_ALREADY_CLAIMED',
      );
      // Another account may still claim it.
      await redeemIn(id, accounts[1]!);
      const rows = await db()
        .select()
        .from(promotionRedemptions)
        .where(eq(promotionRedemptions.promotionId, id));
      expect(rows).toHaveLength(2);
    });

    it('stopped / ended → PROMOTION_NOT_LIVE; not targeted → PROMOTION_NOT_FOR_PLAN; cap → PROMOTION_USED_UP; unknown → 404', async () => {
      const stopped = await discount({
        stoppedAt: new Date(),
        stoppedBy: admin.id,
      });
      const ended = await discount({ endsAt: new Date(Date.now() - HOUR) });
      const other = await discount({}, [otherTestPlanId]);
      const capped = await discount({ maxRedemptions: 1 });
      await redeemIn(capped, accounts[0]!);
      expect(await codeOf(redeemIn(stopped, accounts[0]!))).toBe(
        'PROMOTION_NOT_LIVE',
      );
      expect(await codeOf(redeemIn(ended, accounts[0]!))).toBe(
        'PROMOTION_NOT_LIVE',
      );
      expect(await codeOf(redeemIn(other, accounts[0]!))).toBe(
        'PROMOTION_NOT_FOR_PLAN',
      );
      expect(await codeOf(redeemIn(capped, accounts[1]!))).toBe(
        'PROMOTION_USED_UP',
      );
      expect(await codeOf(redeemIn(UNKNOWN_ID, accounts[0]!))).toBe(404);
      // all_plans targets any plan.
      const all = await discount({ allPlans: true }, []);
      await redeemIn(all, accounts[0]!, otherTestPlanId);
    });

    it('one trial per account ever, across trial promotions (reading 1)', async () => {
      const first = await trial();
      const second = await trial({ trialDays: 14 });
      const snap = await redeemIn(first, accounts[2]!);
      expect(snap).toMatchObject({
        kind: 'TRIAL',
        trialDays: 5,
        trialCommentLimit: null,
        discountType: null,
        discountBdtFirstTerm: 0,
      });
      expect(await codeOf(redeemIn(second, accounts[2]!))).toBe(
        'TRIAL_ALREADY_USED',
      );
      // A discount is still fine for that account.
      await redeemIn(await discount(), accounts[2]!);
    });

    it('cap race: parallel claims never exceed "first N" (FOR UPDATE + count under the lock)', async () => {
      const id = await discount({ maxRedemptions: 2 });
      const results = await Promise.allSettled(
        accounts.map((account) => redeemIn(id, account)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      for (const r of results.filter((r) => r.status === 'rejected'))
        expect(
          ((r as PromiseRejectedResult).reason as HttpException).getResponse(),
        ).toMatchObject({ code: 'PROMOTION_USED_UP' });
      const rows = await db()
        .select({ id: promotionRedemptions.id })
        .from(promotionRedemptions)
        .where(eq(promotionRedemptions.promotionId, id));
      expect(rows).toHaveLength(2);
    });

    it('same account racing itself: one claim, the other PROMOTION_ALREADY_CLAIMED', async () => {
      const id = await discount();
      const results = await Promise.allSettled([
        redeemIn(id, accounts[3]!),
        redeemIn(id, accounts[3]!),
        redeemIn(id, accounts[3]!),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((r) => r.status === 'rejected'))
        expect(
          ((r as PromiseRejectedResult).reason as HttpException).getResponse(),
        ).toMatchObject({ code: 'PROMOTION_ALREADY_CLAIMED' });
    });
  });

  describe('validateCoupon()', () => {
    it('valid code, any case: preview = best live discount, then the coupon on top', async () => {
      const id = await coupon('SAVE10');
      const check = await service.validateCoupon(
        `  save10-${tag} `.toLowerCase(),
        accounts[0]!,
        planIds.growth!,
        'month',
      );
      // Growth ৳2,499 − Launch ৳1,000 = ৳1,499 → 10% off the bill → ৳1,349 (rounded down).
      expect(check).toEqual({
        ok: true,
        promotionId: id,
        code: `SAVE10-${tag}`,
        price: {
          listPerMonthBdt: 2499,
          listChargedBdt: 2499,
          perMonthBdt: 1349,
          chargedBdt: 1349,
          saving: {
            promotionId: await seedPromotionId('growth', 'DISCOUNT'),
            label: '৳1,000 off',
            labelBn: '৳১,০০০ ছাড়',
            amountBdt: 1000,
          },
          coupon: {
            promotionId: id,
            label: '10% off',
            labelBn: '১০% ছাড়',
            amountBdt: 150,
          },
        },
      });
      const yearly = await service.validateCoupon(
        `SAVE10-${tag}`,
        accounts[0]!,
        planIds.growth!,
        'year',
      );
      // ৳1,349 × 12 = ৳16,188 → 10% → ৳14,569.
      expect(yearly).toMatchObject({
        ok: true,
        price: { chargedBdt: 14_569, perMonthBdt: 1214 },
      });
    });

    it('each error code', async () => {
      const check = (code: string, planId = planIds.growth!, account = 0) =>
        service
          .validateCoupon(code, accounts[account]!, planId, 'month')
          .then((r) => (r.ok ? 'ok' : r.error));
      await coupon('ENDED', { endsAt: new Date(Date.now() - HOUR) });
      await coupon('STOP', { stoppedAt: new Date(), stoppedBy: admin.id });
      const once = await coupon('ONCE', { maxRedemptions: 1 });
      await redeemIn(once, accounts[0]!, planIds.growth!);
      await coupon('ALL', {}, []).then((id) =>
        db()
          .update(promotions)
          .set({ allPlans: true })
          .where(eq(promotions.id, id)),
      );
      expect(await check(`NOPE-${tag}`)).toBe('COUPON_NOT_FOUND');
      expect(await check('bad code!')).toBe('COUPON_NOT_FOUND');
      expect(await check(`ENDED-${tag}`)).toBe('COUPON_EXPIRED');
      expect(await check(`STOP-${tag}`)).toBe('COUPON_EXPIRED');
      expect(await check(`ONCE-${tag}`, planIds.starter!)).toBe(
        'COUPON_NOT_FOR_PLAN',
      );
      expect(await check(`ONCE-${tag}`)).toBe('COUPON_ALREADY_USED');
      expect(await check(`ONCE-${tag}`, planIds.growth!, 1)).toBe(
        'COUPON_USED_UP',
      );
      // all_plans; an inactive plan has no price → not for this plan.
      expect(await check(`ALL-${tag}`, planIds.pro!)).toBe('ok');
      expect(await check(`ALL-${tag}`, testPlanId)).toBe('COUPON_NOT_FOR_PLAN');
      // A discount's name is not a code.
      expect(await check('LAUNCH-OFFER')).toBe('COUPON_NOT_FOUND');
    });
  });

  describe('GET /api/plans (public)', () => {
    it('new shape: seed prices unchanged, trial on Starter only, save up to 10%, no WhatsApp, coupons never listed', async () => {
      await coupon('SECRET', {}, []).then((id) =>
        db()
          .update(promotions)
          .set({ allPlans: true })
          .where(eq(promotions.id, id)),
      );
      const res = await http().get('/api/plans').expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      const body = res.body as Awaited<ReturnType<typeof publicPlans>>;
      expect(Object.keys(body).sort()).toEqual([
        'contactWhatsapp',
        'items',
        'yearlySaveUpToPercent',
      ]);
      expect(body.contactWhatsapp).toBeNull();
      expect(body.yearlySaveUpToPercent).toBe(10);
      const active = await db()
        .select()
        .from(plans)
        .where(eq(plans.isActive, true))
        .orderBy(asc(plans.sortOrder), asc(plans.name));
      expect(body.items.map((p) => p.slug)).toEqual([
        'starter',
        'growth',
        'pro',
      ]);
      expect(body.items.map((p) => p.id)).toEqual(active.map((p) => p.id));
      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual(PUBLIC_PLAN_KEYS);
        const seed = SEED[item.slug as keyof typeof SEED];
        const launch = await seedPromotionId(item.slug as string, 'DISCOUNT');
        expect(item.monthly).toEqual({
          listPerMonthBdt: seed.list,
          listChargedBdt: seed.list,
          perMonthBdt: seed.month,
          chargedBdt: seed.month,
          saving: {
            promotionId: launch,
            label: `৳${seed.off.toLocaleString('en-US')} off`,
            labelBn: `৳${seed.off.toLocaleString('bn-BD')} ছাড়`,
            amountBdt: seed.off,
          },
        });
        expect(item.yearly).toMatchObject({
          listPerMonthBdt: seed.yearly,
          listChargedBdt: seed.yearly * 12,
          perMonthBdt: seed.year,
          chargedBdt: seed.year * 12,
          saving: { promotionId: launch, amountBdt: seed.off * 12 },
        });
        expect(item).toMatchObject({
          badge: null,
          description: null,
          highlighted: false,
        });
        expect(item.trial).toEqual(
          item.slug === 'starter'
            ? {
                promotionId: await seedPromotionId('starter', 'TRIAL'),
                days: 7,
                commentLimit: 300,
                endsAt: null,
              }
            : null,
        );
      }
      const raw = JSON.stringify(body);
      for (const hidden of [
        `SECRET-${tag}`,
        'COUPON',
        'offerPriceBdt',
        'offerBadge',
        'trialDays',
        'trialCommentLimit',
        'isActive',
        'sortOrder',
        'featureConfig',
        'free',
      ])
        expect(raw).not.toContain(hidden);
    });

    it('contactWhatsapp = the platform_settings number once set', async () => {
      await db()
        .insert(platformSettings)
        .values({ id: 1, supportWhatsappNumber: '8801712345678' });
      try {
        expect((await publicPlans()).contactWhatsapp).toBe('8801712345678');
        await db()
          .update(platformSettings)
          .set({ supportWhatsappNumber: null });
        expect((await publicPlans()).contactWhatsapp).toBeNull();
      } finally {
        await db().delete(platformSettings);
      }
    });

    it('a stopped or ended Launch offer → list price; a bigger live discount wins instead', async () => {
      const launch = await seedPromotionId('starter', 'DISCOUNT');
      const starter = async () =>
        (await publicPlans()).items.find((p) => p.slug === 'starter')!;
      try {
        await db()
          .update(promotions)
          .set({ stoppedAt: new Date(), stoppedBy: admin.id })
          .where(eq(promotions.id, launch));
        expect(await starter()).toMatchObject({
          monthly: { perMonthBdt: 999, chargedBdt: 999, saving: null },
          yearly: { perMonthBdt: 949, chargedBdt: 11_388, saving: null },
        });
        await db()
          .update(promotions)
          .set({
            stoppedAt: null,
            stoppedBy: null,
            endsAt: new Date(Date.now() - HOUR),
          })
          .where(eq(promotions.id, launch));
        expect((await starter()).monthly).toMatchObject({ saving: null });
      } finally {
        await db()
          .update(promotions)
          .set({ stoppedAt: null, stoppedBy: null, endsAt: null })
          .where(eq(promotions.id, launch));
      }
      // A live 60% off for 3 months beats the ৳500 Launch offer on the first bill.
      const big = await discount(
        { discountType: 'PERCENT', discountValue: 60, durationMonths: 3 },
        [planIds.starter!],
      );
      expect((await starter()).monthly).toMatchObject({
        perMonthBdt: 399,
        saving: {
          promotionId: big,
          label: '60% off for 3 months',
          amountBdt: 600,
        },
      });
    });
  });
});

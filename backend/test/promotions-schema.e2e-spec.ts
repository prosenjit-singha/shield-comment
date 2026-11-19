import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  billingAccounts,
  platformSettings,
  plans,
  promotionPlans,
  promotionRedemptions,
  promotions,
  subscriptions,
} from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

/** Postgres SQLSTATE of a failed query (Drizzle wraps the `pg` error in `cause`). */
async function pgCode(
  query: PromiseLike<unknown>,
): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    const pgError = (error as { cause?: { code?: string } }).cause ?? error;
    return (pgError as { code?: string }).code;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

const MIGRATION = new URL('../drizzle/0027_promotions.sql', import.meta.url);
const DATA_STEP_MARKER = '-- PR-T1 data step';

/** Card prices before 0027 (planner's reading 4): list, offer, yearly per month. */
const PRICES_BEFORE = {
  starter: { list: 999, offer: 499, yearly: 449 },
  growth: { list: 2499, offer: 1499, yearly: 1349 },
  pro: { list: 5999, offer: 3999, yearly: 3599 },
} as const;

type PromotionInsert = typeof promotions.$inferInsert;
type RedemptionInsert = typeof promotionRedemptions.$inferInsert;

/**
 * PR-T1: promotions (+ targets, redemptions), the subscription redemption links, the plain plan
 * fields (rename to `monthly_price_bdt`, badge/description en + bn, one highlighted plan), the
 * support WhatsApp setting and the 0027 seed (user decisions 2026-11-20 PR-D1…D5, D8, D9, D12,
 * D17, D18; reading 4). Schema only: services and routes come in PR-T2+.
 */
describe('Promotions schema (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let a: Actor;
  let b: Actor;
  let accountA: string;
  let accountB: string;
  let planId: string;
  let otherPlanId: string;
  let subscriptionId: string;

  const tag = `${Date.now()}`;
  const db = () => actors.db;

  const discount = (patch: Partial<PromotionInsert> = {}): PromotionInsert => ({
    kind: 'DISCOUNT',
    name: 'Spec discount',
    discountType: 'FLAT',
    discountValue: 200,
    discountScope: 'PER_MONTH',
    durationMonths: 3,
    createdBy: a.id,
    ...patch,
  });
  const trial = (patch: Partial<PromotionInsert> = {}): PromotionInsert => ({
    kind: 'TRIAL',
    name: 'Spec trial',
    trialDays: 7,
    trialCommentLimit: 300,
    createdBy: a.id,
    ...patch,
  });
  const coupon = (patch: Partial<PromotionInsert> = {}): PromotionInsert => ({
    kind: 'COUPON',
    name: 'Spec coupon',
    code: `SPEC-${tag}`,
    discountType: 'PERCENT',
    discountValue: 50,
    discountScope: 'TOTAL',
    createdBy: a.id,
    ...patch,
  });
  const insertPromotion = async (row: PromotionInsert) =>
    (
      await db().insert(promotions).values(row).returning({ id: promotions.id })
    )[0]!.id;
  const redemption = (
    promotionId: string,
    patch: Partial<RedemptionInsert> = {},
  ): RedemptionInsert => ({
    promotionId,
    billingAccountId: accountA,
    kind: 'DISCOUNT',
    discountType: 'FLAT',
    discountValue: 200,
    discountScope: 'PER_MONTH',
    durationMonths: 3,
    discountBdtFirstTerm: 200,
    ...patch,
  });

  const testPlan = (slug: string): typeof plans.$inferInsert => ({
    slug,
    name: slug.toUpperCase(),
    sortOrder: 95,
    monthlyPriceBdt: 999,
    featureConfig: {
      limits: {
        connectedPages: 1,
        monthlyComments: 100,
        teamSeats: 1,
        workspaces: 1,
      },
      features: {
        banglaAiFilter: true,
        autoHideScams: true,
        customBlocklist: false,
        autoReplyTemplates: false,
        messengerAlerts: false,
        whiteLabelReports: false,
        prioritySupportApi: false,
      },
    },
  });

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    a = await actors.signUp('prt1-a');
    b = await actors.signUp('prt1-b');
    await actors.removeBilling(a, b);
    const inserted = await db()
      .insert(plans)
      .values([testPlan(`prt1-${tag}`), testPlan(`prt1-other-${tag}`)])
      .returning({ id: plans.id });
    planId = inserted[0]!.id;
    otherPlanId = inserted[1]!.id;
    const accounts = await db()
      .insert(billingAccounts)
      .values([{ ownerUserId: a.id }, { ownerUserId: b.id }])
      .returning({ id: billingAccounts.id });
    accountA = accounts[0]!.id;
    accountB = accounts[1]!.id;
    const start = new Date('2026-11-20T00:00:00.000Z');
    const [subscription] = await db()
      .insert(subscriptions)
      .values({
        billingAccountId: accountA,
        planId,
        interval: 'month',
        status: 'ACTIVE',
        startedAt: start,
        currentTermStart: start,
        currentTermEnd: new Date('2026-12-20T00:00:00.000Z'),
        pricePerMonthBdt: 799,
        chargedBdt: 799,
      })
      .returning({ id: subscriptions.id });
    subscriptionId = subscription!.id;
  });

  afterAll(async () => {
    if (actors) {
      await db().delete(platformSettings);
      await actors.cleanup();
      await db()
        .delete(plans)
        .where(inArray(plans.id, [planId, otherPlanId].filter(Boolean)));
    }
    await app?.close();
  });

  it('migration 0027 is applied (journal count = applied rows)', async () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../drizzle/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain('0027_promotions');
    const result = await db().execute<{ applied: number }>(
      sql`select count(*)::int as applied from drizzle.__drizzle_migrations`,
    );
    expect(result.rows[0]?.applied).toBe(journal.entries.length);
  });

  describe('0027 seed (reading 4: shown prices unchanged)', () => {
    const seeded = () =>
      db()
        .select({
          id: promotions.id,
          kind: promotions.kind,
          name: promotions.name,
          code: promotions.code,
          allPlans: promotions.allPlans,
          endsAt: promotions.endsAt,
          maxRedemptions: promotions.maxRedemptions,
          stoppedAt: promotions.stoppedAt,
          discountType: promotions.discountType,
          discountValue: promotions.discountValue,
          discountScope: promotions.discountScope,
          durationMonths: promotions.durationMonths,
          trialDays: promotions.trialDays,
          trialCommentLimit: promotions.trialCommentLimit,
          slug: plans.slug,
        })
        .from(promotions)
        .innerJoin(
          promotionPlans,
          eq(promotionPlans.promotionId, promotions.id),
        )
        .innerJoin(plans, eq(plans.id, promotionPlans.planId))
        .where(isNull(promotions.createdBy))
        .orderBy(asc(plans.sortOrder), asc(promotions.kind));
    const common = {
      code: null,
      allPlans: false,
      endsAt: null,
      maxRedemptions: null,
      stoppedAt: null,
    };

    it('the list price is renamed, not re-created (monthly_price_bdt kept the values)', async () => {
      const columns = await db().execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_name = 'plans' and column_name like '%price_bdt' order by column_name`,
      );
      expect(columns.rows.map((r) => r.column_name)).toEqual([
        'monthly_price_bdt',
        'offer_price_bdt',
        'yearly_monthly_price_bdt',
      ]);
    });

    it('one "Launch offer" per active plan with an offer + the "Starter 7-day trial"', async () => {
      const rows = await seeded();
      expect(rows.map(({ id: _id, ...row }) => row)).toEqual([
        {
          ...common,
          kind: 'DISCOUNT',
          name: 'Launch offer',
          discountType: 'FLAT',
          discountValue: 500,
          discountScope: 'PER_MONTH',
          durationMonths: null,
          trialDays: null,
          trialCommentLimit: null,
          slug: 'starter',
        },
        {
          ...common,
          kind: 'TRIAL',
          name: 'Starter 7-day trial',
          discountType: null,
          discountValue: null,
          discountScope: null,
          durationMonths: null,
          trialDays: 7,
          trialCommentLimit: 300,
          slug: 'starter',
        },
        {
          ...common,
          kind: 'DISCOUNT',
          name: 'Launch offer',
          discountType: 'FLAT',
          discountValue: 1000,
          discountScope: 'PER_MONTH',
          durationMonths: null,
          trialDays: null,
          trialCommentLimit: null,
          slug: 'growth',
        },
        {
          ...common,
          kind: 'DISCOUNT',
          name: 'Launch offer',
          discountType: 'FLAT',
          discountValue: 2000,
          discountScope: 'PER_MONTH',
          durationMonths: null,
          trialDays: null,
          trialCommentLimit: null,
          slug: 'pro',
        },
      ]);
      // Each seed targets exactly one plan.
      const targets = await db()
        .select({ promotionId: promotionPlans.promotionId })
        .from(promotionPlans)
        .where(
          inArray(
            promotionPlans.promotionId,
            rows.map((r) => r.id),
          ),
        );
      expect(targets).toHaveLength(4);
    });

    it('list − launch offer = the old offer (monthly) and the old yearly price (yearly)', async () => {
      const rows = await db()
        .select({
          slug: plans.slug,
          monthly: plans.monthlyPriceBdt,
          offer: plans.offerPriceBdt,
          yearly: plans.yearlyMonthlyPriceBdt,
          value: promotions.discountValue,
        })
        .from(plans)
        .innerJoin(promotionPlans, eq(promotionPlans.planId, plans.id))
        .innerJoin(
          promotions,
          and(
            eq(promotions.id, promotionPlans.promotionId),
            eq(promotions.kind, 'DISCOUNT'),
            isNull(promotions.createdBy),
          ),
        )
        .where(eq(plans.isActive, true))
        .orderBy(asc(plans.sortOrder));
      expect(rows.map((r) => r.slug)).toEqual(['starter', 'growth', 'pro']);
      for (const row of rows) {
        const before = PRICES_BEFORE[row.slug as keyof typeof PRICES_BEFORE];
        expect(row.monthly).toBe(before.list);
        expect(row.offer).toBe(before.offer);
        expect(row.monthly - row.value!).toBe(before.offer);
        expect(row.yearly! - row.value!).toBe(before.yearly);
      }
      expect(rows.map((r) => r.yearly)).toEqual([949, 2349, 5599]);
    });

    it('the data step is idempotent and builds the seed from the plan columns', async () => {
      const text = readFileSync(MIGRATION, 'utf8');
      const dataSql = text.slice(text.indexOf(DATA_STEP_MARKER));
      expect(dataSql.startsWith(DATA_STEP_MARKER)).toBe(true);
      const readPlans = (tx: Pick<typeof actors.db, 'select'>) =>
        tx.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.slug));
      const plansBefore = await readPlans(db());
      const seedBefore = await seeded();
      const rollback = new Error('rollback');
      await expect(
        db().transaction(async (tx) => {
          // Already applied: a second run changes nothing.
          await tx.execute(sql.raw(dataSql));
          expect(await readPlans(tx)).toEqual(plansBefore);
          const count = await tx.$count(
            promotions,
            isNull(promotions.createdBy),
          );
          expect(count).toBe(seedBefore.length);

          // Back to the pre-seed shape, with Growth's offer removed and no Starter trial: Growth
          // gets no launch offer (yearly kept), no trial is seeded.
          const seedIds = seedBefore.map((r) => r.id);
          await tx
            .delete(promotionPlans)
            .where(inArray(promotionPlans.promotionId, seedIds));
          await tx.delete(promotions).where(inArray(promotions.id, seedIds));
          await tx.execute(sql`
            update plans set yearly_monthly_price_bdt = v.yearly
            from (values ('starter', 449), ('growth', 1349), ('pro', 3599)) as v (slug, yearly)
            where plans.slug = v.slug`);
          await tx.execute(
            sql`update plans set offer_price_bdt = null where slug = 'growth'`,
          );
          await tx.execute(
            sql`update plans set trial_days = null where slug = 'starter'`,
          );
          await tx.execute(sql.raw(dataSql));
          await tx.execute(sql.raw(dataSql));
          const yearly = await tx
            .select({ slug: plans.slug, yearly: plans.yearlyMonthlyPriceBdt })
            .from(plans)
            .where(inArray(plans.slug, ['starter', 'growth', 'pro']))
            .orderBy(asc(plans.sortOrder));
          expect(yearly).toEqual([
            { slug: 'starter', yearly: 949 },
            { slug: 'growth', yearly: 1349 },
            { slug: 'pro', yearly: 5599 },
          ]);
          const reseeded = await tx
            .select({
              kind: promotions.kind,
              value: promotions.discountValue,
              slug: plans.slug,
            })
            .from(promotions)
            .innerJoin(
              promotionPlans,
              eq(promotionPlans.promotionId, promotions.id),
            )
            .innerJoin(plans, eq(plans.id, promotionPlans.planId))
            .where(isNull(promotions.createdBy))
            .orderBy(asc(plans.sortOrder));
          expect(reseeded).toEqual([
            { kind: 'DISCOUNT', value: 500, slug: 'starter' },
            { kind: 'DISCOUNT', value: 2000, slug: 'pro' },
          ]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await readPlans(db())).toEqual(plansBefore);
    });
  });

  describe('plans: display fields + price checks', () => {
    const setPlan = (patch: Partial<typeof plans.$inferInsert>, id = planId) =>
      db().update(plans).set(patch).where(eq(plans.id, id));
    afterEach(async () => {
      await db()
        .update(plans)
        .set({
          badgeEn: null,
          badgeBn: null,
          descriptionEn: null,
          descriptionBn: null,
          isHighlighted: false,
          offerPriceBdt: null,
          yearlyMonthlyPriceBdt: null,
          monthlyPriceBdt: 999,
        })
        .where(inArray(plans.id, [planId, otherPlanId]));
    });

    it('accepts badge/description in en + bn at their limits (Bangla counts characters)', async () => {
      await setPlan({
        badgeEn: 'P'.repeat(24),
        badgeBn: 'জনপ্রিয়'.padEnd(24, 'য'),
        descriptionEn: 'd'.repeat(160),
        descriptionBn: 'ব'.repeat(160),
      });
    });

    it.each([
      ['empty badge_en', { badgeEn: '' }],
      ['badge_en 25 chars', { badgeEn: 'P'.repeat(25) }],
      ['empty badge_bn', { badgeBn: '' }],
      ['badge_bn 25 chars', { badgeBn: 'য'.repeat(25) }],
      ['empty description_en', { descriptionEn: '' }],
      ['description_en 161 chars', { descriptionEn: 'd'.repeat(161) }],
      ['empty description_bn', { descriptionBn: '' }],
      ['description_bn 161 chars', { descriptionBn: 'ব'.repeat(161) }],
      ['negative monthly price', { monthlyPriceBdt: -1 }],
      ['yearly above the monthly list price', { yearlyMonthlyPriceBdt: 1000 }],
      ['offer above the monthly list price', { offerPriceBdt: 1000 }],
    ])('rejects %s (check)', async (_label, patch) => {
      expect(await pgCode(setPlan(patch))).toBe(CHECK_VIOLATION);
    });

    it('yearly is capped by the list price, not the offer (offer ৳499, yearly ৳949 is fine)', async () => {
      await setPlan({ offerPriceBdt: 499, yearlyMonthlyPriceBdt: 949 });
      await setPlan({ yearlyMonthlyPriceBdt: 999 });
    });

    it('at most one highlighted plan (partial unique)', async () => {
      await setPlan({ isHighlighted: true });
      expect(await pgCode(setPlan({ isHighlighted: true }, otherPlanId))).toBe(
        UNIQUE_VIOLATION,
      );
      await setPlan({ isHighlighted: false });
      await setPlan({ isHighlighted: true }, otherPlanId);
    });
  });

  describe('promotions', () => {
    it('accepts each kind with its own columns', async () => {
      await insertPromotion(trial());
      await insertPromotion(trial({ trialCommentLimit: null, trialDays: 90 }));
      await insertPromotion(discount());
      await insertPromotion(
        discount({
          discountType: 'PERCENT',
          discountValue: 100,
          discountScope: 'TOTAL',
          durationMonths: null,
          allPlans: true,
          endsAt: new Date('2026-12-31T17:59:59.999Z'),
          maxRedemptions: 1,
          stoppedAt: new Date(),
          stoppedBy: b.id,
        }),
      );
      await insertPromotion(coupon());
      await insertPromotion(coupon({ code: `A-1-${tag}`.slice(0, 32) }));
    });

    it.each<[string, PromotionInsert | (() => PromotionInsert)]>([
      ['empty name', () => discount({ name: '' })],
      ['name 61 chars', () => discount({ name: 'n'.repeat(61) })],
      ['unknown kind', () => discount({ kind: 'GIFT' as 'DISCOUNT' })],
      ['TRIAL without trial_days', () => trial({ trialDays: null })],
      [
        'TRIAL with a discount',
        () =>
          trial({
            discountType: 'FLAT',
            discountValue: 1,
            discountScope: 'TOTAL',
          }),
      ],
      ['TRIAL with duration_months', () => trial({ durationMonths: 3 })],
      ['TRIAL with a code', () => trial({ code: 'TRIAL-CODE' })],
      ['DISCOUNT with trial_days', () => discount({ trialDays: 7 })],
      [
        'DISCOUNT with trial_comment_limit',
        () => discount({ trialCommentLimit: 300 }),
      ],
      ['DISCOUNT without a type', () => discount({ discountType: null })],
      ['DISCOUNT without a value', () => discount({ discountValue: null })],
      ['DISCOUNT without a scope', () => discount({ discountScope: null })],
      ['DISCOUNT with a code', () => discount({ code: 'SAVE-10' })],
      ['COUPON without a code', () => coupon({ code: null })],
      ['lowercase code', () => coupon({ code: 'save-10' })],
      ['code with _', () => coupon({ code: 'SAVE_10' })],
      ['code 2 chars', () => coupon({ code: 'AB' })],
      ['code 33 chars', () => coupon({ code: 'A'.repeat(33) })],
      [
        'unknown discount type',
        () => discount({ discountType: 'FREE' as 'FLAT' }),
      ],
      ['unknown scope', () => discount({ discountScope: 'YEAR' as 'TOTAL' })],
      ['FLAT 0', () => discount({ discountValue: 0 })],
      [
        'FLAT above the price max',
        () => discount({ discountValue: 1_000_001 }),
      ],
      [
        'PERCENT 0',
        () => discount({ discountType: 'PERCENT', discountValue: 0 }),
      ],
      [
        'PERCENT 101',
        () => discount({ discountType: 'PERCENT', discountValue: 101 }),
      ],
      ['duration_months 0', () => discount({ durationMonths: 0 })],
      ['trial_days 0', () => trial({ trialDays: 0 })],
      ['trial_days 91', () => trial({ trialDays: 91 })],
      ['negative trial_comment_limit', () => trial({ trialCommentLimit: -1 })],
      [
        'trial_comment_limit above the max',
        () => trial({ trialCommentLimit: 10_000_001 }),
      ],
      ['max_redemptions 0', () => discount({ maxRedemptions: 0 })],
      [
        'stopped_at without stopped_by',
        () => discount({ stoppedAt: new Date() }),
      ],
      ['stopped_by without stopped_at', () => discount({ stoppedBy: a.id })],
    ])('rejects %s (check)', async (_label, row) => {
      const value = typeof row === 'function' ? row() : row;
      expect(await pgCode(db().insert(promotions).values(value))).toBe(
        CHECK_VIOLATION,
      );
    });

    it('coupon codes are unique', async () => {
      await insertPromotion(coupon({ code: `UNIQ-${tag}` }));
      expect(
        await pgCode(
          db()
            .insert(promotions)
            .values(coupon({ code: `UNIQ-${tag}`, name: 'Other' })),
        ),
      ).toBe(UNIQUE_VIOLATION);
    });

    it('creator and stopper are users (FK, restrict)', async () => {
      expect(
        await pgCode(
          db()
            .insert(promotions)
            .values(discount({ createdBy: UNKNOWN_ID })),
        ),
      ).toBe(FK_VIOLATION);
      expect(
        await pgCode(
          db()
            .insert(promotions)
            .values(discount({ stoppedAt: new Date(), stoppedBy: UNKNOWN_ID })),
        ),
      ).toBe(FK_VIOLATION);
    });
  });

  describe('promotion_plans', () => {
    it('one row per promotion × plan; FKs restrict both ways', async () => {
      const promotionId = await insertPromotion(discount());
      await db().insert(promotionPlans).values({ promotionId, planId });
      expect(
        await pgCode(
          db().insert(promotionPlans).values({ promotionId, planId }),
        ),
      ).toBe(UNIQUE_VIOLATION);
      expect(
        await pgCode(
          db()
            .insert(promotionPlans)
            .values({ promotionId, planId: UNKNOWN_ID }),
        ),
      ).toBe(FK_VIOLATION);
      expect(
        await pgCode(
          db()
            .insert(promotionPlans)
            .values({ promotionId: UNKNOWN_ID, planId }),
        ),
      ).toBe(FK_VIOLATION);
      // A targeted plan and a promotion with targets can't be deleted.
      expect(await pgCode(db().delete(plans).where(eq(plans.id, planId)))).toBe(
        FK_VIOLATION,
      );
      expect(
        await pgCode(
          db().delete(promotions).where(eq(promotions.id, promotionId)),
        ),
      ).toBe(FK_VIOLATION);
    });
  });

  describe('promotion_redemptions', () => {
    afterEach(async () => {
      await db()
        .update(subscriptions)
        .set({ promotionRedemptionId: null, couponRedemptionId: null })
        .where(eq(subscriptions.id, subscriptionId));
      await db()
        .delete(promotionRedemptions)
        .where(
          inArray(promotionRedemptions.billingAccountId, [accountA, accountB]),
        );
    });

    it('once per account per promotion (PR-D3); other accounts may claim it too', async () => {
      const promotionId = await insertPromotion(discount());
      await db().insert(promotionRedemptions).values(redemption(promotionId));
      expect(
        await pgCode(
          db().insert(promotionRedemptions).values(redemption(promotionId)),
        ),
      ).toBe(UNIQUE_VIOLATION);
      await db()
        .insert(promotionRedemptions)
        .values(redemption(promotionId, { billingAccountId: accountB }));
    });

    it('one trial per account ever, across trial promotions (reading 1)', async () => {
      const first = await insertPromotion(trial());
      const second = await insertPromotion(trial({ name: 'Other trial' }));
      const trialClaim = (promotionId: string): RedemptionInsert => ({
        promotionId,
        billingAccountId: accountA,
        kind: 'TRIAL',
        trialDays: 7,
        trialCommentLimit: 300,
      });
      await db().insert(promotionRedemptions).values(trialClaim(first));
      expect(
        await pgCode(
          db().insert(promotionRedemptions).values(trialClaim(second)),
        ),
      ).toBe(UNIQUE_VIOLATION);
      // A discount next to the trial is fine.
      const other = await insertPromotion(discount());
      await db().insert(promotionRedemptions).values(redemption(other));
    });

    it('defaults: redeemed now, 0 months used, ৳0 saving', async () => {
      const promotionId = await insertPromotion(trial());
      const [row] = await db()
        .insert(promotionRedemptions)
        .values({
          promotionId,
          billingAccountId: accountA,
          kind: 'TRIAL',
          trialDays: 7,
        })
        .returning();
      expect(row).toMatchObject({
        monthsUsed: 0,
        discountBdtFirstTerm: 0,
        subscriptionId: null,
      });
      expect(Math.abs(row!.redeemedAt.getTime() - Date.now())).toBeLessThan(
        60_000,
      );
    });

    it.each<[string, Partial<RedemptionInsert>]>([
      ['negative months_used', { monthsUsed: -1 }],
      ['negative discount_bdt_first_term', { discountBdtFirstTerm: -1 }],
      ['snapshot without a scope', { discountScope: null }],
      ['snapshot with trial_days', { trialDays: 7 }],
      ['snapshot PERCENT 101', { discountType: 'PERCENT', discountValue: 101 }],
      ['TRIAL snapshot with a discount', { kind: 'TRIAL', trialDays: 7 }],
      ['unknown kind', { kind: 'GIFT' as 'DISCOUNT' }],
    ])('rejects %s (check)', async (_label, patch) => {
      const promotionId = await insertPromotion(discount());
      expect(
        await pgCode(
          db()
            .insert(promotionRedemptions)
            .values(redemption(promotionId, patch)),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('FKs restrict: promotion, account and subscription in use; unknown ids', async () => {
      const promotionId = await insertPromotion(discount());
      await db()
        .insert(promotionRedemptions)
        .values(redemption(promotionId, { subscriptionId }));
      expect(
        await pgCode(
          db().delete(promotions).where(eq(promotions.id, promotionId)),
        ),
      ).toBe(FK_VIOLATION);
      // Account B has nothing but this claim.
      await db()
        .insert(promotionRedemptions)
        .values(redemption(promotionId, { billingAccountId: accountB }));
      expect(
        await pgCode(
          db().delete(billingAccounts).where(eq(billingAccounts.id, accountB)),
        ),
      ).toBe(FK_VIOLATION);
      expect(
        await pgCode(
          db()
            .delete(subscriptions)
            .where(eq(subscriptions.id, subscriptionId)),
        ),
      ).toBe(FK_VIOLATION);
      const fresh = await insertPromotion(discount());
      for (const patch of [
        { promotionId: UNKNOWN_ID },
        { billingAccountId: UNKNOWN_ID },
        { subscriptionId: UNKNOWN_ID },
      ]) {
        expect(
          await pgCode(
            db()
              .insert(promotionRedemptions)
              .values(
                redemption(fresh, {
                  billingAccountId: accountB,
                  ...patch,
                }),
              ),
          ),
        ).toBe(FK_VIOLATION);
      }
    });

    it('subscriptions link their discount and coupon redemptions (FKs restrict)', async () => {
      const discountId = await insertPromotion(discount());
      const couponId = await insertPromotion(coupon({ code: `LINK-${tag}` }));
      const [claim] = await db()
        .insert(promotionRedemptions)
        .values(redemption(discountId, { subscriptionId }))
        .returning({ id: promotionRedemptions.id });
      const [couponClaim] = await db()
        .insert(promotionRedemptions)
        .values(
          redemption(couponId, {
            kind: 'COUPON',
            discountType: 'PERCENT',
            discountValue: 50,
            discountScope: 'TOTAL',
            durationMonths: null,
          }),
        )
        .returning({ id: promotionRedemptions.id });
      await db()
        .update(subscriptions)
        .set({
          promotionRedemptionId: claim!.id,
          couponRedemptionId: couponClaim!.id,
        })
        .where(eq(subscriptions.id, subscriptionId));
      expect(
        await pgCode(
          db()
            .delete(promotionRedemptions)
            .where(eq(promotionRedemptions.id, couponClaim!.id)),
        ),
      ).toBe(FK_VIOLATION);
      for (const patch of [
        { promotionRedemptionId: UNKNOWN_ID },
        { couponRedemptionId: UNKNOWN_ID },
      ]) {
        expect(
          await pgCode(
            db()
              .update(subscriptions)
              .set(patch)
              .where(eq(subscriptions.id, subscriptionId)),
          ),
        ).toBe(FK_VIOLATION);
      }
    });
  });

  describe('platform_settings (support WhatsApp, PR-D18)', () => {
    afterEach(() => db().delete(platformSettings));

    it('one row; the number is optional, BD mobile digits with 880', async () => {
      await db()
        .insert(platformSettings)
        .values({ supportWhatsappNumber: null, updatedById: a.id });
      await db()
        .update(platformSettings)
        .set({ supportWhatsappNumber: '8801712345678' });
      expect(
        await pgCode(db().insert(platformSettings).values({ id: 1 })),
      ).toBe(UNIQUE_VIOLATION);
      expect(
        await pgCode(db().insert(platformSettings).values({ id: 2 })),
      ).toBe(CHECK_VIOLATION);
    });

    it.each([
      '01712345678',
      '+8801712345678',
      '8801212345678',
      '880171234567',
      '88017123456789',
      '',
    ])('rejects %j (check)', async (number) => {
      expect(
        await pgCode(
          db()
            .insert(platformSettings)
            .values({ supportWhatsappNumber: number }),
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });
});

import type { INestApplication } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { paymentAmount } from '../src/billing/paid-term.js';
import {
  type PaidTermInput,
  SubscriptionService,
} from '../src/billing/subscription.service.js';
import {
  type PaymentKind,
  PLAN_FEATURE_KEYS,
  type PlanFeatureKey,
  plans,
  promotionPlans,
  promotionRedemptions,
  promotions,
  subscriptionAuditLogs,
  subscriptions,
  type SubscriptionInterval,
  walletBalances,
  walletEntries,
  wallets,
} from '../src/db/schema/index.js';
import { monthlyReset } from '../src/wallet/wallet-period.js';
import { WalletService } from '../src/wallet/wallet.service.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const DAY = 86_400_000;

/**
 * M8-T3: `SubscriptionService.activatePaidTerm` (source PAYMENT) + `checkoutPrice` (D4 renewal
 * moves the term, D6 trial → paid, D7 upgrade credit, PR-D19 coupon months). No routes yet
 * (M8-T4); no SSLCommerz call. Real Postgres.
 */
describe('Paid-term core (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let billing: SubscriptionService;
  let superAdmin: Actor;
  const db = () => actors.db;
  const tag = `${Date.now()}`.slice(-8);
  let plan: {
    id: string;
    monthlyPriceBdt: number;
    yearlyMonthlyPriceBdt: number | null;
  };

  const promo = async (row: Partial<typeof promotions.$inferInsert>) => {
    const [p] = await db()
      .insert(promotions)
      .values({
        kind: 'DISCOUNT',
        name: 'M8-T3 offer',
        discountType: 'FLAT',
        discountValue: 100,
        discountScope: 'PER_MONTH',
        createdBy: superAdmin.id,
        ...row,
      })
      .returning({ id: promotions.id });
    await db()
      .insert(promotionPlans)
      .values({ promotionId: p!.id, planId: plan.id });
    return p!.id;
  };

  /** Prices + activates one term like a validated payment would (M8-T5). */
  async function pay(
    owner: Actor,
    kind: PaymentKind,
    opts: {
      interval?: SubscriptionInterval;
      couponCode?: string;
      now?: Date;
    } = {},
  ) {
    const now = opts.now ?? new Date();
    const interval = opts.interval ?? 'month';
    const accountId = await actors.accountIdOf(owner);
    const price = await billing.checkoutPrice(
      accountId,
      plan,
      interval,
      opts.couponCode,
      kind,
      now,
    );
    const input: PaidTermInput = {
      accountId,
      workspaceId: owner.workspaceId,
      planId: plan.id,
      interval,
      kind,
      start: now,
      price,
      source: 'PAYMENT',
      reason: `Payment m8t3-${kind}`,
      now,
    };
    const done = await db().transaction((tx) =>
      billing.activatePaidTerm(tx, input),
    );
    return { price, done };
  }

  const subsOf = async (owner: Actor) =>
    db()
      .select()
      .from(subscriptions)
      .where(
        eq(subscriptions.billingAccountId, await actors.accountIdOf(owner)),
      )
      .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));
  const auditOf = async (owner: Actor) =>
    db()
      .select()
      .from(subscriptionAuditLogs)
      .where(
        eq(
          subscriptionAuditLogs.billingAccountId,
          await actors.accountIdOf(owner),
        ),
      )
      .orderBy(asc(subscriptionAuditLogs.createdAt));
  const redemptionsOf = async (owner: Actor) =>
    db()
      .select()
      .from(promotionRedemptions)
      .where(
        eq(
          promotionRedemptions.billingAccountId,
          await actors.accountIdOf(owner),
        ),
      )
      .orderBy(asc(promotionRedemptions.redeemedAt));
  const walletOf = async (owner: Actor) => {
    const [w] = await db()
      .select()
      .from(wallets)
      .where(eq(wallets.billingAccountId, await actors.accountIdOf(owner)));
    return w!;
  };
  const grantsOf = async (owner: Actor) =>
    db()
      .select()
      .from(walletEntries)
      .where(eq(walletEntries.walletId, (await walletOf(owner)).id))
      .orderBy(asc(walletEntries.createdAt), asc(walletEntries.id));

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    billing = app.get(SubscriptionService);
    superAdmin = await actors.signUpSuperAdmin('m8t3-super');
    const [row] = await db()
      .insert(plans)
      .values({
        slug: `m8t3-${tag}`,
        name: 'M8T3',
        sortOrder: 96,
        isActive: true,
        monthlyPriceBdt: 1000,
        yearlyMonthlyPriceBdt: 900,
        featureConfig: {
          limits: {
            connectedPages: 1,
            monthlyComments: 100,
            teamSeats: 1,
            workspaces: 1,
          },
          features: Object.fromEntries(
            PLAN_FEATURE_KEYS.map((key) => [key, false]),
          ) as Record<PlanFeatureKey, boolean>,
        },
      })
      .returning();
    plan = row!;
  });

  afterAll(async () => {
    await actors?.cleanup();
    if (plan)
      await db()
        .delete(plans)
        .where(inArray(plans.id, [plan.id]));
    await app?.close();
  });

  it('trial → paid (D6), source PAYMENT: trial ends, ACTIVE term from the payment, fresh wallet period, audit row without admin', async () => {
    const owner = await actors.signUp('m8t3-trial', { trial: true });
    await app
      .get(WalletService)
      .consume(owner.workspaceId, 'monthlyComments', 3);
    const now = new Date();
    const { done } = await pay(owner, 'NEW', { now });

    const [trial, paid] = await subsOf(owner);
    expect(trial).toMatchObject({ status: 'CANCELED', canceledAt: now });
    expect(paid).toMatchObject({
      id: done.subscriptionId,
      planId: plan.id,
      status: 'ACTIVE',
      interval: 'month',
      currentTermStart: now,
      currentTermEnd: monthlyReset(now, 1),
      chargedBdt: 1000,
      pricePerMonthBdt: 1000,
    });
    expect(done.balances!.get('monthlyComments')).toMatchObject({
      used: 0,
      included: 100,
    });
    const balances = await db()
      .select()
      .from(walletBalances)
      .where(eq(walletBalances.walletId, (await walletOf(owner)).id))
      .orderBy(asc(walletBalances.periodStart));
    expect(balances.at(-1)).toMatchObject({
      meter: 'monthlyComments',
      periodStart: now,
      used: 0,
      included: 100,
    });
    expect((await grantsOf(owner)).at(-1)).toMatchObject({
      kind: 'PLAN_GRANT',
      reference: done.subscriptionId,
      actorUserId: null,
    });
    expect(await auditOf(owner)).toEqual([
      expect.objectContaining({
        source: 'PAYMENT',
        adminId: null,
        workspaceId: owner.workspaceId,
        beforeSubscriptionId: trial!.id,
        beforeStatus: 'TRIALING',
        afterSubscriptionId: paid!.id,
        afterStatus: 'ACTIVE',
        reason: 'Payment m8t3-NEW',
        price: {
          listChargedBdt: 1000,
          chargedBdt: 1000,
          perMonthBdt: 1000,
          discount: null,
          coupon: null,
        },
      }),
    ]);
  });

  it('the audit row refuses PAYMENT with an admin and ADMIN without one', async () => {
    const owner = await actors.signUp('m8t3-check');
    await pay(owner, 'NEW');
    const [row] = await auditOf(owner);
    const { id: _id, createdAt: _at, ...copy } = row!;
    for (const bad of [
      { ...copy, source: 'PAYMENT' as const, adminId: superAdmin.id },
      { ...copy, source: 'ADMIN' as const, adminId: null },
    ]) {
      await expect(
        db().insert(subscriptionAuditLogs).values(bad),
      ).rejects.toMatchObject({
        cause: { constraint: 'subscription_audit_logs_source_check' },
      });
    }
  });

  it('renewal moves the same row (D4) and keeps a claimed discount "k of N"; no fresh wallet grant', async () => {
    const owner = await actors.signUp('m8t3-renew');
    const id = await promo({ name: 'Three months', durationMonths: 3 });
    const first = await pay(owner, 'NEW');
    const [claim] = await redemptionsOf(owner);
    expect(claim).toMatchObject({ promotionId: id, monthsUsed: 1 });
    expect(first.done.price.discount).toMatchObject({
      redemptionId: claim!.id,
      months: { from: 1, to: 1, of: 3 },
    });
    const [sub] = await subsOf(owner);
    const grants = (await grantsOf(owner)).length;

    const renewal = await pay(owner, 'RENEWAL');
    expect(renewal.price).toMatchObject({
      chargedBdt: 900,
      creditBdt: 0,
      discount: {
        promotionId: id,
        redemptionId: claim!.id,
        months: { from: 2, to: 2, of: 3 },
      },
    });
    expect(renewal.done).toMatchObject({
      subscriptionId: sub!.id,
      term: {
        extend: true,
        start: sub!.currentTermEnd,
        end: monthlyReset(sub!.currentTermStart, 2),
      },
      balances: null,
    });
    expect(await subsOf(owner)).toEqual([
      expect.objectContaining({
        id: sub!.id,
        status: 'ACTIVE',
        currentTermStart: sub!.currentTermStart,
        currentTermEnd: monthlyReset(sub!.currentTermStart, 2),
        chargedBdt: 900,
        promotionRedemptionId: claim!.id,
      }),
    ]);
    expect(await redemptionsOf(owner)).toEqual([
      expect.objectContaining({ id: claim!.id, monthsUsed: 2 }),
    ]);
    expect(await grantsOf(owner)).toHaveLength(grants);
    expect((await auditOf(owner)).at(-1)).toMatchObject({
      source: 'PAYMENT',
      beforeSubscriptionId: sub!.id,
      afterSubscriptionId: sub!.id,
    });
    // Stopped: no new claims by the next tests (this claim would keep running, PR-D15).
    await db()
      .update(promotions)
      .set({ stoppedAt: new Date(), stoppedBy: superAdmin.id })
      .where(eq(promotions.id, id));
  });

  it('a coupon carries on renewals only for its months (PR-D19), then stops', async () => {
    const owner = await actors.signUp('m8t3-coupon');
    const code = `M8T3-TWO-${tag}`;
    const coupon = await promo({
      kind: 'COUPON',
      code,
      name: 'Two months',
      discountValue: 50,
      durationMonths: 2,
    });

    const first = await pay(owner, 'NEW', { couponCode: code.toLowerCase() });
    expect(first.price).toMatchObject({
      chargedBdt: 950,
      coupon: {
        promotionId: coupon,
        code,
        redemptionId: null,
        months: { from: 1, to: 1, of: 2 },
      },
    });
    const [claim] = await redemptionsOf(owner);
    expect(claim).toMatchObject({ promotionId: coupon, monthsUsed: 1 });
    expect((await subsOf(owner))[0]).toMatchObject({
      couponRedemptionId: claim!.id,
    });

    // Typed again: once per account.
    await expect(
      pay(owner, 'RENEWAL', { couponCode: code }),
    ).rejects.toMatchObject({
      response: { code: 'COUPON_ALREADY_USED' },
    });

    const second = await pay(owner, 'RENEWAL');
    expect(second.price).toMatchObject({
      chargedBdt: 950,
      coupon: {
        redemptionId: claim!.id,
        months: { from: 2, to: 2, of: 2 },
      },
    });
    expect((await redemptionsOf(owner))[0]!.monthsUsed).toBe(2);

    const third = await pay(owner, 'RENEWAL');
    expect(third.price).toMatchObject({ chargedBdt: 1000, coupon: null });
    expect((await subsOf(owner))[0]).toMatchObject({
      chargedBdt: 1000,
      couponRedemptionId: null,
    });
    expect(await redemptionsOf(owner)).toHaveLength(1);
  });

  it('upgrade (D7): month → year from today, the unused days come off', async () => {
    const owner = await actors.signUp('m8t3-upgrade');
    const start = new Date(Date.now() - 10 * DAY);
    await pay(owner, 'NEW', { now: start });
    const [old] = await subsOf(owner);

    const now = new Date();
    const { price, done } = await pay(owner, 'UPGRADE', {
      interval: 'year',
      now,
    });
    const termDays = Math.round(
      (old!.currentTermEnd.getTime() - start.getTime()) / DAY,
    );
    const unused = Math.floor(
      (old!.currentTermEnd.getTime() - now.getTime()) / DAY,
    );
    const credit = Math.floor((old!.chargedBdt! * unused) / termDays);
    expect(credit).toBeGreaterThan(0);
    expect(price).toMatchObject({
      listChargedBdt: 10_800,
      chargedBdt: 10_800,
      creditBdt: credit,
    });
    expect(paymentAmount(price)).toBe(10_800 - credit);
    expect(done.term).toEqual({
      extend: false,
      start: now,
      end: monthlyReset(now, 12),
    });
    expect((await subsOf(owner)).map((s) => s.status)).toEqual([
      'CANCELED',
      'ACTIVE',
    ]);
    expect(done.balances!.get('monthlyComments')!.used).toBe(0);
  });
});

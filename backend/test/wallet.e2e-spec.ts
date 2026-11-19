import type { INestApplication } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import type { Database } from '../src/db/database.js';
import {
  billingAccounts,
  plans,
  subscriptions,
  walletBalances,
  walletEntries,
  wallets,
  workspaces,
} from '../src/db/schema/index.js';
import { findLiveSubscription } from '../src/wallet/live-subscription.queries.js';
import { WalletService } from '../src/wallet/wallet.service.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

/** An instant from a Dhaka wall clock (`YYYY-MM-DDTHH:mm`), Asia/Dhaka = UTC+6. */
const dhaka = (wall: string) => new Date(`${wall}:00.000+06:00`);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const featureConfig = (monthlyComments: number) => ({
  limits: { connectedPages: 1, monthlyComments, teamSeats: 1, workspaces: 1 },
  features: {},
});

/**
 * PW-T2: `WalletService` against real Postgres (user decisions 2026-11-19 PW-D3 one wallet per
 * billing account, PW-D4 monthly reset on the billing date, PW-D9 no live plan, PW-D12 trial
 * grant, PW-D14 limit edits from the next reset). Billing accounts and subscriptions are inserted
 * directly (the sign-up trial of PW-T3 is removed first); every call passes an explicit `now`.
 * Throwaway plans (`pwt2-*`) are removed in `afterAll` after `cleanup()`.
 */
describe('Client wallet (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let wallet: WalletService;
  /** Owner of account A (workspace a). */
  let a: Actor;
  /** Owner of account B (workspace b). */
  let b: Actor;
  /** A second workspace linked to account A (pooled). */
  let c: Actor;
  /** A workspace with no billing account. */
  let d: Actor;
  let accountA: string;
  let accountB: string;
  const planIds: Record<string, string> = {};
  const tag = Date.now().toString(36);

  const db = (): Database => actors.db;
  const T0 = dhaka('2026-11-19T15:30');
  const T1 = dhaka('2026-12-19T15:30');

  async function insertPlan(
    key: string,
    monthlyComments: number,
    trialCommentLimit: number | null = null,
  ) {
    const [row] = await db()
      .insert(plans)
      .values({
        slug: `pwt2-${key}-${tag}`,
        name: `PWT2 ${key} ${tag}`,
        sortOrder: 90,
        monthlyPriceBdt: 499,
        trialCommentLimit,
        featureConfig: featureConfig(
          monthlyComments,
        ) as typeof plans.$inferInsert.featureConfig,
      })
      .returning({ id: plans.id });
    planIds[key] = row!.id;
  }

  const setPlanLimit = (key: string, monthlyComments: number) =>
    db()
      .update(plans)
      .set({
        featureConfig: featureConfig(
          monthlyComments,
        ) as typeof plans.$inferInsert.featureConfig,
      })
      .where(eq(plans.id, planIds[key]!));

  async function resetAccounts() {
    const accounts = [accountA, accountB];
    const walletIds = db()
      .select({ id: wallets.id })
      .from(wallets)
      .where(inArray(wallets.billingAccountId, accounts));
    await db()
      .delete(walletEntries)
      .where(inArray(walletEntries.walletId, walletIds));
    await db()
      .delete(walletBalances)
      .where(inArray(walletBalances.walletId, walletIds));
    await db()
      .delete(wallets)
      .where(inArray(wallets.billingAccountId, accounts));
    await db()
      .delete(subscriptions)
      .where(inArray(subscriptions.billingAccountId, accounts));
  }

  async function active(
    account: string,
    planKey: string,
    termStart: Date,
    termEnd: Date,
    patch: Partial<typeof subscriptions.$inferInsert> = {},
  ) {
    const [row] = await db()
      .insert(subscriptions)
      .values({
        billingAccountId: account,
        planId: planIds[planKey]!,
        interval: 'month',
        status: 'ACTIVE',
        startedAt: termStart,
        currentTermStart: termStart,
        currentTermEnd: termEnd,
        pricePerMonthBdt: 499,
        chargedBdt: 499,
        ...patch,
      })
      .returning({ id: subscriptions.id });
    return row!.id;
  }

  async function trial(
    account: string,
    planKey: string,
    start: Date,
    end: Date,
  ) {
    const [row] = await db()
      .insert(subscriptions)
      .values({
        billingAccountId: account,
        planId: planIds[planKey]!,
        interval: 'month',
        status: 'TRIALING',
        startedAt: start,
        trialEndsAt: end,
        currentTermStart: start,
        currentTermEnd: end,
      })
      .returning({ id: subscriptions.id });
    return row!.id;
  }

  const walletsOf = (account: string) =>
    db().select().from(wallets).where(eq(wallets.billingAccountId, account));

  const balancesOf = (account: string) =>
    db()
      .select({
        meter: walletBalances.meter,
        periodStart: walletBalances.periodStart,
        periodEnd: walletBalances.periodEnd,
        included: walletBalances.included,
        added: walletBalances.added,
        used: walletBalances.used,
      })
      .from(walletBalances)
      .innerJoin(wallets, eq(wallets.id, walletBalances.walletId))
      .where(eq(wallets.billingAccountId, account))
      .orderBy(asc(walletBalances.periodStart));

  const entriesOf = (account: string) =>
    db()
      .select({
        meter: walletEntries.meter,
        periodStart: walletEntries.periodStart,
        kind: walletEntries.kind,
        amount: walletEntries.amount,
        reference: walletEntries.reference,
      })
      .from(walletEntries)
      .innerJoin(wallets, eq(wallets.id, walletEntries.walletId))
      .where(eq(wallets.billingAccountId, account))
      .orderBy(asc(walletEntries.periodStart));

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    wallet = app.get(WalletService);
    a = await actors.signUp('pwt2-a');
    b = await actors.signUp('pwt2-b');
    c = await actors.signUp('pwt2-c');
    d = await actors.signUp('pwt2-d');
    // Sign-up now starts a Starter trial (PW-T3): this spec builds its own accounts.
    await actors.removeBilling(a, b, c, d);
    const [rowA] = await db()
      .insert(billingAccounts)
      .values({ ownerUserId: a.id })
      .returning({ id: billingAccounts.id });
    const [rowB] = await db()
      .insert(billingAccounts)
      .values({ ownerUserId: b.id })
      .returning({ id: billingAccounts.id });
    accountA = rowA!.id;
    accountB = rowB!.id;
    await db()
      .update(workspaces)
      .set({ billingAccountId: accountA })
      .where(inArray(workspaces.id, [a.workspaceId, c.workspaceId]));
    await db()
      .update(workspaces)
      .set({ billingAccountId: accountB })
      .where(eq(workspaces.id, b.workspaceId));
    await insertPlan('five', 5);
    await insertPlan('trial', 10, 3);
    await insertPlan('trialnull', 10, null);
  });

  afterAll(async () => {
    if (actors) {
      await actors.cleanup();
      const ids = Object.values(planIds);
      if (ids.length) await db().delete(plans).where(inArray(plans.id, ids));
    }
    await app?.close();
  });

  beforeEach(async () => {
    await resetAccounts();
    await setPlanLimit('five', 5);
  });

  it('first consume creates the wallet, the period balance and one PLAN_GRANT', async () => {
    const subId = await active(accountA, 'five', T0, T1);
    const now = dhaka('2026-11-25T12:00');
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 1, now)).toBe(
      'ok',
    );
    const [w] = await walletsOf(accountA);
    expect(w).toMatchObject({
      cycleAnchorAt: T0,
      currentPeriodStart: T0,
      currentPeriodEnd: T1,
    });
    expect(await balancesOf(accountA)).toEqual([
      {
        meter: 'monthlyComments',
        periodStart: T0,
        periodEnd: T1,
        included: 5,
        added: 0,
        used: 1,
      },
    ]);
    expect(await entriesOf(accountA)).toEqual([
      {
        meter: 'monthlyComments',
        periodStart: T0,
        kind: 'PLAN_GRANT',
        amount: 5,
        reference: subId,
      },
    ]);
  });

  it('limit reached → limit_reached and nothing changes', async () => {
    await active(accountA, 'five', T0, T1);
    const now = dhaka('2026-11-25T12:00');
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 3, now)).toBe(
      'ok',
    );
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 3, now)).toBe(
      'limit_reached',
    );
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 2, now)).toBe(
      'ok',
    );
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 1, now)).toBe(
      'limit_reached',
    );
    const balances = await balancesOf(accountA);
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({ included: 5, used: 5 });
    expect(await entriesOf(accountA)).toHaveLength(1);
  });

  it('20 parallel consumes on limit 5 → exactly 5 ok, one wallet / balance / grant', async () => {
    await active(accountA, 'five', T0, T1);
    const now = dhaka('2026-11-25T12:00');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        wallet.consume(
          i % 2 ? a.workspaceId : c.workspaceId,
          'monthlyComments',
          1,
          now,
        ),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect(results.filter((r) => r === 'limit_reached')).toHaveLength(15);
    expect(await walletsOf(accountA)).toHaveLength(1);
    const balances = await balancesOf(accountA);
    expect(balances).toHaveLength(1);
    expect(balances[0]!.used).toBe(5);
    expect(await entriesOf(accountA)).toHaveLength(1);
  });

  it('rollover after current_period_end grants the plan limit at that moment (PW-D14)', async () => {
    await active(accountA, 'five', T0, dhaka('2027-11-19T15:30'), {
      interval: 'year',
      chargedBdt: 499 * 12,
    });
    expect(
      await wallet.consume(
        a.workspaceId,
        'monthlyComments',
        2,
        dhaka('2026-11-20T00:00'),
      ),
    ).toBe('ok');
    await setPlanLimit('five', 8);
    // Same period: the stored grant stays 5.
    expect(
      await wallet.consume(
        a.workspaceId,
        'monthlyComments',
        3,
        dhaka('2026-12-19T15:29'),
      ),
    ).toBe('ok');
    expect(
      await wallet.consume(
        a.workspaceId,
        'monthlyComments',
        1,
        dhaka('2026-12-19T15:29'),
      ),
    ).toBe('limit_reached');
    // Exactly at the reset: a new period with the changed limit.
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 1, T1)).toBe(
      'ok',
    );
    const balances = await balancesOf(accountA);
    expect(balances).toEqual([
      expect.objectContaining({ periodStart: T0, included: 5, used: 5 }),
      expect.objectContaining({
        periodStart: T1,
        periodEnd: dhaka('2027-01-19T15:30'),
        included: 8,
        used: 1,
      }),
    ]);
    expect((await entriesOf(accountA)).map((e) => e.amount)).toEqual([5, 8]);
    const [w] = await walletsOf(accountA);
    expect(w).toMatchObject({
      cycleAnchorAt: T0,
      currentPeriodStart: T1,
      currentPeriodEnd: dhaka('2027-01-19T15:30'),
    });
    // A late consume of the old period never moves the stored period back.
    expect(
      await wallet.consume(
        a.workspaceId,
        'monthlyComments',
        1,
        dhaka('2026-12-01T00:00'),
      ),
    ).toBe('limit_reached');
    expect((await walletsOf(accountA))[0]!.currentPeriodStart).toEqual(T1);
  });

  it('a yearly ACTIVE term resets monthly on the clamped billing date until the term ends', async () => {
    const start = dhaka('2027-01-31T10:00');
    const end = dhaka('2028-01-31T10:00');
    await active(accountA, 'five', start, end, {
      interval: 'year',
      chargedBdt: 499 * 12,
    });
    for (const wall of [
      '2027-02-10T00:00',
      '2027-03-05T00:00',
      '2027-04-15T00:00',
      '2028-01-30T00:00',
    ]) {
      expect(
        await wallet.consume(a.workspaceId, 'monthlyComments', 1, dhaka(wall)),
      ).toBe('ok');
    }
    expect(
      (await balancesOf(accountA)).map((r) => [r.periodStart, r.periodEnd]),
    ).toEqual([
      [start, dhaka('2027-02-28T10:00')],
      [dhaka('2027-02-28T10:00'), dhaka('2027-03-31T10:00')],
      [dhaka('2027-03-31T10:00'), dhaka('2027-04-30T10:00')],
      [dhaka('2027-12-31T10:00'), end],
    ]);
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 1, end)).toBe(
      'no_active_plan',
    );
  });

  it('a trial is one period granted trial_comment_limit (PW-D12)', async () => {
    const end = new Date(T0.getTime() + 40 * DAY);
    const subId = await trial(accountA, 'trial', T0, end);
    expect(
      await wallet.consume(
        a.workspaceId,
        'monthlyComments',
        2,
        new Date(T0.getTime() + DAY),
      ),
    ).toBe('ok');
    // 35 days later (past a monthly reset date): still the same single period.
    expect(
      await wallet.consume(
        a.workspaceId,
        'monthlyComments',
        1,
        new Date(T0.getTime() + 35 * DAY),
      ),
    ).toBe('ok');
    expect(
      await wallet.consume(
        a.workspaceId,
        'monthlyComments',
        1,
        new Date(T0.getTime() + 36 * DAY),
      ),
    ).toBe('limit_reached');
    expect(await balancesOf(accountA)).toEqual([
      {
        meter: 'monthlyComments',
        periodStart: T0,
        periodEnd: end,
        included: 3,
        added: 0,
        used: 3,
      },
    ]);
    expect(await entriesOf(accountA)).toEqual([
      expect.objectContaining({
        kind: 'PLAN_GRANT',
        amount: 3,
        reference: subId,
      }),
    ]);
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 1, end)).toBe(
      'no_active_plan',
    );
  });

  it('openPeriod grants the trial at trial start: a later trial-limit edit does not apply', async () => {
    const end = new Date(T0.getTime() + 7 * DAY);
    expect(await wallet.openPeriod(a.workspaceId, T0)).toBe(false);
    await trial(accountA, 'trial', T0, end);
    expect(await wallet.openPeriod(a.workspaceId, T0)).toBe(true);
    await db()
      .update(plans)
      .set({ trialCommentLimit: 9 })
      .where(eq(plans.id, planIds.trial!));
    try {
      // Idempotent, inside a caller transaction too.
      expect(
        await db().transaction((tx) =>
          wallet.openPeriod(a.workspaceId, new Date(T0.getTime() + DAY), tx),
        ),
      ).toBe(true);
      expect(
        await wallet.consume(
          a.workspaceId,
          'monthlyComments',
          3,
          new Date(T0.getTime() + DAY),
        ),
      ).toBe('ok');
      expect(await balancesOf(accountA)).toEqual([
        expect.objectContaining({ periodStart: T0, included: 3, used: 3 }),
      ]);
      expect(await entriesOf(accountA)).toHaveLength(1);
    } finally {
      await db()
        .update(plans)
        .set({ trialCommentLimit: 3 })
        .where(eq(plans.id, planIds.trial!));
    }
  });

  it('a trial with trial_comment_limit null grants the plan monthlyComments', async () => {
    await trial(accountA, 'trialnull', T0, new Date(T0.getTime() + 7 * DAY));
    expect(
      await wallet.consume(
        a.workspaceId,
        'monthlyComments',
        1,
        new Date(T0.getTime() + DAY),
      ),
    ).toBe('ok');
    expect((await balancesOf(accountA))[0]).toMatchObject({
      included: 10,
      used: 1,
    });
  });

  it('a new subscription re-anchors the wallet (trial → paid term)', async () => {
    const trialEnd = new Date(T0.getTime() + 7 * DAY);
    const trialId = await trial(accountA, 'trial', T0, trialEnd);
    await wallet.consume(
      a.workspaceId,
      'monthlyComments',
      1,
      new Date(T0.getTime() + DAY),
    );
    await db()
      .update(subscriptions)
      .set({ status: 'EXPIRED' })
      .where(eq(subscriptions.id, trialId));
    await active(
      accountA,
      'five',
      trialEnd,
      new Date(trialEnd.getTime() + 30 * DAY),
    );
    expect(
      await wallet.consume(
        a.workspaceId,
        'monthlyComments',
        1,
        new Date(trialEnd.getTime() + HOUR),
      ),
    ).toBe('ok');
    const [w] = await walletsOf(accountA);
    expect(w).toMatchObject({
      cycleAnchorAt: trialEnd,
      currentPeriodStart: trialEnd,
    });
    expect((await balancesOf(accountA)).map((r) => r.included)).toEqual([3, 5]);
  });

  it('no live plan → no_active_plan and nothing written', async () => {
    const now = dhaka('2026-11-25T12:00');
    // No subscription at all.
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 1, now)).toBe(
      'no_active_plan',
    );
    // No billing account.
    expect(await wallet.consume(d.workspaceId, 'monthlyComments', 1, now)).toBe(
      'no_active_plan',
    );
    // Unknown workspace.
    expect(
      await wallet.consume(
        '00000000-0000-7000-8000-000000000000',
        'monthlyComments',
        1,
        now,
      ),
    ).toBe('no_active_plan');
    // EXPIRED, then CANCELED (term still running), then ACTIVE with the term over.
    const expired = await active(accountA, 'five', T0, T1, {
      status: 'EXPIRED',
    });
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 1, now)).toBe(
      'no_active_plan',
    );
    await db().delete(subscriptions).where(eq(subscriptions.id, expired));
    const canceled = await active(accountA, 'five', T0, T1, {
      status: 'CANCELED',
      canceledAt: now,
    });
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 1, now)).toBe(
      'no_active_plan',
    );
    await db().delete(subscriptions).where(eq(subscriptions.id, canceled));
    await active(accountA, 'five', T0, T1);
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 1, T1)).toBe(
      'no_active_plan',
    );
    expect(await findLiveSubscription(db(), a.workspaceId, T1)).toBeNull();
    expect(await walletsOf(accountA)).toHaveLength(0);
    expect(await balancesOf(accountA)).toHaveLength(0);
  });

  it('rejects a bad amount before any SQL', async () => {
    for (const n of [0, -1, 1.5, 1001]) {
      await expect(
        wallet.consume(a.workspaceId, 'monthlyComments', n),
      ).rejects.toThrow(RangeError);
      await expect(
        wallet.refund(a.workspaceId, 'monthlyComments', n, T0),
      ).rejects.toThrow(RangeError);
    }
  });

  it('refund gives back to the period containing `at`, floors at 0, stays in the account', async () => {
    await active(accountA, 'five', T0, dhaka('2027-11-19T15:30'), {
      interval: 'year',
      chargedBdt: 499 * 12,
    });
    await active(accountB, 'five', T0, T1);
    const inP1 = dhaka('2026-11-25T12:00');
    const inP2 = dhaka('2026-12-25T12:00');
    await wallet.consume(a.workspaceId, 'monthlyComments', 3, inP1);
    await wallet.consume(c.workspaceId, 'monthlyComments', 1, inP2);
    await wallet.consume(b.workspaceId, 'monthlyComments', 2, inP1);

    // Refund from the pooled workspace c into period 1 (passing the period start works too).
    expect(await wallet.refund(c.workspaceId, 'monthlyComments', 1, T0)).toBe(
      true,
    );
    expect(await wallet.refund(a.workspaceId, 'monthlyComments', 5, inP2)).toBe(
      true,
    );
    expect((await balancesOf(accountA)).map((r) => r.used)).toEqual([2, 0]);
    // No balance for that period / no account → nothing to give back.
    expect(
      await wallet.refund(
        a.workspaceId,
        'monthlyComments',
        1,
        dhaka('2027-03-01T00:00'),
      ),
    ).toBe(false);
    expect(await wallet.refund(d.workspaceId, 'monthlyComments', 1, inP1)).toBe(
      false,
    );
    // Account B untouched.
    expect((await balancesOf(accountB)).map((r) => r.used)).toEqual([2]);
  });

  it('balance / balanceMany: values, resetsAt, pooled workspaces, null without a live plan', async () => {
    await active(accountA, 'five', T0, T1);
    await trial(accountB, 'trial', T0, new Date(T0.getTime() + 7 * DAY));
    const now = dhaka('2026-11-25T12:00');

    // Before the first consume: what the period will grant.
    expect(await wallet.balance(a.workspaceId, 'monthlyComments', now)).toEqual(
      {
        meter: 'monthlyComments',
        included: 5,
        added: 0,
        used: 0,
        available: 5,
        periodStart: T0,
        resetsAt: T1,
      },
    );
    expect(await walletsOf(accountA)).toHaveLength(0);

    await wallet.consume(a.workspaceId, 'monthlyComments', 2, now);
    await wallet.consume(b.workspaceId, 'monthlyComments', 1, now);
    const unknown = '00000000-0000-7000-8000-000000000000';
    const many = await wallet.balanceMany(
      [a.workspaceId, b.workspaceId, c.workspaceId, d.workspaceId, unknown],
      'monthlyComments',
      now,
    );
    expect([...many.keys()]).toEqual([
      a.workspaceId,
      b.workspaceId,
      c.workspaceId,
      d.workspaceId,
      unknown,
    ]);
    const pooled = {
      meter: 'monthlyComments',
      included: 5,
      added: 0,
      used: 2,
      available: 3,
      periodStart: T0,
      resetsAt: T1,
    };
    expect(many.get(a.workspaceId)).toEqual(pooled);
    expect(many.get(c.workspaceId)).toEqual(pooled);
    expect(many.get(b.workspaceId)).toEqual({
      meter: 'monthlyComments',
      included: 3,
      added: 0,
      used: 1,
      available: 2,
      periodStart: T0,
      resetsAt: new Date(T0.getTime() + 7 * DAY),
    });
    expect(many.get(d.workspaceId)).toBeNull();
    expect(many.get(unknown)).toBeNull();
    expect(await wallet.balance(c.workspaceId, 'monthlyComments', now)).toEqual(
      pooled,
    );
    expect(
      await wallet.balance(d.workspaceId, 'monthlyComments', now),
    ).toBeNull();
    expect(
      await wallet.balance(a.workspaceId, 'monthlyComments', T1),
    ).toBeNull();
    expect(await wallet.balanceMany([])).toEqual(new Map());
  });

  it("another account's workspace never touches this wallet", async () => {
    await active(accountA, 'five', T0, T1);
    await active(accountB, 'five', T0, T1);
    const now = dhaka('2026-11-25T12:00');
    await wallet.consume(a.workspaceId, 'monthlyComments', 5, now);
    expect(await wallet.consume(b.workspaceId, 'monthlyComments', 5, now)).toBe(
      'ok',
    );
    expect(await wallet.consume(a.workspaceId, 'monthlyComments', 1, now)).toBe(
      'limit_reached',
    );
    const [wa] = await walletsOf(accountA);
    const [wb] = await walletsOf(accountB);
    expect(wa!.id).not.toBe(wb!.id);
    expect((await balancesOf(accountA))[0]!.used).toBe(5);
    expect((await balancesOf(accountB))[0]!.used).toBe(5);
  });
});

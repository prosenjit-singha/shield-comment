import type { INestApplication } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  dhakaDate,
  dhakaMidnight,
  manualTerm,
} from '../src/admin/manual-activation.js';
import {
  plans,
  subscriptionAuditLogs,
  subscriptions,
  walletBalances,
  walletEntries,
  wallets,
} from '../src/db/schema/index.js';
import { nextReset } from '../src/wallet/wallet-period.js';
import { WalletService } from '../src/wallet/wallet.service.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const CLIENTS = '/api/admin/clients';
const UNKNOWN_ID = '019a0000-0000-7000-8000-00000000dead';
const DAY = 86_400_000;
const UA = 'pw-t9-e2e/1.0';

/** `YYYY-MM-DD` (Dhaka) `days` days before today. */
const daysAgo = (days: number) =>
  dhakaDate(
    new Date(dhakaMidnight(dhakaDate(new Date())).getTime() - days * DAY),
  );

interface ActivationBody {
  subscription: {
    status: string;
    interval: string;
    trialEndsAt: string | null;
    termEndsAt: string;
    plan: { id: string; slug: string; name: string };
  };
  comments: { used: number; limit: number; resetsAt: string | null };
}

/**
 * PW-T9: `POST /api/admin/clients/:workspaceId/subscription` (user decision 2026-11-19 PW-D16 +
 * the confirmed PW-PLAN reading: start date today − 31 … today Dhaka, reason 1–500, the live
 * subscription ends CANCELED and a fresh wallet period starts with `used` 0). Real Postgres.
 */
describe('Admin manual plan activation (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let wallet: WalletService;
  let superAdmin: Actor;
  const planIds: Record<string, string> = {};
  const http = () => actors.http();
  const db = () => actors.db;

  const activate = (
    workspaceId: string,
    body: Record<string, unknown>,
    cookie = superAdmin.cookie,
  ) =>
    http()
      .post(`${CLIENTS}/${workspaceId}/subscription`)
      .set('Cookie', cookie)
      .set('X-Forwarded-For', '203.0.113.7, 10.0.0.2')
      .set('User-Agent', UA)
      .send(body);

  const body = (overrides: Record<string, unknown> = {}) => ({
    planId: planIds.growth,
    interval: 'month',
    startDate: daysAgo(0),
    reason: 'Paid by bKash',
    ...overrides,
  });

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

  const walletOf = async (owner: Actor) => {
    const [row] = await db()
      .select()
      .from(wallets)
      .where(eq(wallets.billingAccountId, await actors.accountIdOf(owner)));
    return row!;
  };

  const balancesOf = async (owner: Actor) =>
    db()
      .select()
      .from(walletBalances)
      .where(eq(walletBalances.walletId, (await walletOf(owner)).id))
      .orderBy(asc(walletBalances.periodStart));

  const entriesOf = async (owner: Actor) =>
    db()
      .select()
      .from(walletEntries)
      .where(eq(walletEntries.walletId, (await walletOf(owner)).id))
      .orderBy(asc(walletEntries.createdAt), asc(walletEntries.id));

  /** Nothing changed: still exactly the sign-up trial, no audit row. */
  async function expectUntouched(owner: Actor) {
    const subs = await subsOf(owner);
    expect(subs.map((s) => s.status)).toEqual(['TRIALING']);
    expect(await auditOf(owner)).toEqual([]);
  }

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    wallet = app.get(WalletService);
    superAdmin = await actors.signUpSuperAdmin('pwt9-super');
    for (const row of await db()
      .select({ id: plans.id, slug: plans.slug })
      .from(plans)) {
      planIds[row.slug] = row.id;
    }
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('activation', () => {
    let owner: Actor;

    beforeAll(async () => {
      owner = await actors.signUp('pwt9-owner');
    });

    it('replaces the sign-up trial with an ACTIVE monthly term (CANCELED trial, snapshots, fresh wallet, audit)', async () => {
      const [trial] = await subsOf(owner);
      // The trial already used some comments: they stay on the trial's period.
      await wallet.consume(owner.workspaceId, 'monthlyComments', 3);
      const before = Date.now();
      const res = await activate(
        owner.workspaceId,
        body({ reason: '  Paid by bKash  ' }),
      );
      const after = Date.now();
      expect(res.status).toBe(201);
      const term = manualTerm(daysAgo(0), 'month');
      expect(res.body as ActivationBody).toEqual({
        subscription: {
          status: 'ACTIVE',
          interval: 'month',
          trialEndsAt: null,
          termEndsAt: term.end.toISOString(),
          plan: { id: planIds.growth, slug: 'growth', name: 'Growth' },
        },
        comments: {
          used: 0,
          limit: 15000,
          resetsAt: term.end.toISOString(),
        },
      });

      const subs = await subsOf(owner);
      expect(subs).toHaveLength(2);
      const [old, active] = subs;
      expect(old).toMatchObject({ id: trial!.id, status: 'CANCELED' });
      expect(old!.canceledAt!.getTime()).toBeGreaterThanOrEqual(before - 1);
      expect(old!.canceledAt!.getTime()).toBeLessThanOrEqual(after);
      expect(old!.trialEndsAt).toEqual(trial!.trialEndsAt);
      expect(active).toMatchObject({
        planId: planIds.growth,
        interval: 'month',
        status: 'ACTIVE',
        startedAt: term.start,
        currentTermStart: term.start,
        currentTermEnd: term.end,
        trialEndsAt: null,
        pricePerMonthBdt: 1499,
        chargedBdt: 1499,
        canceledAt: null,
      });

      // Wallet re-anchored at the term start; the period containing now is fresh.
      expect(await walletOf(owner)).toMatchObject({
        cycleAnchorAt: term.start,
        currentPeriodStart: term.start,
        currentPeriodEnd: term.end,
      });
      const balances = await balancesOf(owner);
      const fresh = balances.find(
        (b) => b.periodStart.getTime() === term.start.getTime(),
      );
      expect(fresh).toMatchObject({
        meter: 'monthlyComments',
        included: 15000,
        added: 0,
        used: 0,
        periodEnd: term.end,
      });
      // The trial's period is closed at the activation instant (its usage kept).
      const trialBalance = balances.find(
        (b) => b.periodStart.getTime() === trial!.startedAt.getTime(),
      );
      expect(trialBalance).toMatchObject({ used: 3, included: 300 });
      expect(trialBalance!.periodEnd.getTime()).toBeLessThanOrEqual(after);
      expect(trialBalance!.periodEnd.getTime()).toBeGreaterThanOrEqual(
        before - 1,
      );

      const grants = (await entriesOf(owner)).filter(
        (e) => e.reference === active!.id,
      );
      expect(grants).toEqual([
        expect.objectContaining({
          kind: 'PLAN_GRANT',
          meter: 'monthlyComments',
          amount: 15000,
          periodStart: term.start,
          actorUserId: superAdmin.id,
        }),
      ]);

      expect(await auditOf(owner)).toEqual([
        expect.objectContaining({
          adminId: superAdmin.id,
          billingAccountId: await actors.accountIdOf(owner),
          workspaceId: owner.workspaceId,
          beforeSubscriptionId: trial!.id,
          beforePlanId: planIds.starter,
          beforeInterval: 'month',
          beforeStatus: 'TRIALING',
          afterSubscriptionId: active!.id,
          afterPlanId: planIds.growth,
          afterInterval: 'month',
          afterStatus: 'ACTIVE',
          reason: 'Paid by bKash',
          ipAddress: '203.0.113.7',
          userAgent: UA,
        }),
      ]);

      // Moderation consumes from the new period.
      expect(await wallet.consume(owner.workspaceId, 'monthlyComments')).toBe(
        'ok',
      );
      expect(await wallet.balance(owner.workspaceId)).toMatchObject({
        used: 1,
        included: 15000,
        periodStart: term.start,
      });
    });

    it('replaces an ACTIVE plan with a yearly one; the same period start still gets a fresh balance (used 0)', async () => {
      const [, growth] = await subsOf(owner);
      const term = manualTerm(daysAgo(0), 'year');
      // Same start date as the Growth term → same period_start: used 42 must not carry over.
      await db()
        .update(walletBalances)
        .set({ used: 42 })
        .where(
          and(
            eq(walletBalances.walletId, (await walletOf(owner)).id),
            eq(walletBalances.periodStart, term.start),
          ),
        );
      const res = await activate(
        owner.workspaceId,
        body({ planId: planIds.pro, interval: 'year', reason: 'Yearly deal' }),
      );
      expect(res.status).toBe(201);
      const monthEnd = manualTerm(daysAgo(0), 'month').end;
      expect(res.body as ActivationBody).toMatchObject({
        subscription: {
          status: 'ACTIVE',
          interval: 'year',
          termEndsAt: term.end.toISOString(),
          plan: { slug: 'pro' },
        },
        comments: { used: 0, limit: 75000, resetsAt: monthEnd.toISOString() },
      });

      const subs = await subsOf(owner);
      expect(subs.map((s) => s.status)).toEqual([
        'CANCELED',
        'CANCELED',
        'ACTIVE',
      ]);
      expect(subs[1]).toMatchObject({ id: growth!.id, status: 'CANCELED' });
      expect(subs[2]).toMatchObject({
        planId: planIds.pro,
        interval: 'year',
        currentTermEnd: term.end,
        pricePerMonthBdt: 3599,
        chargedBdt: 3599 * 12,
      });
      const fresh = (await balancesOf(owner)).filter(
        (b) => b.periodStart.getTime() === term.start.getTime(),
      );
      expect(fresh).toEqual([
        expect.objectContaining({
          used: 0,
          included: 75000,
          periodEnd: monthEnd,
        }),
      ]);
      const grants = (await entriesOf(owner)).filter(
        (e) => e.periodStart.getTime() === term.start.getTime(),
      );
      expect(grants.map((g) => [g.amount, g.actorUserId])).toEqual([
        [15000, superAdmin.id],
        [75000, superAdmin.id],
      ]);
      const audit = await auditOf(owner);
      expect(audit).toHaveLength(2);
      expect(audit[1]).toMatchObject({
        beforeSubscriptionId: growth!.id,
        beforePlanId: planIds.growth,
        beforeInterval: 'month',
        beforeStatus: 'ACTIVE',
        afterSubscriptionId: subs[2]!.id,
        afterPlanId: planIds.pro,
        afterInterval: 'year',
        reason: 'Yearly deal',
      });
    });

    it('the clients list shows the new plan', async () => {
      const res = await http()
        .get(`${CLIENTS}?q=${encodeURIComponent(owner.email)}`)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      const item = (
        res.body as {
          items: {
            id: string;
            plan: { slug: string } | null;
            subscription: { status: string; interval: string } | null;
            comments: { used: number; limit: number } | null;
          }[];
        }
      ).items.find((i) => i.id === owner.workspaceId);
      expect(item).toMatchObject({
        plan: { slug: 'pro' },
        subscription: { status: 'ACTIVE', interval: 'year' },
        comments: { used: 0, limit: 75000 },
      });
    });
  });

  it('a start date 31 days back works for a yearly term (period containing now)', async () => {
    const owner = await actors.signUp('pwt9-back');
    const startDate = daysAgo(31);
    const res = await activate(
      owner.workspaceId,
      body({ interval: 'year', startDate, planId: planIds.starter }),
    );
    expect(res.status).toBe(201);
    const term = manualTerm(startDate, 'year');
    const now = new Date();
    const resetsAt = nextReset(term.start, now);
    expect(res.body as ActivationBody).toMatchObject({
      subscription: { termEndsAt: term.end.toISOString() },
      comments: { used: 0, limit: 2500, resetsAt: resetsAt.toISOString() },
    });
    const [, active] = await subsOf(owner);
    expect(active).toMatchObject({
      startedAt: term.start,
      pricePerMonthBdt: 449,
      chargedBdt: 5388,
    });
    const w = await walletOf(owner);
    expect(w.cycleAnchorAt).toEqual(term.start);
    expect(w.currentPeriodEnd).toEqual(resetsAt);
    expect(w.currentPeriodStart.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it('a stale live subscription past its term is recorded EXPIRED, not CANCELED', async () => {
    const owner = await actors.signUp('pwt9-stale');
    const [trial] = await subsOf(owner);
    const start = new Date(Date.now() - 10 * DAY);
    const end = new Date(Date.now() - 3 * DAY);
    await db()
      .update(subscriptions)
      .set({
        startedAt: start,
        trialEndsAt: end,
        currentTermStart: start,
        currentTermEnd: end,
      })
      .where(eq(subscriptions.id, trial!.id));
    const res = await activate(owner.workspaceId, body());
    expect(res.status).toBe(201);
    const [old, active] = await subsOf(owner);
    expect(old).toMatchObject({ status: 'EXPIRED', canceledAt: null });
    expect(active).toMatchObject({ status: 'ACTIVE' });
    expect(await auditOf(owner)).toEqual([
      expect.objectContaining({ beforeStatus: 'TRIALING' }),
    ]);
  });

  it('an account without any subscription gets one (audit before = null)', async () => {
    const owner = await actors.signUp('pwt9-none');
    const accountId = await actors.accountIdOf(owner);
    const walletIds = db()
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.billingAccountId, accountId));
    await db()
      .delete(walletEntries)
      .where(inArray(walletEntries.walletId, walletIds));
    await db()
      .delete(walletBalances)
      .where(inArray(walletBalances.walletId, walletIds));
    await db().delete(wallets).where(eq(wallets.billingAccountId, accountId));
    await db()
      .delete(subscriptions)
      .where(eq(subscriptions.billingAccountId, accountId));
    const res = await activate(owner.workspaceId, body());
    expect(res.status).toBe(201);
    expect((await subsOf(owner)).map((s) => s.status)).toEqual(['ACTIVE']);
    expect(await auditOf(owner)).toEqual([
      expect.objectContaining({
        beforeSubscriptionId: null,
        beforePlanId: null,
        beforeInterval: null,
        beforeStatus: null,
      }),
    ]);
    expect((await balancesOf(owner)).map((b) => b.used)).toEqual([0]);
  });

  describe('rejections (nothing changes)', () => {
    let owner: Actor;

    beforeAll(async () => {
      owner = await actors.signUp('pwt9-reject');
    });

    afterEach(async () => {
      await expectUntouched(owner);
    });

    it.each([
      ['32 days back', { startDate: daysAgo(32) }],
      ['tomorrow', { startDate: daysAgo(-1) }],
    ])('400 START_DATE_OUT_OF_RANGE for %s', async (_label, override) => {
      const res = await activate(owner.workspaceId, body(override));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'START_DATE_OUT_OF_RANGE' });
    });

    it('400 TERM_ALREADY_ENDED for a monthly term starting 31 days back', async () => {
      const res = await activate(
        owner.workspaceId,
        body({ startDate: daysAgo(31) }),
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'TERM_ALREADY_ENDED' });
    });

    it.each([
      ['bad date format', { startDate: '2026-2-1' }],
      ['impossible date', { startDate: '2026-02-30' }],
      ['empty reason', { reason: '' }],
      ['blank reason', { reason: '    ' }],
      ['501-char reason', { reason: 'x'.repeat(501) }],
      ['bad interval', { interval: 'week' }],
      ['non-uuid plan', { planId: 'growth' }],
      ['unknown field', { extra: 1 }],
    ])('400 validation: %s', async (_label, override) => {
      const res = await activate(owner.workspaceId, body(override));
      expect(res.status).toBe(400);
    });

    it('400 PLAN_NOT_AVAILABLE for the inactive free plan and an unknown plan', async () => {
      for (const planId of [planIds.free, UNKNOWN_ID]) {
        const res = await activate(owner.workspaceId, body({ planId }));
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'PLAN_NOT_AVAILABLE' });
      }
    });

    it('400 YEARLY_PRICE_MISSING for yearly on a plan without a yearly price', async () => {
      const [growth] = await db()
        .select({ yearly: plans.yearlyMonthlyPriceBdt })
        .from(plans)
        .where(eq(plans.id, planIds.growth!));
      await db()
        .update(plans)
        .set({ yearlyMonthlyPriceBdt: null })
        .where(eq(plans.id, planIds.growth!));
      try {
        const res = await activate(
          owner.workspaceId,
          body({ interval: 'year' }),
        );
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'YEARLY_PRICE_MISSING' });
      } finally {
        await db()
          .update(plans)
          .set({ yearlyMonthlyPriceBdt: growth!.yearly })
          .where(eq(plans.id, planIds.growth!));
      }
    });

    it('401 without a session', async () => {
      const res = await http()
        .post(`${CLIENTS}/${owner.workspaceId}/subscription`)
        .send(body());
      expect(res.status).toBe(401);
    });

    it('403 for a normal user (even the workspace owner)', async () => {
      const res = await activate(owner.workspaceId, body(), owner.cookie);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: 'Super admin only' });
    });

    it('403 for impersonated sessions (super admin or client)', async () => {
      const adminCookie = await actors.signIn(superAdmin.email);
      await actors.patchStoredSession(adminCookie, {
        impersonatedBy: superAdmin.id,
      });
      const ownerCookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(ownerCookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      for (const cookie of [adminCookie, ownerCookie]) {
        const res = await activate(owner.workspaceId, body(), cookie);
        expect(res.status).toBe(403);
      }
    });
  });

  it('409 NO_BILLING_ACCOUNT for a workspace without a billing account', async () => {
    const owner = await actors.signUp('pwt9-noacct');
    await actors.removeBilling(owner);
    const res = await activate(owner.workspaceId, body());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'NO_BILLING_ACCOUNT' });
    const rows = await db()
      .select()
      .from(subscriptionAuditLogs)
      .where(eq(subscriptionAuditLogs.workspaceId, owner.workspaceId));
    expect(rows).toEqual([]);
  });

  it.each([
    ['unknown id', UNKNOWN_ID],
    ['malformed id', 'not-a-uuid'],
  ])('404 for an %s', async (_label, id) => {
    const res = await activate(id, body());
    expect(res.status).toBe(404);
  });
});

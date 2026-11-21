import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { BillingSummaryService } from '../src/billing/billing-summary.service.js';
import {
  PENDING_PAYMENT_EXPIRY_JOB_NAME,
  SUBSCRIPTION_EXPIRY_JOB_NAME,
} from '../src/billing/billing-scheduled.jobs.js';
import { BillingProcessor } from '../src/billing/billing.processor.js';
import { RenewalReminderService } from '../src/billing/renewal-reminder.service.js';
import { SubscriptionService } from '../src/billing/subscription.service.js';
import {
  paymentTransactions,
  PLAN_FEATURE_KEYS,
  type PlanFeatureKey,
  plans,
  subscriptionAuditLogs,
  subscriptions,
  walletBalances,
  wallets,
} from '../src/db/schema/index.js';
import { EmailSendError, EmailService } from '../src/email/email.service.js';
import {
  SSLCOMMERZ_CONFIG,
  SSLCOMMERZ_SESSION_PATH,
  SSLCOMMERZ_VALIDATION_PATH,
  type SslcommerzConfig,
} from '../src/payments/sslcommerz.client.js';
import { findLiveSubscription } from '../src/wallet/live-subscription.queries.js';
import { monthlyReset } from '../src/wallet/wallet-period.js';
import { WalletService } from '../src/wallet/wallet.service.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import {
  createEmailServiceFake,
  type FakeEmailService,
} from './utils/fake-email.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BASE = 'https://sslcommerz.fake.test';
const CLIENT = 'http://app.localhost:5174';
const CONFIG: SslcommerzConfig = {
  storeId: 'fakestore',
  storePassword: 'fake-store-password',
  sandbox: true,
  baseUrl: BASE,
};
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
/** An instant given as Asia/Dhaka wall time (UTC+6). */
const dhaka = (wall: string) => new Date(`${wall}+06:00`);

/**
 * M8-T6: renewal reminders (D4), no grace (D5), pending-payment expiry (reading 9) and the M8-D7b
 * scheduled switch. Email + SSLCommerz are strict fakes; real Postgres. Each test uses its own
 * far-future term dates and passes `now`, so the global reminder query only sees its own rows.
 */
describe('Renewals + reminders (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let billing: SubscriptionService;
  let reminders: RenewalReminderService;
  let email: FakeEmailService;
  const db = () => actors.db;
  const http = () => request(app.getHttpServer());
  const tag = `${Date.now()}`.slice(-8);
  const fetchMock = vi.fn<typeof fetch>();
  type PlanRow = typeof plans.$inferSelect;
  let basic: PlanRow;
  let pro: PlanRow;

  const planRow = async (slug: string, monthly: number, comments: number) => {
    const [row] = await db()
      .insert(plans)
      .values({
        slug: `m8t6-${slug}-${tag}`,
        name: `M8T6 ${slug}`,
        sortOrder: 97,
        isActive: true,
        monthlyPriceBdt: monthly,
        yearlyMonthlyPriceBdt: monthly - 100,
        featureConfig: {
          limits: {
            connectedPages: 1,
            monthlyComments: comments,
            teamSeats: 1,
            workspaces: 1,
          },
          features: Object.fromEntries(
            PLAN_FEATURE_KEYS.map((key) => [key, false]),
          ) as Record<PlanFeatureKey, boolean>,
        },
      })
      .returning();
    return row!;
  };

  /** A paid ACTIVE month term `[end − 1 month, end)` on `plan`, written directly. */
  const paidTerm = async (owner: Actor, plan: PlanRow, end: Date) => {
    const start = monthlyReset(end, -1);
    const [row] = await db()
      .insert(subscriptions)
      .values({
        billingAccountId: await actors.accountIdOf(owner),
        planId: plan.id,
        interval: 'month',
        status: 'ACTIVE',
        startedAt: start,
        currentTermStart: start,
        currentTermEnd: end,
        pricePerMonthBdt: plan.monthlyPriceBdt,
        chargedBdt: plan.monthlyPriceBdt,
      })
      .returning();
    return row!;
  };
  const subOf = async (id: string) =>
    (
      await db().select().from(subscriptions).where(eq(subscriptions.id, id))
    )[0]!;
  const subsOf = async (owner: Actor) =>
    db()
      .select()
      .from(subscriptions)
      .where(
        eq(subscriptions.billingAccountId, await actors.accountIdOf(owner)),
      )
      .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));
  const run = (now: Date) => reminders.run(now);
  const outcome = (sent: number, skipped = 0, failed = 0) => ({
    kind: 'renewal_reminders',
    sent,
    skipped,
    failed,
  });

  /** Activates a paid term through the payment path (source PAYMENT, audit row). */
  const pay = async (
    owner: Actor,
    plan: PlanRow,
    kind: 'NEW' | 'RENEWAL',
    now: Date,
  ) => {
    const accountId = await actors.accountIdOf(owner);
    const price = await billing.checkoutPrice(
      accountId,
      plan,
      'month',
      null,
      kind,
      now,
    );
    return db().transaction((tx) =>
      billing.activatePaidTerm(tx, {
        accountId,
        workspaceId: owner.workspaceId,
        planId: plan.id,
        interval: 'month',
        kind,
        start: now,
        price,
        source: 'PAYMENT',
        reason: `Payment m8t6-${kind}`,
        now,
      }),
    );
  };

  beforeAll(async () => {
    email = createEmailServiceFake();
    app = await createTestApp((b) =>
      b
        .overrideProvider(EmailService)
        .useValue(email)
        .overrideProvider(SSLCOMMERZ_CONFIG)
        .useValue(CONFIG),
    );
    actors = createAuthActors(app);
    billing = app.get(SubscriptionService);
    reminders = app.get(RenewalReminderService);
    basic = await planRow('basic', 1000, 50);
    pro = await planRow('pro', 3000, 500);
  });

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => {
      throw new Error('Unexpected fetch in this test');
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    expect(email.unexpected).toEqual([]);
    expect(email.pending).toBe(0);
    email.reset();
  });

  afterAll(async () => {
    await actors?.cleanup();
    const ids = [basic, pro].filter(Boolean).map((p) => p.id);
    if (ids.length) await db().delete(plans).where(inArray(plans.id, ids));
    await app?.close();
  });

  it('D4: 7 / 3 / 1 days before, each once (repeated runs send nothing); a renewed term gets its own; then the expiry email and D5 pause', async () => {
    const owner = await actors.signUp('m8t6-remind');
    const end = dhaka('2031-01-20T00:00:00');
    const sub = await paidTerm(owner, pro, end);

    expect(await run(dhaka('2031-01-12T10:00:00'))).toEqual(outcome(0));
    email.expectSends(1);
    expect(await run(dhaka('2031-01-13T10:00:00'))).toEqual(outcome(1));
    expect(email.sent[0]).toMatchObject({
      to: owner.email,
      subject: expect.stringMatching(
        /^Your ShieldComment plan ends in 7 days · /,
      ),
      idempotencyKey: `renewal-reminder:${sub.id}:${end.toISOString()}:7`,
    });
    expect(email.sent[0]!.text).toContain(`${CLIENT}/billing`);
    expect(await subOf(sub.id)).toMatchObject({
      reminderTermEnd: end,
      reminderDays: 7,
    });
    // Same day again, and the next days of the stage: nothing.
    expect(await run(dhaka('2031-01-13T10:00:00'))).toEqual(outcome(0));
    expect(await run(dhaka('2031-01-15T10:00:00'))).toEqual(outcome(0));

    email.expectSends(1);
    expect(await run(dhaka('2031-01-17T10:00:00'))).toEqual(outcome(1));
    expect(email.sent[1]!.subject).toMatch(/ends in 3 days/);
    expect(await run(dhaka('2031-01-18T10:00:00'))).toEqual(outcome(0));
    email.expectSends(1);
    expect(await run(dhaka('2031-01-19T10:00:00'))).toEqual(outcome(1));
    expect(email.sent[2]!.subject).toMatch(/ends in 1 day · /);
    expect(await run(dhaka('2031-01-19T23:00:00'))).toEqual(outcome(0));

    // Renewed early (the same row moves its end): the new term gets its own reminders.
    const renewedEnd = monthlyReset(end, 1);
    await db()
      .update(subscriptions)
      .set({ currentTermEnd: renewedEnd })
      .where(eq(subscriptions.id, sub.id));
    expect(await run(dhaka('2031-01-20T10:00:00'))).toEqual(outcome(0));
    email.expectSends(1);
    expect(await run(dhaka('2031-02-13T10:00:00'))).toEqual(outcome(1));
    expect(email.sent[3]!.idempotencyKey).toBe(
      `renewal-reminder:${sub.id}:${renewedEnd.toISOString()}:7`,
    );

    // The term ends unpaid (D5, no grace): one expiry email, moderation paused, nothing deleted.
    const after = new Date(renewedEnd.getTime() + HOUR);
    expect(
      await findLiveSubscription(db(), owner.workspaceId, after),
    ).toBeNull();
    expect(
      await app
        .get(WalletService)
        .consume(owner.workspaceId, 'monthlyComments', 1, after),
    ).toBe('no_active_plan');
    email.expectSends(1);
    expect(await run(after)).toEqual(outcome(1));
    expect(email.sent[4]).toMatchObject({
      to: owner.email,
      subject:
        'Your ShieldComment plan has ended · আপনার ShieldComment প্ল্যান শেষ হয়েছে',
    });
    expect(await run(new Date(after.getTime() + DAY))).toEqual(outcome(0));
    // Expired by the job: still no second expiry email.
    await billing.expireDue(after);
    expect((await subOf(sub.id)).status).toBe('EXPIRED');
    expect(await run(new Date(after.getTime() + 2 * DAY))).toEqual(outcome(0));
  });

  it('no expiry email when another plan is live after the term; trials get no reminders', async () => {
    const owner = await actors.signUp('m8t6-followed');
    const end = dhaka('2032-03-10T00:00:00');
    const old = await paidTerm(owner, basic, end);
    await db()
      .update(subscriptions)
      .set({ status: 'EXPIRED' })
      .where(eq(subscriptions.id, old.id));
    await paidTerm(owner, pro, monthlyReset(end, 1));
    expect(await run(new Date(end.getTime() + HOUR))).toEqual(outcome(0));

    const trial = await actors.signUp('m8t6-trial');
    await db()
      .insert(subscriptions)
      .values({
        billingAccountId: await actors.accountIdOf(trial),
        planId: basic.id,
        interval: 'month',
        status: 'TRIALING',
        startedAt: dhaka('2032-05-01T00:00:00'),
        currentTermStart: dhaka('2032-05-01T00:00:00'),
        trialEndsAt: dhaka('2032-05-08T00:00:00'),
        currentTermEnd: dhaka('2032-05-08T00:00:00'),
      });
    expect(await run(dhaka('2032-05-07T10:00:00'))).toEqual(outcome(0));
    expect(await run(dhaka('2032-05-08T10:00:00'))).toEqual(outcome(0));
  });

  it('email unset → skipped (marker not kept, job ok); a retryable send error fails the job and the retry sends once', async () => {
    const owner = await actors.signUp('m8t6-unset');
    const end = dhaka('2033-06-10T00:00:00');
    const sub = await paidTerm(owner, pro, end);
    const now = dhaka('2033-06-03T10:00:00');

    // Dev / test without Resend: `send` resolves not_configured.
    email.send.mockResolvedValueOnce({
      delivered: false,
      reason: 'not_configured',
    });
    expect(await run(now)).toEqual(outcome(0, 1));
    expect(await subOf(sub.id)).toMatchObject({
      reminderTermEnd: null,
      reminderDays: null,
    });

    email.failNext(new EmailSendError('Resend 503', 503, true));
    await expect(run(now)).rejects.toThrow(
      'renewal-reminders: 1 emails failed',
    );
    expect((await subOf(sub.id)).reminderDays).toBeNull();
    email.expectSends(1);
    expect(await run(now)).toEqual(outcome(1));
    expect(await run(now)).toEqual(outcome(0));
  });

  it('M8-D7b: no reminders for a term whose next term is paid; at the end the live plan is the scheduled term with no gap, the switch writes it (EXPIRED + ACTIVE, wallet, audit PAYMENT) once', async () => {
    const owner = await actors.signUp('m8t6-switch');
    const accountId = await actors.accountIdOf(owner);
    const start = dhaka('2034-01-05T09:30:00');
    const first = await pay(owner, pro, 'NEW', start);
    const end = first.term.end;
    expect(end).toEqual(dhaka('2034-02-05T09:30:00'));
    await pay(owner, basic, 'RENEWAL', new Date(end.getTime() - 3 * DAY));
    const [live] = await subsOf(owner);
    expect(live).toMatchObject({ planId: pro.id, scheduledPlanId: basic.id });

    // Paid next term: no "renew" reminders, no expiry email.
    expect(await run(new Date(end.getTime() - 2 * DAY))).toEqual(outcome(0));

    const summary = app.get(BillingSummaryService);
    const before = await summary.summary(
      owner.workspaceId,
      new Date(end.getTime() - DAY),
    );
    expect(before).toMatchObject({
      plan: { name: pro.name },
      renewal: { dueAt: end, canRenew: false },
      scheduled: {
        planId: basic.id,
        planName: basic.name,
        interval: 'month',
        startsAt: end,
      },
      pendingPayment: null,
    });

    // Before the switch job: the scheduled term is already the live plan at the end.
    const newEnd = monthlyReset(end, 1);
    expect(
      await findLiveSubscription(
        db(),
        owner.workspaceId,
        new Date(end.getTime() - 1),
      ),
    ).toMatchObject({ plan: { id: pro.id }, currentTermEnd: end });
    expect(
      await findLiveSubscription(db(), owner.workspaceId, end),
    ).toMatchObject({
      status: 'ACTIVE',
      subscriptionId: live!.id,
      plan: { id: basic.id },
      interval: 'month',
      currentTermStart: end,
      currentTermEnd: newEnd,
    });
    const inWindow = new Date(end.getTime() + 60_000);
    expect(
      await app
        .get(WalletService)
        .consume(owner.workspaceId, 'monthlyComments', 1, inWindow),
    ).toBe('ok');
    const during = await summary.summary(owner.workspaceId, inWindow);
    expect(during).toMatchObject({
      status: 'ACTIVE',
      comments: { used: 1, limit: 50 },
      renewal: { dueAt: newEnd, canRenew: false },
      scheduled: null,
      autoRenew: { available: false, enabled: false, tokenSaved: false },
    });

    // The switch (scoped to this account; the job runs it every 15 min).
    const switchAt = new Date(end.getTime() + 5 * 60_000);
    await billing.expireDue(switchAt);
    expect((await subOf(live!.id)).status).toBe('ACTIVE'); // left to the switch
    expect(await billing.switchScheduled(switchAt, { accountId })).toBe(1);
    expect(await billing.switchScheduled(switchAt, { accountId })).toBe(0);
    const [old, next] = await subsOf(owner);
    expect(old).toMatchObject({ id: live!.id, status: 'EXPIRED' });
    expect(next).toMatchObject({
      status: 'ACTIVE',
      planId: basic.id,
      interval: 'month',
      startedAt: end,
      currentTermStart: end,
      currentTermEnd: newEnd,
      pricePerMonthBdt: 1000,
      chargedBdt: 1000,
      promotionRedemptionId: null,
      couponRedemptionId: null,
      scheduledPlanId: null,
    });
    expect(
      await findLiveSubscription(db(), owner.workspaceId, switchAt),
    ).toMatchObject({ subscriptionId: next!.id, plan: { id: basic.id } });
    const [wallet] = await db()
      .select({ id: wallets.id, anchor: wallets.cycleAnchorAt })
      .from(wallets)
      .where(eq(wallets.billingAccountId, accountId));
    expect(wallet!.anchor).toEqual(end);
    const [balance] = await db()
      .select()
      .from(walletBalances)
      .where(eq(walletBalances.walletId, wallet!.id))
      .orderBy(desc(walletBalances.periodStart))
      .limit(1);
    // The period the reader opened after the end is the new term's: its use is kept.
    expect(balance).toMatchObject({ periodStart: end, included: 50, used: 1 });
    const [audit] = await db()
      .select()
      .from(subscriptionAuditLogs)
      .where(eq(subscriptionAuditLogs.billingAccountId, accountId))
      .orderBy(desc(subscriptionAuditLogs.createdAt))
      .limit(1);
    expect(audit).toMatchObject({
      source: 'PAYMENT',
      adminId: null,
      workspaceId: owner.workspaceId,
      beforeSubscriptionId: live!.id,
      beforePlanId: pro.id,
      afterSubscriptionId: next!.id,
      afterPlanId: basic.id,
      afterStatus: 'ACTIVE',
      price: { chargedBdt: 1000 },
    });
  });

  it('the subscription-expiry job switches a due scheduled term (fresh wallet period) before expiring', async () => {
    const owner = await actors.signUp('m8t6-job');
    const accountId = await actors.accountIdOf(owner);
    const start = new Date(Date.now() - 29 * DAY);
    const first = await pay(owner, pro, 'NEW', start);
    await pay(owner, basic, 'RENEWAL', new Date(start.getTime() + 25 * DAY));
    // Move the term so it ended an hour ago (anchor kept on its billing day).
    const end = new Date(Date.now() - HOUR);
    await db()
      .update(subscriptions)
      .set({ currentTermStart: monthlyReset(end, -1), currentTermEnd: end })
      .where(eq(subscriptions.id, first.subscriptionId));
    const result = await app.get(BillingProcessor).process({
      id: 'repeat:subscription-expiry-15min:1',
      name: SUBSCRIPTION_EXPIRY_JOB_NAME,
      data: {},
    } as never);
    expect(result).toMatchObject({ kind: 'subscription_expiry' });
    expect((result as { switched: number }).switched).toBeGreaterThanOrEqual(1);
    const [, next] = await subsOf(owner);
    expect(next).toMatchObject({
      status: 'ACTIVE',
      planId: basic.id,
      currentTermStart: end,
    });
    const [balance] = await db()
      .select({
        periodStart: walletBalances.periodStart,
        used: walletBalances.used,
        included: walletBalances.included,
      })
      .from(walletBalances)
      .innerJoin(wallets, eq(wallets.id, walletBalances.walletId))
      .where(eq(wallets.billingAccountId, accountId))
      .orderBy(desc(walletBalances.periodStart))
      .limit(1);
    expect(balance).toEqual({ periodStart: end, used: 0, included: 50 });
  });

  describe('pending payments (reading 9)', () => {
    const checkout = async (owner: Actor) => {
      fetchMock.mockImplementationOnce(async (url) => {
        expect(url).toBe(`${BASE}${SSLCOMMERZ_SESSION_PATH}`);
        return Response.json({
          status: 'SUCCESS',
          GatewayPageURL: `${BASE}/pay`,
          sessionkey: 'S',
        });
      });
      const res = await http()
        .post(`/api/workspaces/${owner.workspaceId}/billing/checkout`)
        .set('Cookie', owner.cookie)
        .send({ planId: basic.id, interval: 'month' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.tranId as string;
    };
    const txOf = async (tranId: string) =>
      (
        await db()
          .select()
          .from(paymentTransactions)
          .where(eq(paymentTransactions.tranId, tranId))
      )[0]!;
    const signed = (fields: Record<string, string>) => {
      const all: Record<string, string> = {
        ...fields,
        store_passwd: md5(CONFIG.storePassword),
      };
      const hash = Object.keys(all)
        .sort()
        .map((key) => `${key}=${all[key]}`)
        .join('&');
      return {
        ...fields,
        verify_key: Object.keys(fields).join(','),
        verify_sign: md5(hash),
      };
    };

    it('PENDING > 60 min → CANCELLED by the job, a newer one untouched (summary shows it); a late valid IPN still pays the cancelled one', async () => {
      const owner = await actors.signUp('m8t6-pending');
      const old = await checkout(owner);
      const fresh = await checkout(owner);
      await db()
        .update(paymentTransactions)
        .set({ createdAt: new Date(Date.now() - 61 * 60_000) })
        .where(eq(paymentTransactions.tranId, old));
      await db()
        .update(paymentTransactions)
        .set({ createdAt: new Date(Date.now() - 59 * 60_000) })
        .where(eq(paymentTransactions.tranId, fresh));

      const result = await app.get(BillingProcessor).process({
        id: 'repeat:pending-payment-expiry-15min:1',
        name: PENDING_PAYMENT_EXPIRY_JOB_NAME,
        data: {},
      } as never);
      expect(result).toMatchObject({ kind: 'pending_payment_expiry' });
      expect((await txOf(old)).status).toBe('CANCELLED');
      const freshRow = await txOf(fresh);
      expect(freshRow.status).toBe('PENDING');

      const res = await http()
        .get(`/api/workspaces/${owner.workspaceId}/billing/summary`)
        .set('Cookie', owner.cookie)
        .expect(200);
      expect(res.body).toMatchObject({
        renewal: null,
        scheduled: null,
        autoRenew: { available: false, enabled: false, tokenSaved: false },
        pendingPayment: {
          tranId: fresh,
          amountBdt: 1000,
          createdAt: freshRow.createdAt.toISOString(),
        },
      });

      // Reading 9: money received wins.
      fetchMock.mockImplementationOnce(async (url) => {
        const u = new URL(url as string | URL);
        expect(`${u.origin}${u.pathname}`).toBe(
          `${BASE}${SSLCOMMERZ_VALIDATION_PATH}`,
        );
        return Response.json({
          status: 'VALID',
          tran_id: old,
          val_id: `VAL-${old}`,
          amount: '1000.00',
          currency_type: 'BDT',
          currency_amount: '1000.00',
          bank_tran_id: `BANK-${old}`,
          card_type: 'BKASH-BKash',
          risk_level: '0',
        });
      });
      await http()
        .post('/api/billing/sslcommerz/ipn')
        .type('form')
        .send(
          signed({
            status: 'VALID',
            tran_id: old,
            val_id: `VAL-${old}`,
            amount: '1000.00',
            currency: 'BDT',
            card_type: 'BKASH-BKash',
          }),
        )
        .expect(200);
      expect((await txOf(old)).status).toBe('PAID');
      const [sub] = await subsOf(owner);
      expect(sub).toMatchObject({ status: 'ACTIVE', planId: basic.id });
    });
  });
});

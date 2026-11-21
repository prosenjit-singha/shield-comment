import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { asc, desc, eq, inArray, like } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { SubscriptionService } from '../src/billing/subscription.service.js';
import {
  paymentEvents,
  paymentTransactions,
  PLAN_FEATURE_KEYS,
  type PlanFeatureKey,
  plans,
  promotionPlans,
  promotionRedemptions,
  promotions,
  subscriptions,
  walletBalances,
  wallets,
} from '../src/db/schema/index.js';
import {
  SSLCOMMERZ_CONFIG,
  SSLCOMMERZ_SESSION_PATH,
  SSLCOMMERZ_VALIDATION_PATH,
  type SslcommerzConfig,
} from '../src/payments/sslcommerz.client.js';
import { monthlyReset } from '../src/wallet/wallet-period.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const DAY = 86_400_000;
const BASE = 'https://sslcommerz.fake.test';
const CLIENT = 'http://app.localhost:5174';
const CONFIG: SslcommerzConfig = {
  storeId: 'fakestore',
  storePassword: 'fake-store-password',
  sandbox: true,
  baseUrl: BASE,
};
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

/**
 * M8-T5: SSLCommerz IPN + success / fail / cancel returns (readings 3, 4, 6, 9; D10; M8-D7b) and
 * `GET …/billing/payments/:tranId` (D2). SSLCommerz = a fake `fetch` that fails on any unexpected
 * request; real Postgres. Callbacks never send a session cookie.
 */
describe('SSLCommerz callbacks (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let billing: SubscriptionService;
  let superAdmin: Actor;
  const db = () => actors.db;
  const http = () => request(app.getHttpServer());
  const tag = `${Date.now()}`.slice(-8);
  const unknownTranId = `UNKNOWN-${tag}`;
  const fetchMock = vi.fn<typeof fetch>();
  type PlanRow = typeof plans.$inferSelect;
  let basic: PlanRow;
  let pro: PlanRow;

  const planRow = async (slug: string, monthly: number, yearly: number) => {
    const [row] = await db()
      .insert(plans)
      .values({
        slug: `m8t5-${slug}-${tag}`,
        name: `M8T5 ${slug}`,
        sortOrder: 96,
        isActive: true,
        monthlyPriceBdt: monthly,
        yearlyMonthlyPriceBdt: yearly,
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
    return row!;
  };

  const coupon = async (code: string) => {
    const [p] = await db()
      .insert(promotions)
      .values({
        kind: 'COUPON',
        name: `M8-T5 ${code}`,
        code: `${code}-${tag}`,
        discountType: 'FLAT',
        discountValue: 100,
        discountScope: 'TOTAL',
        createdBy: superAdmin.id,
      })
      .returning({ id: promotions.id, code: promotions.code });
    await db()
      .insert(promotionPlans)
      .values([basic, pro].map((t) => ({ promotionId: p!.id, planId: t.id })));
    return { id: p!.id, code: p!.code! };
  };

  /** Real checkout (fake session API) → the PENDING row's tran id. */
  const checkout = async (
    owner: Actor,
    plan: PlanRow,
    interval: 'month' | 'year',
    couponCode?: string,
  ) => {
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
      .send({ planId: plan.id, interval, couponCode });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.tranId as string;
  };

  /** A callback form as SSLCommerz signs it (md5 over verify_key fields + md5(store password)). */
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
  const paidForm = (tranId: string, amount: number, valId = `VAL-${tranId}`) =>
    signed({
      status: 'VALID',
      tran_id: tranId,
      val_id: valId,
      amount: `${amount}.00`,
      currency: 'BDT',
      card_type: 'BKASH-BKash',
    });

  /** The fake Order Validation API: one GET for `valId`, answered VALID with `answer` on top. */
  const expectValidation = (
    tranId: string,
    amount: number,
    answer: Record<string, string> = {},
  ) =>
    fetchMock.mockImplementationOnce(async (url, init) => {
      const u = new URL(url as string | URL);
      expect(`${u.origin}${u.pathname}`).toBe(
        `${BASE}${SSLCOMMERZ_VALIDATION_PATH}`,
      );
      expect(u.searchParams.get('val_id')).toBe(`VAL-${tranId}`);
      expect(init?.method).toBe('GET');
      return Response.json({
        status: 'VALID',
        tran_id: tranId,
        val_id: `VAL-${tranId}`,
        amount: `${amount}.00`,
        currency_type: 'BDT',
        currency_amount: `${amount}.00`,
        bank_tran_id: `BANK-${tranId}`,
        card_type: 'BKASH-BKash',
        risk_level: '0',
        ...answer,
      });
    });

  /** No cookie: SSLCommerz / the payer's cross-site POST (reading 4). */
  const callback = (route: string, form: Record<string, string>) =>
    http().post(`/api/billing/sslcommerz/${route}`).type('form').send(form);

  const txOf = async (tranId: string) => {
    const [row] = await db()
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.tranId, tranId));
    return row!;
  };
  const eventsOf = async (tranId: string) =>
    (
      await db()
        .select({
          source: paymentEvents.source,
          outcome: paymentEvents.outcome,
        })
        .from(paymentEvents)
        .where(eq(paymentEvents.tranId, tranId))
        .orderBy(asc(paymentEvents.receivedAt), asc(paymentEvents.id))
    ).map((e) => `${e.source}:${e.outcome}`);
  const subsOf = async (owner: Actor) =>
    db()
      .select()
      .from(subscriptions)
      .where(
        eq(subscriptions.billingAccountId, await actors.accountIdOf(owner)),
      )
      .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(SSLCOMMERZ_CONFIG).useValue(CONFIG),
    );
    actors = createAuthActors(app);
    billing = app.get(SubscriptionService);
    superAdmin = await actors.signUpSuperAdmin('m8t5-super');
    basic = await planRow('basic', 1000, 900);
    pro = await planRow('pro', 3000, 2700);
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
  });

  afterAll(async () => {
    await db()
      ?.delete(paymentEvents)
      .where(like(paymentEvents.tranId, `UNKNOWN-${tag}%`));
    await actors?.cleanup();
    const ids = [basic, pro].filter(Boolean).map((p) => p.id);
    if (ids.length) await db().delete(plans).where(inArray(plans.id, ids));
    await app?.close();
  });

  it('trial → paid monthly via IPN (D6): PAID row = invoice, ACTIVE term, fresh wallet period; the success return then only redirects', async () => {
    const owner = await actors.signUp('m8t5-month', { trial: true });
    const tranId = await checkout(owner, basic, 'month');
    expectValidation(tranId, 1000);
    const ipn = await callback('ipn', paidForm(tranId, 1000));
    expect(ipn.status, JSON.stringify(ipn.body)).toBe(200);
    expect(ipn.body).toEqual({ received: true });

    const row = await txOf(tranId);
    const [trial, paid] = await subsOf(owner);
    expect(row).toMatchObject({
      status: 'PAID',
      valId: `VAL-${tranId}`,
      bankTranId: `BANK-${tranId}`,
      cardType: 'BKASH-BKash',
      riskLevel: 0,
      subscriptionId: paid!.id,
      invoiceNumber: expect.stringMatching(/^SC-\d{4}-\d{5,}$/),
      price: { chargedBdt: 1000, creditBdt: 0, discount: null, coupon: null },
    });
    expect(trial!.status).toBe('CANCELED');
    expect(paid).toMatchObject({
      status: 'ACTIVE',
      planId: basic.id,
      interval: 'month',
      currentTermStart: row.paidAt,
      currentTermEnd: monthlyReset(row.paidAt!, 1),
      chargedBdt: 1000,
    });
    const [wallet] = await db()
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.billingAccountId, row.billingAccountId));
    const [balance] = await db()
      .select()
      .from(walletBalances)
      .where(eq(walletBalances.walletId, wallet!.id))
      .orderBy(desc(walletBalances.periodStart))
      .limit(1);
    expect(balance).toMatchObject({
      meter: 'monthlyComments',
      periodStart: row.paidAt,
      used: 0,
      included: 100,
    });

    // The success return: no validator call, no second activation.
    const back = await callback('success', paidForm(tranId, 1000));
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe(
      `${CLIENT}/billing?payment=success&tranId=${tranId}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2); // session + one validation
    expect(await subsOf(owner)).toHaveLength(2);
    expect(await eventsOf(tranId)).toEqual([
      'IPN:PAID',
      'SUCCESS:ALREADY_PAID',
    ]);
  });

  it('yearly: the success return can be first (same validation), the IPN after it only acks', async () => {
    const owner = await actors.signUp('m8t5-year');
    const tranId = await checkout(owner, basic, 'year');
    expectValidation(tranId, 10800);
    const back = await callback('success', paidForm(tranId, 10800));
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe(
      `${CLIENT}/billing?payment=success&tranId=${tranId}`,
    );
    const row = await txOf(tranId);
    expect(row.status).toBe('PAID');
    const [sub] = await subsOf(owner);
    expect(sub).toMatchObject({
      status: 'ACTIVE',
      interval: 'year',
      currentTermEnd: monthlyReset(row.paidAt!, 12),
      chargedBdt: 10800,
    });
    await callback('ipn', paidForm(tranId, 10800)).expect(200);
    expect(await eventsOf(tranId)).toEqual([
      'SUCCESS:PAID',
      'IPN:ALREADY_PAID',
    ]);
  });

  it('bad verify_sign, unknown tran id, tampered amount, wrong currency, validator INVALID → not paid, event logged, IPN 200', async () => {
    const owner = await actors.signUp('m8t5-bad');
    const tranId = await checkout(owner, basic, 'month');

    // Signature: checked before anything else, no validator call.
    const forged = { ...paidForm(tranId, 1000), amount: '1.00' };
    await callback('ipn', forged).expect(200);
    const noSign = { tran_id: tranId, val_id: 'X' };
    await callback('ipn', noSign).expect(200);
    await callback('ipn', paidForm(unknownTranId, 1000)).expect(200);

    // Validator answers that don't match the row (reading 3).
    expectValidation(tranId, 1); // tampered amount
    await callback('ipn', paidForm(tranId, 1000)).expect(200);
    expectValidation(tranId, 1000, { currency_type: 'USD' });
    await callback('ipn', paidForm(tranId, 1000)).expect(200);
    expectValidation(tranId, 1000, { tran_id: unknownTranId });
    await callback('ipn', paidForm(tranId, 1000)).expect(200);
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ status: 'INVALID_TRANSACTION' }),
    );
    const invalid = await callback('success', paidForm(tranId, 1000));
    expect(invalid.status).toBe(303);
    expect(invalid.headers.location).toBe(
      `${CLIENT}/billing?payment=failed&tranId=${tranId}`,
    );

    expect(fetchMock).toHaveBeenCalledTimes(5); // session + 4 validations
    expect(await txOf(tranId)).toMatchObject({
      status: 'PENDING',
      paidAt: null,
      invoiceNumber: null,
    });
    expect(await subsOf(owner)).toEqual([]);
    expect(await eventsOf(tranId)).toEqual([
      'IPN:BAD_SIGNATURE',
      'IPN:BAD_SIGNATURE',
      'IPN:AMOUNT_MISMATCH',
      'IPN:CURRENCY_MISMATCH',
      'IPN:TRAN_ID_MISMATCH',
      'SUCCESS:INVALID',
    ]);
    expect(await eventsOf(unknownTranId)).toEqual(['IPN:UNKNOWN_TRAN_ID']);
  });

  it('validator unreachable → IPN 503 (SSLCommerz retries), success return → pending; the retry then pays', async () => {
    const owner = await actors.signUp('m8t5-retry');
    const tranId = await checkout(owner, basic, 'month');
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });
    await callback('ipn', paidForm(tranId, 1000)).expect(503);
    fetchMock.mockImplementationOnce(
      async () => new Response('', { status: 500 }),
    );
    const back = await callback('success', paidForm(tranId, 1000));
    expect(back.headers.location).toBe(
      `${CLIENT}/billing?payment=pending&tranId=${tranId}`,
    );
    expect((await txOf(tranId)).status).toBe('PENDING');
    expectValidation(tranId, 1000);
    await callback('ipn', paidForm(tranId, 1000)).expect(200);
    expect((await txOf(tranId)).status).toBe('PAID');
    expect(await eventsOf(tranId)).toEqual([
      'IPN:VALIDATION_ERROR',
      'SUCCESS:VALIDATION_ERROR',
      'IPN:PAID',
    ]);
  });

  it('duplicate IPN + success return at the same time → one activation, one invoice', async () => {
    const owner = await actors.signUp('m8t5-race', { trial: true });
    const tranId = await checkout(owner, basic, 'month');
    expectValidation(tranId, 1000);
    expectValidation(tranId, 1000);
    expectValidation(tranId, 1000);
    const [a, b, c] = await Promise.all([
      callback('ipn', paidForm(tranId, 1000)),
      callback('ipn', paidForm(tranId, 1000)),
      callback('success', paidForm(tranId, 1000)),
    ]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 303]);
    expect(c.headers.location).toContain('payment=success');
    const subs = await subsOf(owner);
    expect(subs.map((s) => s.status)).toEqual(['CANCELED', 'ACTIVE']);
    expect((await txOf(tranId)).subscriptionId).toBe(subs[1]!.id);
    const events = await eventsOf(tranId);
    expect(events.filter((e) => e.endsWith(':PAID'))).toHaveLength(1);
    expect(events.filter((e) => e.endsWith(':ALREADY_PAID'))).toHaveLength(2);
  });

  it('fail / cancel returns: PENDING → FAILED / CANCELLED + 303; a later fail leaves the row alone', async () => {
    const owner = await actors.signUp('m8t5-fail');
    const failed = await checkout(owner, basic, 'month');
    const res = await callback('fail', { tran_id: failed, status: 'FAILED' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(
      `${CLIENT}/billing?payment=failed&tranId=${failed}`,
    );
    expect((await txOf(failed)).status).toBe('FAILED');

    const cancelled = await checkout(owner, basic, 'month');
    const back = await callback('cancel', { tran_id: cancelled });
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe(
      `${CLIENT}/billing?payment=cancelled&tranId=${cancelled}`,
    );
    expect((await txOf(cancelled)).status).toBe('CANCELLED');
    await callback('fail', { tran_id: cancelled }).expect(303);
    expect((await txOf(cancelled)).status).toBe('CANCELLED');
    await callback('cancel', { tran_id: unknownTranId }).expect(303);

    expect(await eventsOf(failed)).toEqual(['FAIL:FAILED']);
    expect(await eventsOf(cancelled)).toEqual([
      'CANCEL:CANCELLED',
      'FAIL:NOT_PENDING',
    ]);
    expect(await eventsOf(unknownTranId)).toContain('CANCEL:UNKNOWN_TRAN_ID');
  });

  it('reading 9: a late valid IPN on a CANCELLED row still pays and activates', async () => {
    const owner = await actors.signUp('m8t5-late');
    const tranId = await checkout(owner, basic, 'month');
    await callback('cancel', { tran_id: tranId }).expect(303);
    expectValidation(tranId, 1000);
    await callback('ipn', paidForm(tranId, 1000)).expect(200);
    expect((await txOf(tranId)).status).toBe('PAID');
    expect((await subsOf(owner)).map((s) => s.status)).toEqual(['ACTIVE']);
  });

  it('reading 6: a coupon stopped after checkout still pays at the paid price and is claimed; a second payment with it extends the term (NEW → RENEWAL) and logs PAID_DUPLICATE_CLAIM', async () => {
    const owner = await actors.signUp('m8t5-coupon');
    const promo = await coupon('LATE100');
    const first = await checkout(owner, basic, 'month', promo.code);
    const second = await checkout(owner, basic, 'month', promo.code);
    await db()
      .update(promotions)
      .set({ stoppedAt: new Date(), stoppedBy: superAdmin.id })
      .where(eq(promotions.id, promo.id));

    expectValidation(first, 900);
    await callback('ipn', paidForm(first, 900)).expect(200);
    const [redemption] = await db()
      .select()
      .from(promotionRedemptions)
      .where(eq(promotionRedemptions.promotionId, promo.id));
    expect(redemption).toMatchObject({
      billingAccountId: await actors.accountIdOf(owner),
      monthsUsed: 1,
    });
    const paid = await txOf(first);
    expect(paid).toMatchObject({
      status: 'PAID',
      amountBdt: 900,
      price: {
        chargedBdt: 900,
        coupon: { code: promo.code, redemptionId: redemption!.id },
      },
    });
    const [sub] = await subsOf(owner);
    expect(sub).toMatchObject({
      status: 'ACTIVE',
      chargedBdt: 900,
      couponRedemptionId: redemption!.id,
    });

    expectValidation(second, 900);
    await callback('ipn', paidForm(second, 900)).expect(200);
    expect(await eventsOf(second)).toEqual(['IPN:PAID_DUPLICATE_CLAIM']);
    const subs = await subsOf(owner);
    expect(subs).toHaveLength(1); // extended, not replaced
    expect(subs[0]!.currentTermEnd).toEqual(
      monthlyReset(sub!.currentTermStart, 2),
    );
    expect(await txOf(second)).toMatchObject({
      status: 'PAID',
      subscriptionId: sub!.id,
      price: { coupon: { redemptionId: redemption!.id } },
    });
    const [after] = await db()
      .select({ monthsUsed: promotionRedemptions.monthsUsed })
      .from(promotionRedemptions)
      .where(eq(promotionRedemptions.id, redemption!.id));
    expect(after!.monthsUsed).toBe(2);
  });

  it('M8-D7b: a validated RENEWAL to a lower plan inside the window is stored as scheduled', async () => {
    const owner = await actors.signUp('m8t5-sched');
    const accountId = await actors.accountIdOf(owner);
    const start = new Date(Date.now() - 26 * DAY);
    const price = await billing.checkoutPrice(
      accountId,
      pro,
      'month',
      null,
      'NEW',
      start,
    );
    await db().transaction((tx) =>
      billing.activatePaidTerm(tx, {
        accountId,
        workspaceId: owner.workspaceId,
        planId: pro.id,
        interval: 'month',
        kind: 'NEW',
        start,
        price,
        source: 'PAYMENT',
        reason: 'Payment m8t5-setup',
        now: start,
      }),
    );
    const tranId = await checkout(owner, basic, 'month');
    expect((await txOf(tranId)).kind).toBe('RENEWAL');
    expectValidation(tranId, 1000);
    await callback('ipn', paidForm(tranId, 1000)).expect(200);
    const [live] = await subsOf(owner);
    expect(live).toMatchObject({
      status: 'ACTIVE',
      planId: pro.id,
      scheduledPlanId: basic.id,
      scheduledInterval: 'month',
      scheduledPrice: { chargedBdt: 1000 },
    });
    expect(await txOf(tranId)).toMatchObject({
      status: 'PAID',
      subscriptionId: live!.id,
    });
  });

  it('D10: risk_level 1 activates anyway and the row keeps it', async () => {
    const owner = await actors.signUp('m8t5-risk');
    const tranId = await checkout(owner, basic, 'month');
    expectValidation(tranId, 1000, { risk_level: '1' });
    await callback('ipn', paidForm(tranId, 1000)).expect(200);
    expect(await txOf(tranId)).toMatchObject({ status: 'PAID', riskLevel: 1 });
    expect((await subsOf(owner)).map((s) => s.status)).toEqual(['ACTIVE']);
  });

  it('GET …/billing/payments/:tranId: owner + admin + impersonated read, moderator 403, another account 404', async () => {
    const owner = await actors.signUp('m8t5-status');
    const tranId = await checkout(owner, basic, 'month');
    const get = (cookie: string, workspaceId = owner.workspaceId) =>
      http()
        .get(`/api/workspaces/${workspaceId}/billing/payments/${tranId}`)
        .set('Cookie', cookie);

    const res = await get(owner.cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toEqual({
      tranId,
      status: 'PENDING',
      amountBdt: 1000,
      kind: 'NEW',
      planId: basic.id,
      interval: 'month',
      paidAt: null,
      invoiceNumber: null,
    });

    const wsAdmin = await actors.signUp('m8t5-admin');
    const moderator = await actors.signUp('m8t5-mod');
    await actors.addMember(owner.workspaceId, wsAdmin.id, 'admin');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    expect((await get(wsAdmin.cookie)).status).toBe(200);
    expect((await get(moderator.cookie)).status).toBe(403);

    const impersonated = await actors.signIn(owner.email);
    await actors.patchStoredSession(impersonated, {
      impersonatedBy: superAdmin.id,
      activeOrganizationId: owner.workspaceId,
    });
    expect((await get(impersonated)).status).toBe(200);

    const other = await actors.signUp('m8t5-other');
    expect((await get(other.cookie, other.workspaceId)).status).toBe(404);
    expect((await get(owner.cookie)).status).toBe(200);
    await http()
      .get(`/api/workspaces/${owner.workspaceId}/billing/payments/${tranId}`)
      .expect(401);

    expectValidation(tranId, 1000);
    await callback('ipn', paidForm(tranId, 1000)).expect(200);
    const after = await get(owner.cookie);
    expect(after.body).toMatchObject({
      status: 'PAID',
      paidAt: expect.any(String),
      invoiceNumber: expect.stringMatching(/^SC-\d{4}-\d{5,}$/),
    });
  });
});

describe('SSLCommerz callbacks without SSLCommerz config (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const tranId = `UNKNOWN-NOCFG-${`${Date.now()}`.slice(-8)}`;

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
  });

  afterAll(async () => {
    await actors?.db
      .delete(paymentEvents)
      .where(eq(paymentEvents.tranId, tranId));
    await app?.close();
  });

  it('IPN 503 NOT_CONFIGURED (retry later), success → pending', async () => {
    const http = () => request(app.getHttpServer());
    await http()
      .post('/api/billing/sslcommerz/ipn')
      .type('form')
      .send({ tran_id: tranId })
      .expect(503);
    const back = await http()
      .post('/api/billing/sslcommerz/success')
      .type('form')
      .send({ tran_id: tranId });
    expect(back.status).toBe(303);
    expect(back.headers.location).toContain(
      `/billing?payment=pending&tranId=${tranId}`,
    );
    const events = await actors.db
      .select({ outcome: paymentEvents.outcome })
      .from(paymentEvents)
      .where(eq(paymentEvents.tranId, tranId));
    expect(events.map((e) => e.outcome)).toEqual([
      'NOT_CONFIGURED',
      'NOT_CONFIGURED',
    ]);
  });
});

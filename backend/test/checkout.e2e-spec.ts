import type { INestApplication } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { SubscriptionService } from '../src/billing/subscription.service.js';
import {
  type PaymentKind,
  paymentTransactions,
  PLAN_FEATURE_KEYS,
  type PlanFeatureKey,
  plans,
  promotionPlans,
  promotionRedemptions,
  promotions,
  subscriptions,
  type SubscriptionInterval,
} from '../src/db/schema/index.js';
import {
  SSLCOMMERZ_CONFIG,
  SSLCOMMERZ_SESSION_PATH,
  type SslcommerzConfig,
} from '../src/payments/sslcommerz.client.js';
import { monthlyReset } from '../src/wallet/wallet-period.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const DAY = 86_400_000;
const BASE = 'https://sslcommerz.fake.test';
const GATEWAY = `${BASE}/gwprocess/v4/checkout/fake-session`;
const CONFIG: SslcommerzConfig = {
  storeId: 'fakestore',
  storePassword: 'fake-store-password',
  sandbox: true,
  baseUrl: BASE,
};

/**
 * M8-T4: `POST …/billing/coupon` + `POST …/billing/checkout` (D2 owner only, D6, D7, M8-D7b,
 * readings 6/7/8). SSLCommerz = a fake `fetch` that fails on any unexpected request; real Postgres.
 */
describe('Checkout API (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let billing: SubscriptionService;
  let superAdmin: Actor;
  const db = () => actors.db;
  const http = () => request(app.getHttpServer());
  const tag = `${Date.now()}`.slice(-8);
  const fetchMock = vi.fn<typeof fetch>();
  type PlanRow = typeof plans.$inferSelect;
  let basic: PlanRow;
  let pro: PlanRow;
  let monthOnly: PlanRow;

  const planRow = async (
    slug: string,
    monthlyPriceBdt: number,
    yearlyMonthlyPriceBdt: number | null,
  ) => {
    const [row] = await db()
      .insert(plans)
      .values({
        slug: `m8t4-${slug}-${tag}`,
        name: `M8T4 ${slug}`,
        sortOrder: 97,
        isActive: true,
        monthlyPriceBdt,
        yearlyMonthlyPriceBdt,
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

  /** A COUPON on `targets` (default basic + pro). */
  const coupon = async (
    code: string,
    row: Partial<typeof promotions.$inferInsert> = {},
    targets: PlanRow[] = [basic, pro],
  ) => {
    const [p] = await db()
      .insert(promotions)
      .values({
        kind: 'COUPON',
        name: `M8-T4 ${code}`,
        code: `${code}-${tag}`,
        discountType: 'FLAT',
        discountValue: 100,
        discountScope: 'TOTAL',
        createdBy: superAdmin.id,
        ...row,
      })
      .returning({ id: promotions.id, code: promotions.code });
    if (targets.length)
      await db()
        .insert(promotionPlans)
        .values(targets.map((t) => ({ promotionId: p!.id, planId: t.id })));
    return p!.code!;
  };

  const post = (
    who: Actor | string,
    route: 'checkout' | 'coupon',
    body: object,
    workspaceId = typeof who === 'string' ? '' : who.workspaceId,
  ) =>
    http()
      .post(`/api/workspaces/${workspaceId}/billing/${route}`)
      .set('Cookie', typeof who === 'string' ? who : who.cookie)
      .send(body);

  /** The fake session API: exactly one form POST, answered SUCCESS (or `answer`). */
  const expectSession = (answer: object = {}) =>
    fetchMock.mockImplementationOnce(async (url, init) => {
      expect(url).toBe(`${BASE}${SSLCOMMERZ_SESSION_PATH}`);
      expect(init?.method).toBe('POST');
      return Response.json({
        status: 'SUCCESS',
        GatewayPageURL: GATEWAY,
        sessionkey: 'FAKE-SESSION',
        ...answer,
      });
    });
  const sentForm = (call = 0) =>
    fetchMock.mock.calls[call]![1]!.body as URLSearchParams;

  const txOf = async (tranId: string) => {
    const [row] = await db()
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.tranId, tranId));
    return row!;
  };
  const txsOf = async (owner: Actor) =>
    db()
      .select()
      .from(paymentTransactions)
      .where(
        eq(
          paymentTransactions.billingAccountId,
          await actors.accountIdOf(owner),
        ),
      );
  const subsOf = async (owner: Actor) =>
    db()
      .select()
      .from(subscriptions)
      .where(
        eq(subscriptions.billingAccountId, await actors.accountIdOf(owner)),
      )
      .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));

  /** A paid term like a validated payment (M8-T5) would start it. */
  async function activate(
    owner: Actor,
    plan: PlanRow,
    interval: SubscriptionInterval,
    kind: PaymentKind,
    start = new Date(),
  ) {
    const accountId = await actors.accountIdOf(owner);
    const price = await billing.checkoutPrice(
      accountId,
      plan,
      interval,
      null,
      kind,
      start,
    );
    return db().transaction((tx) =>
      billing.activatePaidTerm(tx, {
        accountId,
        workspaceId: owner.workspaceId,
        planId: plan.id,
        interval,
        kind,
        start,
        price,
        source: 'PAYMENT',
        reason: `Payment m8t4-${kind}`,
        now: start,
      }),
    );
  }

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(SSLCOMMERZ_CONFIG).useValue(CONFIG),
    );
    actors = createAuthActors(app);
    billing = app.get(SubscriptionService);
    superAdmin = await actors.signUpSuperAdmin('m8t4-super');
    basic = await planRow('basic', 1000, 900);
    pro = await planRow('pro', 3000, 2700);
    monthOnly = await planRow('monthly', 1500, null);
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
    await actors?.cleanup();
    const ids = [basic, pro, monthOnly].filter(Boolean).map((p) => p.id);
    if (ids.length) await db().delete(plans).where(inArray(plans.id, ids));
    await app?.close();
  });

  it('trial → monthly checkout (D6): PENDING SSLCOMMERZ row with the price snapshot, session form, 201 { tranId, gatewayUrl }', async () => {
    const owner = await actors.signUp('m8t4-month', { trial: true });
    expectSession();
    const res = await post(owner, 'checkout', {
      planId: basic.id,
      interval: 'month',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({
      tranId: expect.stringMatching(/^SC[A-Za-z0-9_-]{16}$/),
      gatewayUrl: GATEWAY,
    });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const form = sentForm();
    expect(Object.fromEntries(form)).toMatchObject({
      store_id: CONFIG.storeId,
      total_amount: '1000',
      currency: 'BDT',
      tran_id: res.body.tranId,
      success_url: 'http://app.localhost:5174/api/billing/sslcommerz/success',
      ipn_url: 'http://app.localhost:5174/api/billing/sslcommerz/ipn',
      cus_email: owner.email,
      product_name: `ShieldComment ${basic.name} (monthly)`,
    });
    expect(form.has('multi_card_name')).toBe(false); // D3
    expect(await txOf(res.body.tranId)).toMatchObject({
      billingAccountId: await actors.accountIdOf(owner),
      workspaceId: owner.workspaceId,
      userId: owner.id,
      planId: basic.id,
      interval: 'month',
      kind: 'NEW',
      amountBdt: 1000,
      status: 'PENDING',
      gateway: 'SSLCOMMERZ',
      paidAt: null,
      invoiceNumber: null,
      subscriptionId: null,
      price: {
        listChargedBdt: 1000,
        chargedBdt: 1000,
        perMonthBdt: 1000,
        discount: null,
        coupon: null,
        creditBdt: 0,
      },
    });
    // Nothing activated yet: the trial runs until the validated payment (M8-T5).
    expect((await subsOf(owner)).map((s) => s.status)).toEqual(['TRIALING']);
  });

  it('yearly checkout charges 12 × the yearly per-month price; no yearly price → 400 YEARLY_PRICE_MISSING', async () => {
    const owner = await actors.signUp('m8t4-year');
    expectSession();
    const res = await post(owner, 'checkout', {
      planId: basic.id,
      interval: 'year',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(sentForm().get('total_amount')).toBe('10800');
    expect(await txOf(res.body.tranId)).toMatchObject({
      interval: 'year',
      kind: 'NEW',
      amountBdt: 10800,
      price: { chargedBdt: 10800, perMonthBdt: 900 },
    });

    const missing = await post(owner, 'checkout', {
      planId: monthOnly.id,
      interval: 'year',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('YEARLY_PRICE_MISSING');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coupon preview + checkout with the coupon: the price is fixed, the coupon is not claimed yet (reading 6)', async () => {
    const owner = await actors.signUp('m8t4-coupon');
    const code = await coupon('SAVE100');
    const preview = await post(owner, 'coupon', {
      planId: basic.id,
      interval: 'month',
      code: code.toLowerCase(),
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({
      amountBdt: 900,
      price: {
        chargedBdt: 900,
        coupon: { code, amountBdt: 100, redemptionId: null },
      },
    });

    expectSession();
    const res = await post(owner, 'checkout', {
      planId: basic.id,
      interval: 'month',
      couponCode: code,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(sentForm().get('total_amount')).toBe('900');
    expect(await txOf(res.body.tranId)).toMatchObject({
      amountBdt: 900,
      price: { coupon: { code, redemptionId: null } },
    });
    expect(
      await db()
        .select()
        .from(promotionRedemptions)
        .where(
          eq(
            promotionRedemptions.billingAccountId,
            await actors.accountIdOf(owner),
          ),
        ),
    ).toEqual([]);
  });

  it('each COUPON_* on preview and checkout, and the ৳0 path (PAID PROMOTION row + ACTIVE term + invoice number)', async () => {
    const first = await actors.signUp('m8t4-free');
    const second = await actors.signUp('m8t4-free2');
    const free = await coupon('FREE', {
      discountType: 'PERCENT',
      discountValue: 100,
      maxRedemptions: 1,
    });
    const stopped = await coupon('STOPPED', {
      stoppedAt: new Date(),
      stoppedBy: superAdmin.id,
    });
    const elsewhere = await coupon('ELSEWHERE', {}, [pro]);
    const refused = async (
      who: Actor,
      code: string,
      expected: string,
      planId = basic.id,
    ) => {
      for (const res of [
        await post(who, 'coupon', { planId, interval: 'month', code }),
        await post(who, 'checkout', {
          planId,
          interval: 'month',
          couponCode: code,
        }),
      ]) {
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body.code).toBe(expected);
      }
    };
    await refused(first, 'NO-SUCH-CODE', 'COUPON_NOT_FOUND');
    await refused(first, 'bad code!', 'COUPON_NOT_FOUND');
    await refused(first, stopped, 'COUPON_EXPIRED');
    await refused(first, elsewhere, 'COUPON_NOT_FOR_PLAN');

    // ৳0: activated at once, no SSLCommerz call.
    const zero = await post(first, 'checkout', {
      planId: basic.id,
      interval: 'month',
      couponCode: free,
    });
    expect(zero.status, JSON.stringify(zero.body)).toBe(201);
    expect(zero.body).toEqual({ tranId: expect.any(String), paid: true });
    const [sub] = await subsOf(first);
    expect(sub).toMatchObject({
      planId: basic.id,
      status: 'ACTIVE',
      chargedBdt: 0,
    });
    const [redemption] = await db()
      .select()
      .from(promotionRedemptions)
      .where(
        eq(
          promotionRedemptions.billingAccountId,
          await actors.accountIdOf(first),
        ),
      );
    expect(sub!.couponRedemptionId).toBe(redemption!.id);
    const row = await txOf(zero.body.tranId);
    expect(row).toMatchObject({
      kind: 'NEW',
      amountBdt: 0,
      status: 'PAID',
      gateway: 'PROMOTION',
      valId: null,
      subscriptionId: sub!.id,
      invoiceNumber: expect.stringMatching(/^SC-\d{4}-\d{5,}$/),
      price: { chargedBdt: 0, coupon: { redemptionId: redemption!.id } },
    });
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(row.invoiceNumber!.slice(3, 7)).toBe(
      new Intl.DateTimeFormat('en', {
        timeZone: 'Asia/Dhaka',
        year: 'numeric',
      }).format(row.paidAt!),
    );

    await refused(first, free, 'COUPON_ALREADY_USED', pro.id); // an upgrade, so the kind passes
    await refused(second, free, 'COUPON_USED_UP');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('0 < amount < ৳10 → 400 AMOUNT_TOO_LOW, no row (reading 8)', async () => {
    const owner = await actors.signUp('m8t4-low');
    const code = await coupon('LOW', { discountValue: 995 });
    const res = await post(owner, 'checkout', {
      planId: basic.id,
      interval: 'month',
      couponCode: code,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_TOO_LOW');
    expect(await txsOf(owner)).toEqual([]);
  });

  it('owner only (D2): moderator / admin 403, impersonated 403 IMPERSONATION_READ_ONLY; another account 404; unknown plan 400', async () => {
    const owner = await actors.signUp('m8t4-roles');
    const moderator = await actors.signUp('m8t4-mod');
    const wsAdmin = await actors.signUp('m8t4-wsadmin');
    const outsider = await actors.signUp('m8t4-out');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    await actors.addMember(owner.workspaceId, wsAdmin.id, 'admin');
    const impersonated = await actors.signIn(owner.email);
    await actors.patchStoredSession(impersonated, {
      impersonatedBy: superAdmin.id,
      activeOrganizationId: owner.workspaceId,
    });
    const code = await coupon('ROLES');
    for (const route of ['checkout', 'coupon'] as const) {
      const body =
        route === 'coupon'
          ? { planId: basic.id, interval: 'month', code }
          : { planId: basic.id, interval: 'month' };
      for (const who of [moderator, wsAdmin])
        await post(who, route, body, owner.workspaceId).expect(403);
      const imp = await post(impersonated, route, body, owner.workspaceId);
      expect(imp.status).toBe(403);
      expect(imp.body.code).toBe('IMPERSONATION_READ_ONLY');
      await post(outsider, route, body, owner.workspaceId).expect(404);
    }
    const unknown = await post(owner, 'checkout', {
      planId: crypto.randomUUID(),
      interval: 'month',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('PLAN_NOT_AVAILABLE');
    await post(owner, 'checkout', {
      planId: basic.id,
      interval: 'week',
    }).expect(400);
    expect(await txsOf(owner)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('D4/D7: RENEWAL_NOT_OPEN and PLAN_CHANGE_AT_RENEWAL while the term runs; an upgrade charges the new price minus the unused-term credit', async () => {
    const owner = await actors.signUp('m8t4-change');
    await activate(owner, basic, 'month', 'NEW');
    const conflict = async (planId: string, interval: string, code: string) => {
      const res = await post(owner, 'checkout', { planId, interval });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe(code);
    };
    await conflict(basic.id, 'month', 'RENEWAL_NOT_OPEN');

    expectSession();
    const up = await post(owner, 'checkout', {
      planId: pro.id,
      interval: 'month',
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const [sub] = await subsOf(owner);
    const termDays = Math.round(
      (sub!.currentTermEnd.getTime() - sub!.currentTermStart.getTime()) / DAY,
    );
    const credit = Math.floor((1000 * (termDays - 1)) / termDays);
    expect(await txOf(up.body.tranId)).toMatchObject({
      kind: 'UPGRADE',
      amountBdt: 3000 - credit,
      price: { chargedBdt: 3000, creditBdt: credit },
    });
    expect(sentForm().get('total_amount')).toBe(String(3000 - credit));

    const yearly = await actors.signUp('m8t4-yearly');
    await activate(yearly, pro, 'year', 'NEW');
    const res = await post(yearly, 'checkout', {
      planId: pro.id,
      interval: 'month',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAN_CHANGE_AT_RENEWAL');
    const down = await post(yearly, 'checkout', {
      planId: basic.id,
      interval: 'year',
    });
    expect(down.status).toBe(409);
    expect(down.body.code).toBe('PLAN_CHANGE_AT_RENEWAL');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('M8-D7b: a downgrade in the 7-day window is a RENEWAL scheduled at the term end; then PLAN_CHANGE_SCHEDULED', async () => {
    const owner = await actors.signUp('m8t4-sched');
    const start = new Date(Date.now() - 26 * DAY);
    const current = await activate(owner, pro, 'month', 'NEW', start);
    expectSession();
    const res = await post(owner, 'checkout', {
      planId: basic.id,
      interval: 'month',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await txOf(res.body.tranId);
    expect(row).toMatchObject({ kind: 'RENEWAL', amountBdt: 1000 });

    // What the validated payment (M8-T5) does with the row: the next term is stored, nothing else moves.
    const done = await db().transaction((tx) =>
      billing.activatePaidTerm(tx, {
        accountId: row.billingAccountId,
        workspaceId: owner.workspaceId,
        planId: row.planId,
        interval: row.interval,
        kind: row.kind,
        start: new Date(),
        price: row.price,
        source: 'PAYMENT',
        reason: `Payment ${row.tranId}`,
      }),
    );
    const end = current.term.end;
    expect(done).toMatchObject({
      subscriptionId: current.subscriptionId,
      term: { scheduled: true, start: end, end: monthlyReset(end, 1) },
      balances: null,
    });
    const subs = await subsOf(owner);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      planId: pro.id,
      status: 'ACTIVE',
      currentTermEnd: end,
      chargedBdt: 3000,
      scheduledPlanId: basic.id,
      scheduledInterval: 'month',
      scheduledPrice: { chargedBdt: 1000, perMonthBdt: 1000 },
    });

    const again = await post(owner, 'checkout', {
      planId: pro.id,
      interval: 'month',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PLAN_CHANGE_SCHEDULED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('SSLCommerz failure → row FAILED + 502 PAYMENT_GATEWAY_ERROR', async () => {
    const owner = await actors.signUp('m8t4-fail');
    expectSession({ status: 'FAILED', failedreason: 'Store is inactive' });
    const res = await post(owner, 'checkout', {
      planId: basic.id,
      interval: 'month',
    });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PAYMENT_GATEWAY_ERROR');
    expect(await txsOf(owner)).toEqual([
      expect.objectContaining({ status: 'FAILED', amountBdt: 1000 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rate limit per account: the 21st coupon preview in 10 minutes → 429', async () => {
    const owner = await actors.signUp('m8t4-rate');
    for (let i = 0; i < 20; i++)
      await post(owner, 'coupon', { planId: 'x' }).expect(400);
    await post(owner, 'coupon', { planId: 'x' }).expect(429);
    // Another account is not limited.
    const other = await actors.signUp('m8t4-rate2');
    await post(other, 'coupon', { planId: 'x' }).expect(400);
  });
});

describe('Checkout API without SSLCommerz (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('503 PAYMENTS_NOT_CONFIGURED, no row', async () => {
    const owner = await actors.signUp('m8t4-nocfg');
    const [starter] = await actors.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.slug, 'starter'));
    const res = await request(app.getHttpServer())
      .post(`/api/workspaces/${owner.workspaceId}/billing/checkout`)
      .set('Cookie', owner.cookie)
      .send({ planId: starter!.id, interval: 'month' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PAYMENTS_NOT_CONFIGURED');
    expect(
      await actors.db
        .select()
        .from(paymentTransactions)
        .where(
          eq(
            paymentTransactions.billingAccountId,
            await actors.accountIdOf(owner),
          ),
        ),
    ).toEqual([]);
  });
});

import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  type PaymentPrice,
  type PaymentStatus,
  paymentTransactions,
  PLAN_FEATURE_KEYS,
  type PlanFeatureKey,
  plans,
  subscriptions,
} from '../src/db/schema/index.js';
import {
  SSLCOMMERZ_CONFIG,
  SSLCOMMERZ_SESSION_PATH,
  SSLCOMMERZ_VALIDATION_PATH,
  type SslcommerzConfig,
} from '../src/payments/sslcommerz.client.js';
import {
  type Actor,
  createAuthActors,
  TRUSTED_ORIGIN,
} from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const DAY = 86_400_000;
const BASE = 'https://sslcommerz.fake.test';
const CONFIG: SslcommerzConfig = {
  storeId: 'fakestore',
  storePassword: 'fake-store-password',
  sandbox: true,
  baseUrl: BASE,
};
const SELLER = { name: 'ShieldComment BD', address: 'Road 2, Dhaka 1212' };
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

/**
 * M8-T7: `GET …/billing/invoices` + `GET …/billing/invoices/:invoiceId` (D2 owner + admin,
 * impersonated read; D8 seller env, VAT-inclusive). Real checkout + signed IPN for the paid path
 * (SSLCommerz = a fake `fetch` that fails on any unexpected request); settled rows inserted
 * directly for paging, promotion lines, credit and REFUNDED.
 */
describe('Client invoices (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let superAdmin: Actor;
  let basic: typeof plans.$inferSelect;
  const db = () => actors.db;
  const http = () => request(app.getHttpServer());
  const tag = `${Date.now()}`.slice(-8);
  const fetchMock = vi.fn<typeof fetch>();
  let seq = 0;

  const list = (cookie: string, workspaceId: string, query = '') =>
    http()
      .get(`/api/workspaces/${workspaceId}/billing/invoices${query}`)
      .set('Cookie', cookie);
  const one = (cookie: string, workspaceId: string, id: string) =>
    http()
      .get(`/api/workspaces/${workspaceId}/billing/invoices/${id}`)
      .set('Cookie', cookie);

  /** Real checkout (fake session API) + a signed IPN validated by the fake validation API. */
  const pay = async (owner: Actor, amount: number) => {
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
    const tranId = res.body.tranId as string;
    fetchMock.mockImplementationOnce(async (url) => {
      const u = new URL(url as string | URL);
      expect(`${u.origin}${u.pathname}`).toBe(
        `${BASE}${SSLCOMMERZ_VALIDATION_PATH}`,
      );
      return Response.json({
        status: 'VALID',
        tran_id: tranId,
        val_id: `VAL-${tranId}`,
        amount: `${amount}.00`,
        currency_type: 'BDT',
        currency_amount: `${amount}.00`,
        bank_tran_id: `BANK-${tranId}`,
        card_type: 'NAGAD-Nagad',
        risk_level: '0',
      });
    });
    const fields: Record<string, string> = {
      status: 'VALID',
      tran_id: tranId,
      val_id: `VAL-${tranId}`,
      amount: `${amount}.00`,
      currency: 'BDT',
    };
    const all = { ...fields, store_passwd: md5(CONFIG.storePassword) };
    const sign = md5(
      Object.keys(all)
        .sort()
        .map((k) => `${k}=${all[k as keyof typeof all]}`)
        .join('&'),
    );
    await http()
      .post('/api/billing/sslcommerz/ipn')
      .type('form')
      .send({
        ...fields,
        verify_key: Object.keys(fields).join(','),
        verify_sign: sign,
      })
      .expect(200);
    const [row] = await db()
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.tranId, tranId));
    expect(row!.status).toBe('PAID');
    return row!;
  };

  const PRICE: PaymentPrice = {
    listChargedBdt: 1000,
    chargedBdt: 1000,
    perMonthBdt: 1000,
    discount: null,
    coupon: null,
    creditBdt: 0,
  };

  /** A settled (or other) row inserted directly, `minutes` after a fixed base. */
  const insertRow = async (
    owner: Actor,
    subscriptionId: string,
    status: PaymentStatus,
    minutes: number,
    patch: Partial<typeof paymentTransactions.$inferInsert> = {},
  ) => {
    const n = seq++;
    const settled = status === 'PAID' || status === 'REFUNDED';
    const paidAt = new Date(
      Date.parse('2026-11-01T06:00:00Z') + minutes * 60_000,
    );
    const [row] = await db()
      .insert(paymentTransactions)
      .values({
        billingAccountId: await actors.accountIdOf(owner),
        workspaceId: owner.workspaceId,
        userId: owner.id,
        planId: basic.id,
        interval: 'month',
        kind: 'NEW',
        tranId: `M8T7${tag}${n}`,
        amountBdt: 1000,
        status,
        gateway: 'SSLCOMMERZ',
        cardType: settled ? 'BKASH-BKash' : null,
        valId: settled ? `VAL${tag}${n}` : null,
        paidAt: settled ? paidAt : null,
        subscriptionId: settled ? subscriptionId : null,
        termStart: settled ? paidAt : null,
        termEnd: settled ? new Date(paidAt.getTime() + 30 * DAY) : null,
        invoiceNumber: settled ? `SC-2026-${tag}${n}` : null,
        price: PRICE,
        ...patch,
      })
      .returning();
    return row!;
  };

  beforeAll(async () => {
    process.env.INVOICE_SELLER_NAME = SELLER.name;
    process.env.INVOICE_SELLER_ADDRESS = SELLER.address;
    app = await createTestApp((b) =>
      b.overrideProvider(SSLCOMMERZ_CONFIG).useValue(CONFIG),
    );
    actors = createAuthActors(app);
    superAdmin = await actors.signUpSuperAdmin('m8t7-super');
    const [row] = await db()
      .insert(plans)
      .values({
        slug: `m8t7-basic-${tag}`,
        name: `M8T7 basic`,
        sortOrder: 95,
        isActive: true,
        monthlyPriceBdt: 1000,
        yearlyMonthlyPriceBdt: 900,
        featureConfig: {
          limits: {
            connectedPages: 1,
            monthlyComments: 100,
            teamSeats: 3,
            workspaces: 2,
          },
          features: Object.fromEntries(
            PLAN_FEATURE_KEYS.map((key) => [key, false]),
          ) as Record<PlanFeatureKey, boolean>,
        },
      })
      .returning();
    basic = row!;
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
    delete process.env.INVOICE_SELLER_NAME;
    delete process.env.INVOICE_SELLER_ADDRESS;
    await actors?.cleanup();
    if (basic)
      await db()
        .delete(plans)
        .where(inArray(plans.id, [basic.id]));
    await app?.close();
  });

  it('paid via IPN → one invoice; a renewal snapshots its own term (the first invoice keeps its term)', async () => {
    const owner = await actors.signUp('m8t7-paid', { trial: true });
    const first = await pay(owner, 1000);

    const res = await list(owner.cookie, owner.workspaceId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toEqual({
      items: [
        {
          id: first.id,
          invoiceNumber: first.invoiceNumber,
          paidAt: first.paidAt!.toISOString(),
          status: 'PAID',
          plan: { id: basic.id, name: basic.name },
          interval: 'month',
          amountBdt: 1000,
          gateway: 'Nagad',
        },
      ],
      total: 1,
      skip: 0,
      take: 20,
    });

    const [sub] = await db()
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, first.subscriptionId!));
    const detail = await one(owner.cookie, owner.workspaceId, first.id);
    expect(detail.status).toBe(200);
    expect(detail.headers['cache-control']).toBe('private, no-store');
    expect(detail.body).toEqual({
      id: first.id,
      invoiceNumber: expect.stringMatching(/^SC-\d{4}-\d{5,}$/),
      tranId: first.tranId,
      paidAt: first.paidAt!.toISOString(),
      status: 'PAID',
      kind: 'NEW',
      plan: { id: basic.id, name: basic.name },
      interval: 'month',
      term: {
        start: sub!.currentTermStart.toISOString(),
        end: sub!.currentTermEnd.toISOString(),
      },
      listPriceBdt: 1000,
      promotions: [],
      creditBdt: 0,
      chargedBdt: 1000,
      amountBdt: 1000,
      gateway: 'Nagad',
      seller: SELLER,
    });

    // Inside the 7-day renewal window: the renewal extends the same row from its end.
    const firstTerm = detail.body.term as { start: string; end: string };
    const end = new Date(Date.now() + 3 * DAY);
    await db()
      .update(subscriptions)
      .set({
        currentTermStart: new Date(end.getTime() - 30 * DAY),
        currentTermEnd: end,
      })
      .where(eq(subscriptions.id, sub!.id));
    const renewal = await pay(owner, 1000);
    expect(renewal.kind).toBe('RENEWAL');
    expect(renewal.subscriptionId).toBe(sub!.id);
    const [moved] = await db()
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, sub!.id));
    const second = await one(owner.cookie, owner.workspaceId, renewal.id);
    expect(second.body).toMatchObject({
      kind: 'RENEWAL',
      term: {
        start: end.toISOString(),
        end: moved!.currentTermEnd.toISOString(),
      },
    });
    expect(
      (await one(owner.cookie, owner.workspaceId, first.id)).body.term,
    ).toEqual(firstTerm);
    const both = await list(owner.cookie, owner.workspaceId);
    expect(both.body.items.map((i: { id: string }) => i.id)).toEqual([
      renewal.id,
      first.id,
    ]);
  });

  it('newest paid first with paging; PENDING / FAILED / CANCELLED rows are not invoices; REFUNDED is; promotion lines ("k of N") + credit', async () => {
    const owner = await actors.signUp('m8t7-page');
    const subId = await actors.activatePlan(owner, 'growth');
    const old = await insertRow(owner, subId, 'PAID', 0);
    const refunded = await insertRow(owner, subId, 'REFUNDED', 10, {
      cardType: 'VISA-Brac Bank',
    });
    const promo = await insertRow(owner, subId, 'PAID', 20, {
      kind: 'UPGRADE',
      amountBdt: 0,
      gateway: 'PROMOTION',
      cardType: null,
      valId: null,
      price: {
        listChargedBdt: 3000,
        chargedBdt: 1200,
        perMonthBdt: 3000,
        discount: {
          promotionId: '019a0000-0000-7000-8000-000000000001',
          redemptionId: '019a0000-0000-7000-8000-000000000002',
          name: 'Launch 50%',
          code: null,
          label: '50% off for 3 months',
          labelBn: '৩ মাস ৫০% ছাড়',
          amountBdt: 1500,
          months: { from: 2, to: 2, of: 3 },
        },
        coupon: {
          promotionId: '019a0000-0000-7000-8000-000000000003',
          redemptionId: '019a0000-0000-7000-8000-000000000004',
          name: 'Welcome',
          code: 'WELCOME',
          label: '৳300 off',
          labelBn: '৳৩০০ ছাড়',
          amountBdt: 300,
          months: null,
        },
        creditBdt: 1200,
      },
    });
    const pending = await insertRow(owner, subId, 'PENDING', 30);
    await insertRow(owner, subId, 'FAILED', 40);
    await insertRow(owner, subId, 'CANCELLED', 50);

    const all = await list(owner.cookie, owner.workspaceId);
    expect(all.body.total).toBe(3);
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([
      promo.id,
      refunded.id,
      old.id,
    ]);
    expect(
      all.body.items.map((i: { gateway: string; status: string }) => [
        i.status,
        i.gateway,
      ]),
    ).toEqual([
      ['PAID', 'PROMOTION'],
      ['REFUNDED', 'Visa'],
      ['PAID', 'bKash'],
    ]);
    const page = await list(owner.cookie, owner.workspaceId, '?skip=1&take=1');
    expect(page.body).toMatchObject({ total: 3, skip: 1, take: 1 });
    expect(page.body.items.map((i: { id: string }) => i.id)).toEqual([
      refunded.id,
    ]);

    const detail = await one(owner.cookie, owner.workspaceId, promo.id);
    expect(detail.body).toMatchObject({
      kind: 'UPGRADE',
      listPriceBdt: 3000,
      creditBdt: 1200,
      chargedBdt: 0,
      gateway: 'PROMOTION',
      promotions: [
        {
          type: 'DISCOUNT',
          name: 'Launch 50%',
          code: null,
          label: '50% off for 3 months',
          labelBn: '৩ মাস ৫০% ছাড়',
          amountOffBdt: 1500,
          months: { from: 2, to: 2, of: 3 },
        },
        {
          type: 'COUPON',
          name: 'Welcome',
          code: 'WELCOME',
          amountOffBdt: 300,
          months: null,
        },
      ],
    });
    expect(
      (await one(owner.cookie, owner.workspaceId, refunded.id)).body,
    ).toMatchObject({ status: 'REFUNDED', gateway: 'Visa' });

    // 404: an unsettled row, a non-uuid, an unknown uuid.
    for (const id of [
      pending.id,
      'not-a-uuid',
      '019a0000-0000-7000-8000-0000000000ff',
    ])
      expect((await one(owner.cookie, owner.workspaceId, id)).status).toBe(404);
    // Paging validation.
    for (const q of ['?take=0', '?take=101', '?skip=-1', '?status=PAID'])
      expect((await list(owner.cookie, owner.workspaceId, q)).status).toBe(400);
  });

  it('D2: owner + admin + impersonated read, moderator 403; another account 404; another workspace of the same account sees the same invoices', async () => {
    const owner = await actors.signUp('m8t7-roles');
    const subId = await actors.activatePlan(owner, 'growth');
    const paid = await insertRow(owner, subId, 'PAID', 0);
    const wsAdmin = await actors.signUp('m8t7-admin');
    const moderator = await actors.signUp('m8t7-mod');
    await actors.addMember(owner.workspaceId, wsAdmin.id, 'admin');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    const impersonated = await actors.signIn(owner.email);
    await actors.patchStoredSession(impersonated, {
      impersonatedBy: superAdmin.id,
      activeOrganizationId: owner.workspaceId,
    });

    for (const cookie of [owner.cookie, wsAdmin.cookie, impersonated]) {
      expect((await list(cookie, owner.workspaceId)).body.total).toBe(1);
      expect((await one(cookie, owner.workspaceId, paid.id)).status).toBe(200);
    }
    expect((await list(moderator.cookie, owner.workspaceId)).status).toBe(403);
    expect(
      (await one(moderator.cookie, owner.workspaceId, paid.id)).status,
    ).toBe(403);
    await http()
      .get(`/api/workspaces/${owner.workspaceId}/billing/invoices`)
      .expect(401);

    // Another account: its own list is empty, our id is a 404, our workspace is a 404.
    const other = await actors.signUp('m8t7-other');
    const otherList = await list(other.cookie, other.workspaceId);
    expect(otherList.body).toEqual({ items: [], total: 0, skip: 0, take: 20 });
    expect((await one(other.cookie, other.workspaceId, paid.id)).status).toBe(
      404,
    );
    expect((await list(other.cookie, owner.workspaceId)).status).toBe(404);

    // A second workspace of the same billing account.
    const created = await http()
      .post('/api/auth/organization/create')
      .set('Cookie', owner.cookie)
      .set('Origin', TRUSTED_ORIGIN)
      .send({ name: 'M8-T7 second', slug: `m8t7-second-${tag}` });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const second = created.body.id as string;
    actors.trackWorkspace(second);
    const fromSecond = await list(owner.cookie, second);
    expect(fromSecond.body.items.map((i: { id: string }) => i.id)).toEqual([
      paid.id,
    ]);
    expect((await one(owner.cookie, second, paid.id)).status).toBe(200);
  });
});

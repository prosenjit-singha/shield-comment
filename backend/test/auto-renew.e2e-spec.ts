import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { autoRenewTokenContext } from '../src/billing/auto-renew.js';
import { AutoRenewService } from '../src/billing/auto-renew.service.js';
import { BillingJobSchedulers } from '../src/billing/billing-job-schedulers.js';
import { TokenCipherService } from '../src/crypto/token-cipher.service.js';
import {
  billingAccounts,
  paymentTransactions,
  PLAN_FEATURE_KEYS,
  type PlanFeatureKey,
  plans,
  subscriptions,
} from '../src/db/schema/index.js';
import { EmailService } from '../src/email/email.service.js';
import {
  SSLCOMMERZ_CONFIG,
  SSLCOMMERZ_SESSION_PATH,
  SSLCOMMERZ_TOKEN_CHARGE_PATH,
  SSLCOMMERZ_VALIDATION_PATH,
  type SslcommerzConfig,
} from '../src/payments/sslcommerz.client.js';
import { QUEUE_NAMES } from '../src/queue/queue.constants.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { createEmailServiceFake } from './utils/fake-email.js';
import { fakeQueue } from './utils/fake-queue.js';

const HOUR = 3_600_000;
const BASE = 'https://sslcommerz.fake.test';
const CONFIG: SslcommerzConfig = {
  storeId: 'fakestore',
  storePassword: 'fake-store-password',
  sandbox: true,
  baseUrl: BASE,
};
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const OFF = { available: false, enabled: false, tokenSaved: false };

/**
 * M8-T6b: tokenized auto-renew behind `SSLCOMMERZ_TOKENIZATION` (D4; M8-D14 timing; D2 owner only).
 * SSLCommerz = a fake `fetch` that throws on any unexpected request; email = the strict fake;
 * real Postgres. Charges run `AutoRenewService.chargeDue(now)` with `now` near the term end.
 */
describe.each([
  { flag: false, label: 'flag off' },
  { flag: true, label: 'flag on' },
])('Tokenized auto-renew (e2e, $label)', ({ flag }) => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let plan: typeof plans.$inferSelect;
  const email = createEmailServiceFake();
  const fetchMock = vi.fn<typeof fetch>();
  const tag = `${Date.now()}`.slice(-8);
  const db = () => actors.db;
  const http = () => request(app.getHttpServer());
  const route = (owner: Actor) =>
    `/api/workspaces/${owner.workspaceId}/billing/auto-renew`;
  const summary = async (owner: Actor) =>
    (
      await http()
        .get(`/api/workspaces/${owner.workspaceId}/billing/summary`)
        .set('Cookie', owner.cookie)
        .expect(200)
    ).body as Record<string, unknown>;
  const setEnabled = (who: Actor, owner: Actor, enabled: boolean) =>
    http().put(route(owner)).set('Cookie', who.cookie).send({ enabled });

  /** Checkout → session fake (form captured) → IPN with the validator answering `token`. */
  const pay = async (owner: Actor, token: string | null) => {
    let form: Record<string, string> = {};
    fetchMock.mockImplementationOnce(async (url, init) => {
      expect(url).toBe(`${BASE}${SSLCOMMERZ_SESSION_PATH}`);
      form = Object.fromEntries(init?.body as URLSearchParams);
      return Response.json({
        status: 'SUCCESS',
        GatewayPageURL: `${BASE}/pay`,
        sessionkey: 'S',
      });
    });
    const res = await http()
      .post(`/api/workspaces/${owner.workspaceId}/billing/checkout`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id, interval: 'month' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const tranId = res.body.tranId as string;
    expectValidation(tranId, token ? { token } : {});
    await http()
      .post('/api/billing/sslcommerz/ipn')
      .type('form')
      .send(paidForm(tranId))
      .expect(200);
    expect((await txOf(tranId)).status).toBe('PAID');
    return { tranId, form };
  };

  /** An IPN form signed like SSLCommerz (md5 over verify_key fields + md5(store password)). */
  const paidForm = (tranId: string) => {
    const fields: Record<string, string> = {
      status: 'VALID',
      tran_id: tranId,
      val_id: `VAL-${tranId}`,
      amount: '1000.00',
      currency: 'BDT',
    };
    const all = { ...fields, store_passwd: md5(CONFIG.storePassword) };
    const hash = Object.keys(all)
      .sort()
      .map((key) => `${key}=${all[key as keyof typeof all]}`)
      .join('&');
    return {
      ...fields,
      verify_key: Object.keys(fields).join(','),
      verify_sign: md5(hash),
    };
  };

  const expectValidation = (
    tranId: string,
    extra: Record<string, string> = {},
    amount = 1000,
  ) =>
    fetchMock.mockImplementationOnce(async (url) => {
      const u = new URL(url as string | URL);
      expect(`${u.origin}${u.pathname}`).toBe(
        `${BASE}${SSLCOMMERZ_VALIDATION_PATH}`,
      );
      expect(u.searchParams.get('val_id')).toBe(`VAL-${tranId}`);
      return Response.json({
        status: 'VALID',
        tran_id: tranId,
        val_id: `VAL-${tranId}`,
        currency_type: 'BDT',
        currency_amount: `${amount}.00`,
        card_type: 'VISA-Dutch Bangla',
        risk_level: '0',
        ...extra,
      });
    });

  /** The fake token charge: SUCCESS + val_id (then the validator), or FAILED. */
  const expectCharge = (token: string, ok: boolean) =>
    fetchMock.mockImplementationOnce(async (url, init) => {
      expect(url).toBe(`${BASE}${SSLCOMMERZ_TOKEN_CHARGE_PATH}`);
      const form = Object.fromEntries(init?.body as URLSearchParams);
      expect(form).toMatchObject({ token, total_amount: '1000' });
      if (!ok)
        return Response.json({ status: 'FAILED', failedreason: 'Declined' });
      expectValidation(form.tran_id!);
      return Response.json({
        status: 'SUCCESS',
        val_id: `VAL-${form.tran_id}`,
      });
    });

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
      )
      .orderBy(asc(paymentTransactions.createdAt));
  const liveSub = async (owner: Actor) => {
    const [row] = await db()
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.billingAccountId, await actors.accountIdOf(owner)),
          eq(subscriptions.status, 'ACTIVE'),
        ),
      );
    return row!;
  };
  const account = async (owner: Actor) => {
    const [row] = await db()
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.id, await actors.accountIdOf(owner)));
    return row!;
  };
  const charge = (now: Date) => app.get(AutoRenewService).chargeDue(now);

  /** Owner opted in, paid once with a token: ACTIVE monthly term + saved token. */
  const subscribed = async (prefix: string, token: string) => {
    const owner = await actors.signUp(`${prefix}-${flag ? 'on' : 'off'}`);
    await setEnabled(owner, owner, true).expect(200);
    const { form } = await pay(owner, token);
    expect(form.tokenize).toBe('1');
    return owner;
  };

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(SSLCOMMERZ_CONFIG)
        .useValue({ ...CONFIG, tokenization: flag })
        .overrideProvider(EmailService)
        .useValue(email),
    );
    actors = createAuthActors(app);
    const [row] = await db()
      .insert(plans)
      .values({
        slug: `m8t6b-${flag}-${tag}`,
        name: 'M8T6b Basic',
        sortOrder: 97,
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

  beforeEach(() => {
    email.reset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => {
      throw new Error('Unexpected fetch in this test');
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    expect(email.unexpected).toEqual([]);
  });

  afterAll(async () => {
    await actors?.cleanup();
    if (plan)
      await db()
        .delete(plans)
        .where(inArray(plans.id, [plan.id]));
    await app?.close();
  });

  if (!flag) {
    it('flag off: no tokenization field, no charge job, summary unavailable, PUT 409, charge run is a no-op', async () => {
      const owner = await actors.signUp('m8t6b-off');
      expect((await summary(owner)).autoRenew).toEqual(OFF);
      const put = await setEnabled(owner, owner, true);
      expect(put.status).toBe(409);
      expect(put.body.code).toBe('AUTO_RENEW_UNAVAILABLE');
      // The validator even answers a token: nothing is stored while the flag is off.
      const { form } = await pay(owner, 'TOKEN-OFF');
      expect(form).not.toHaveProperty('tokenize');
      expect((await account(owner)).autoRenewToken).toBeNull();

      await app.get(BillingJobSchedulers).ready;
      const ids = (
        await fakeQueue(app, QUEUE_NAMES.billing).getJobSchedulers()
      ).map((s) => s.id);
      expect(ids).toContain('renewal-reminders-daily');
      expect(ids).not.toContain('auto-renew-charge-hourly');

      const sub = await liveSub(owner);
      expect(
        await charge(new Date(sub.currentTermEnd.getTime() - 6 * HOUR)),
      ).toEqual({ kind: 'auto_renew', charged: 0, failed: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2); // session + validation only
    });
    return;
  }

  it('flag on: the charge job is registered; owner only, impersonated 403; opted-in checkout tokenizes and the token is stored encrypted, never returned', async () => {
    await app.get(BillingJobSchedulers).ready;
    expect(
      (await fakeQueue(app, QUEUE_NAMES.billing).getJobSchedulers()).find(
        (s) => s.id === 'auto-renew-charge-hourly',
      ),
    ).toMatchObject({
      repeat: { pattern: '5 * * * *', tz: 'Asia/Dhaka' },
      template: { name: 'auto-renew-charge' },
    });

    const owner = await actors.signUp('m8t6b-roles');
    expect((await summary(owner)).autoRenew).toEqual({
      available: true,
      enabled: false,
      tokenSaved: false,
    });
    // Not opted in: no tokenization field.
    const first = await pay(owner, null);
    expect(first.form).not.toHaveProperty('tokenize');

    const wsAdmin = await actors.signUp('m8t6b-wsadmin');
    await actors.addMember(owner.workspaceId, wsAdmin.id, 'admin');
    await setEnabled(wsAdmin, owner, true).expect(403);
    await http().delete(route(owner)).set('Cookie', wsAdmin.cookie).expect(403);
    const impersonated = await actors.signIn(owner.email);
    await actors.patchStoredSession(impersonated, {
      impersonatedBy: owner.id,
      activeOrganizationId: owner.workspaceId,
    });
    const imp = await setEnabled(
      { ...owner, cookie: impersonated },
      owner,
      true,
    );
    expect(imp.status).toBe(403);
    expect(imp.body.code).toBe('IMPERSONATION_READ_ONLY');
    await setEnabled(owner, owner, 'yes' as unknown as boolean).expect(400);

    const on = await setEnabled(owner, owner, true).expect(200);
    expect(on.body).toEqual({
      available: true,
      enabled: true,
      tokenSaved: false,
    });
    // Early renewal (inside the 7-day window is not needed: the IPN path pays it as RENEWAL).
    const subBefore = await liveSub(owner);
    await db()
      .update(subscriptions)
      .set({
        currentTermEnd: new Date(Date.now() + 5 * 24 * HOUR),
      })
      .where(eq(subscriptions.id, subBefore.id));
    const second = await pay(owner, 'TOKEN-SECRET-A');
    expect(second.form.tokenize).toBe('1');

    const acc = await account(owner);
    expect(acc.autoRenewToken).toMatch(/^v1:/);
    expect(acc.autoRenewToken).not.toContain('TOKEN-SECRET-A');
    expect(
      app
        .get(TokenCipherService)
        .decrypt(acc.autoRenewToken!, autoRenewTokenContext(acc.id)),
    ).toBe('TOKEN-SECRET-A');
    const body = await summary(owner);
    expect(body.autoRenew).toEqual({
      available: true,
      enabled: true,
      tokenSaved: true,
    });
    expect(JSON.stringify(body)).not.toContain('TOKEN-SECRET');
  });

  it('renewal charge ≤ 24 h before the end → PAID RENEWAL row, same row extended; repeated runs charge once', async () => {
    const owner = await subscribed('m8t6b-charge', 'TOKEN-B');
    const sub = await liveSub(owner);
    const end = sub.currentTermEnd;

    // > 24 h before: nothing due (the fetch fake would throw).
    expect(await charge(new Date(end.getTime() - 30 * HOUR))).toEqual({
      kind: 'auto_renew',
      charged: 0,
      failed: 0,
    });

    expectCharge('TOKEN-B', true);
    const now = new Date(end.getTime() - 20 * HOUR);
    expect(await charge(now)).toEqual({
      kind: 'auto_renew',
      charged: 1,
      failed: 0,
    });
    const after = await liveSub(owner);
    expect(after.id).toBe(sub.id);
    expect(after.currentTermEnd.getTime()).toBeGreaterThan(end.getTime());
    const renewal = (await txsOf(owner)).at(-1)!;
    expect(renewal).toMatchObject({
      kind: 'RENEWAL',
      status: 'PAID',
      amountBdt: 1000,
      subscriptionId: sub.id,
      invoiceNumber: expect.stringMatching(/^SC-\d{4}-\d{5,}$/),
    });

    // Same run again, and the retry time: the term moved, nothing is due.
    expect((await charge(now)).charged).toBe(0);
    expect((await charge(new Date(end.getTime() - 6 * HOUR))).charged).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(4); // session + validation, charge + validation
  });

  it('charge declined → FAILED row, retry on the last 12 h, then manual + one bilingual owner email; each attempt once', async () => {
    const owner = await subscribed('m8t6b-fail', 'TOKEN-C');
    const sub = await liveSub(owner);
    const end = sub.currentTermEnd;

    expectCharge('TOKEN-C', false);
    const first = new Date(end.getTime() - 20 * HOUR);
    expect(await charge(first)).toEqual({
      kind: 'auto_renew',
      charged: 0,
      failed: 1,
    });
    expect((await txsOf(owner)).at(-1)).toMatchObject({
      kind: 'RENEWAL',
      status: 'FAILED',
    });
    expect(await charge(first)).toEqual({
      kind: 'auto_renew',
      charged: 0,
      failed: 0,
    });

    expectCharge('TOKEN-C', false);
    email.expectSends(1);
    const retry = new Date(end.getTime() - 6 * HOUR);
    expect((await charge(retry)).failed).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({
      to: owner.email,
      subject: expect.stringContaining('We could not renew'),
    });
    expect(email.sent[0]!.text).toContain('নিজে রিনিউ করুন');
    expect(email.sent[0]!.html).toContain('/billing');

    expect((await charge(retry)).failed).toBe(0);
    expect(
      (await txsOf(owner)).filter((t) => t.status === 'FAILED'),
    ).toHaveLength(2);
    expect((await liveSub(owner)).currentTermEnd).toEqual(end);
    expect(fetchMock).toHaveBeenCalledTimes(4); // session + validation + 2 charges
  });

  it('toggle off → no charge; DELETE removes the token (and turns it off) → no charge', async () => {
    const owner = await subscribed('m8t6b-toggle', 'TOKEN-D');
    const end = (await liveSub(owner)).currentTermEnd;
    const now = new Date(end.getTime() - 20 * HOUR);

    await setEnabled(owner, owner, false).expect(200);
    expect(await charge(now)).toEqual({
      kind: 'auto_renew',
      charged: 0,
      failed: 0,
    });

    await setEnabled(owner, owner, true).expect(200);
    const removed = await http()
      .delete(route(owner))
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(removed.body).toEqual({
      available: true,
      enabled: false,
      tokenSaved: false,
    });
    expect((await account(owner)).autoRenewToken).toBeNull();
    await setEnabled(owner, owner, true).expect(200);
    expect((await charge(now)).charged).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2); // the first payment only
  });
});

import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  billingAccounts,
  INVOICE_NUMBER_PATTERN,
  paymentEvents,
  type PaymentPrice,
  paymentTransactions,
  plans,
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

const PRICE: PaymentPrice = {
  listChargedBdt: 999,
  chargedBdt: 499,
  perMonthBdt: 499,
  discount: null,
  coupon: null,
  creditBdt: 0,
};

/** M8-T2: `payment_transactions` + `payment_events` (migration 0039; D8 invoice numbers, D10 risk flag). */
describe('Payments schema (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let owner: Actor;
  let accountId: string;
  let planId: string;
  let subscriptionId: string;

  const db = () => actors.db;
  const tag = Date.now().toString(36);
  let seq = 0;
  /** A fresh valid `tran_id` (8–30 chars). */
  const tranId = () => `T${tag}${(seq++).toString().padStart(4, '0')}`;
  const eventTranIds: string[] = [];

  const pendingRow = (
    patch: Partial<typeof paymentTransactions.$inferInsert> = {},
  ): typeof paymentTransactions.$inferInsert => ({
    billingAccountId: accountId,
    workspaceId: owner.workspaceId,
    userId: owner.id,
    planId,
    interval: 'month',
    kind: 'NEW',
    tranId: tranId(),
    amountBdt: 499,
    gateway: 'SSLCOMMERZ',
    price: PRICE,
    ...patch,
  });

  let invoiceSeq = 0;
  const runDigits = String(Date.now()).slice(-6);
  const paidRow = (
    patch: Partial<typeof paymentTransactions.$inferInsert> = {},
  ): typeof paymentTransactions.$inferInsert =>
    pendingRow({
      status: 'PAID',
      valId: `VAL${tag}${seq}`,
      bankTranId: `BANK${seq}`,
      cardType: 'BKASH-BKash',
      riskLevel: 0,
      paidAt: new Date(),
      subscriptionId,
      termStart: new Date(Date.now() - 60_000),
      termEnd: new Date(Date.now() + 30 * 86_400_000),
      invoiceNumber: `SC-2026-${runDigits}${invoiceSeq++}`,
      ...patch,
    });

  const insert = (row: typeof paymentTransactions.$inferInsert) =>
    db().insert(paymentTransactions).values(row);

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    owner = await actors.signUp('m8t2-schema');
    accountId = await actors.accountIdOf(owner);
    const [plan] = await db()
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.slug, 'starter'));
    planId = plan!.id;
    const start = new Date();
    const [sub] = await db()
      .insert(subscriptions)
      .values({
        billingAccountId: accountId,
        planId,
        interval: 'month',
        status: 'ACTIVE',
        startedAt: start,
        currentTermStart: start,
        currentTermEnd: new Date(start.getTime() + 30 * 86_400_000),
        pricePerMonthBdt: 499,
        chargedBdt: 499,
      })
      .returning({ id: subscriptions.id });
    subscriptionId = sub!.id;
  });

  afterAll(async () => {
    if (actors) {
      if (eventTranIds.length)
        await db()
          .delete(paymentEvents)
          .where(inArray(paymentEvents.tranId, eventTranIds));
      await db()
        .delete(paymentEvents)
        .where(sql`tran_id is null and outcome = 'M8T2_TEST'`);
      await actors.cleanup();
    }
    await app?.close();
  });

  it('migration 0039 is applied', async () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../drizzle/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain('0039_payments');
    const result = await db().execute<{ applied: number }>(
      sql`select count(*)::int as applied from drizzle.__drizzle_migrations`,
    );
    expect(result.rows[0]?.applied).toBe(journal.entries.length);
  });

  describe('payment_transactions', () => {
    it('accepts a PENDING row (status defaults to PENDING)', async () => {
      const [row] = await db()
        .insert(paymentTransactions)
        .values(pendingRow())
        .returning();
      expect(row).toMatchObject({
        status: 'PENDING',
        paidAt: null,
        invoiceNumber: null,
        price: PRICE,
      });
    });

    it('accepts PAID (SSLCommerz, risky) and REFUNDED rows with their payment facts', async () => {
      expect(await pgCode(insert(paidRow({ riskLevel: 1 })))).toBeUndefined();
      expect(
        await pgCode(insert(paidRow({ status: 'REFUNDED' }))),
      ).toBeUndefined();
    });

    it('accepts a ৳0 PROMOTION row paid without val_id', async () => {
      expect(
        await pgCode(
          insert(
            paidRow({
              gateway: 'PROMOTION',
              amountBdt: 0,
              valId: null,
              bankTranId: null,
              cardType: null,
              riskLevel: null,
            }),
          ),
        ),
      ).toBeUndefined();
    });

    it.each<[string, Partial<typeof paymentTransactions.$inferInsert>]>([
      ['PAID without paid_at', { paidAt: null }],
      ['PAID without invoice number', { invoiceNumber: null }],
      ['PAID without subscription', { subscriptionId: null }],
      ['PAID without term (M8-T7)', { termStart: null, termEnd: null }],
      ['PAID with a half term', { termEnd: null }],
      [
        'PAID with term end before start',
        { termEnd: new Date(Date.now() - 120_000) },
      ],
      ['PAID via SSLCommerz without val_id', { valId: null }],
      ['REFUNDED without paid_at', { status: 'REFUNDED', paidAt: null }],
      ['bad invoice number', { invoiceNumber: 'SC-26-00001' }],
      ['PROMOTION with an amount', { gateway: 'PROMOTION', valId: null }],
      ['PROMOTION with a val_id', { gateway: 'PROMOTION', amountBdt: 0 }],
      ['negative risk level', { riskLevel: -1 }],
    ])('refuses %s', async (_label, patch) => {
      expect(await pgCode(insert(paidRow(patch)))).toBe(CHECK_VIOLATION);
    });

    it.each<[string, Partial<typeof paymentTransactions.$inferInsert>]>([
      ['PENDING with paid_at', { paidAt: new Date() }],
      ['PENDING with an invoice number', { invoiceNumber: 'SC-2026-00001' }],
      [
        'FAILED with a subscription + payment facts',
        {
          status: 'FAILED',
          paidAt: new Date(),
          invoiceNumber: 'SC-2026-00002',
          subscriptionId: UNKNOWN_ID,
        },
      ],
      ['negative amount', { amountBdt: -1 }],
      ['bad interval', { interval: 'week' as 'month' }],
      ['bad kind', { kind: 'TOPUP' as 'NEW' }],
      ['bad status', { status: 'SUCCESS' as 'PAID' }],
      ['bad gateway', { gateway: 'BKASH' as 'SSLCOMMERZ' }],
      ['tran_id over 30 chars', { tranId: 'T'.repeat(31) }],
      ['tran_id under 8 chars', { tranId: 'T1234' }],
      ['tran_id with spaces', { tranId: 'T 1234567' }],
      ['non-object price', { price: [] as unknown as PaymentPrice }],
    ])('refuses %s', async (_label, patch) => {
      expect(await pgCode(insert(pendingRow(patch)))).toBe(CHECK_VIOLATION);
    });

    it('tran_id is unique', async () => {
      const row = pendingRow();
      await insert(row);
      expect(await pgCode(insert({ ...row }))).toBe(UNIQUE_VIOLATION);
    });

    it('invoice number is unique', async () => {
      const row = paidRow();
      await insert(row);
      expect(
        await pgCode(insert(paidRow({ invoiceNumber: row.invoiceNumber }))),
      ).toBe(UNIQUE_VIOLATION);
    });

    it.each<[string, Partial<typeof paymentTransactions.$inferInsert>]>([
      ['account', { billingAccountId: UNKNOWN_ID }],
      ['workspace', { workspaceId: UNKNOWN_ID }],
      ['user', { userId: UNKNOWN_ID }],
      ['plan', { planId: UNKNOWN_ID }],
    ])('rejects an unknown %s (FK)', async (_label, patch) => {
      expect(await pgCode(insert(pendingRow(patch)))).toBe(FK_VIOLATION);
    });

    it('FK restrict: the subscription and account outlive no payment (delete payments first)', async () => {
      expect(
        await pgCode(
          db()
            .delete(subscriptions)
            .where(eq(subscriptions.id, subscriptionId)),
        ),
      ).toBe(FK_VIOLATION);
      expect(
        await pgCode(
          db().delete(billingAccounts).where(eq(billingAccounts.id, accountId)),
        ),
      ).toBe(FK_VIOLATION);
      expect(await pgCode(db().delete(plans).where(eq(plans.id, planId)))).toBe(
        FK_VIOLATION,
      );
    });

    it('D8 numbering from payment_invoice_number_seq matches SC-YYYY-NNNNN', async () => {
      const result = await db().execute<{ invoice: string }>(sql`
        with n as (select nextval('payment_invoice_number_seq') as n)
        select 'SC-' || to_char(timestamptz '2026-12-31T19:00:00Z' at time zone 'Asia/Dhaka', 'YYYY')
          || '-' || lpad(n::text, greatest(5, length(n::text)), '0') as invoice from n`);
      const invoice = result.rows[0]!.invoice;
      expect(invoice).toMatch(new RegExp(INVOICE_NUMBER_PATTERN));
      // 19:00 UTC on 31 Dec = 01:00 on 1 Jan in Dhaka.
      expect(invoice.startsWith('SC-2027-')).toBe(true);
    });
  });

  describe('payment_events', () => {
    const event = (
      patch: Partial<typeof paymentEvents.$inferInsert> = {},
    ): typeof paymentEvents.$inferInsert => {
      const id = `E${tag}${seq++}`;
      eventTranIds.push(id);
      return {
        tranId: id,
        source: 'IPN',
        outcome: 'AMOUNT_MISMATCH',
        ...patch,
      };
    };

    it('logs unknown and missing tran_ids (no FK)', async () => {
      const [row] = await db()
        .insert(paymentEvents)
        .values(event())
        .returning();
      expect(row?.receivedAt).toBeInstanceOf(Date);
      expect(
        await pgCode(
          db()
            .insert(paymentEvents)
            .values({ tranId: null, source: 'FAIL', outcome: 'M8T2_TEST' }),
        ),
      ).toBeUndefined();
    });

    it.each<[string, Partial<typeof paymentEvents.$inferInsert>]>([
      ['bad source', { source: 'WEBHOOK' as 'IPN' }],
      ['lower-case outcome', { outcome: 'paid' }],
      ['empty outcome', { outcome: '' }],
      ['empty tran_id', { tranId: '' }],
      ['tran_id over 64 chars', { tranId: 'x'.repeat(65) }],
    ])('refuses %s', async (_label, patch) => {
      expect(
        await pgCode(db().insert(paymentEvents).values(event(patch))),
      ).toBe(CHECK_VIOLATION);
    });
  });
});

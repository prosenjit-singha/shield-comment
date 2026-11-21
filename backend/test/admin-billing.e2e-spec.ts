import type { INestApplication } from '@nestjs/common';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import type {
  AdminTransactionDetail,
  PaymentEventList,
  TransactionList,
} from '../src/admin/dto/billing-transactions.dto.js';
import {
  paymentEvents,
  paymentRefunds,
  paymentTransactions,
  plans,
  subscriptions,
  workspaces,
} from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const TRANSACTIONS = '/api/admin/billing/transactions';
const EVENTS = '/api/admin/billing/events';

/**
 * M2-T9 + M8-T2: `GET /api/admin/billing/transactions` = `payment_transactions`, newest first, with
 * workspace + plan names and the gateway label (`gatewayLabel()`), final M2-T9 shape.
 */
describe('Admin billing transactions (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const http = () => actors.http();

  let superAdmin: Actor;
  let client: Actor;

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    superAdmin = await actors.signUpSuperAdmin('m2t9-super');
    client = await actors.signUp('m2t9-client');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('access', () => {
    it('401 when signed out', async () => {
      const res = await http().get(TRANSACTIONS).expect(401);
      expect(res.body).toMatchObject({ statusCode: 401, path: TRANSACTIONS });
    });

    it('403 for a normal user (workspace owner)', async () => {
      const res = await http()
        .get(TRANSACTIONS)
        .set('Cookie', client.cookie)
        .expect(403);
      expect(res.body).toMatchObject({ message: 'Super admin only' });
    });

    it('403 for impersonated sessions (super admin or client)', async () => {
      const adminCookie = await actors.signIn(superAdmin.email);
      await actors.patchStoredSession(adminCookie, {
        impersonatedBy: superAdmin.id,
      });
      const ownerCookie = await actors.signIn(client.email);
      await actors.patchStoredSession(ownerCookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: client.workspaceId,
      });
      for (const cookie of [adminCookie, ownerCookie]) {
        await http().get(TRANSACTIONS).set('Cookie', cookie).expect(403);
      }
    });

    it('M8-T8 routes are super admin only too', async () => {
      const id = '01900000-0000-7000-8000-000000000000';
      for (const [method, path] of [
        ['get', EVENTS],
        ['get', `${TRANSACTIONS}/${id}`],
        ['post', `${TRANSACTIONS}/${id}/refund`],
      ] as const) {
        await http()[method](path).expect(401);
        const res = await http()
          [method](path)
          .set('Cookie', client.cookie)
          .send({ reason: 'x' })
          .expect(403);
        expect(res.body).toMatchObject({ message: 'Super admin only' });
      }
    });
  });

  describe('list', () => {
    async function list(query: string) {
      const res = await http()
        .get(`${TRANSACTIONS}${query ? `?${query}` : ''}`)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      return res.body as TransactionList;
    }

    it('defaults to skip 0, take 50 with an empty list', async () => {
      expect(await list('')).toEqual({
        items: [],
        total: 0,
        skip: 0,
        take: 50,
      });
    });

    it.each([
      ['skip=0&take=1', 0, 1],
      ['skip=40&take=20', 40, 20],
      ['take=100', 0, 100],
    ])('echoes paging for %s', async (query, skip, take) => {
      expect(await list(query)).toEqual({ items: [], total: 0, skip, take });
    });

    describe('with payments', () => {
      const tag = String(Date.now()).slice(-8);
      const base = Date.parse('2026-11-21T06:00:00.000Z');
      let plan: { id: string; name: string };
      let workspace: { id: string; name: string };
      /** Inserted oldest → newest: [tranId, status, gateway, cardType, amount]. */
      const rows = [
        ['M8T2A', 'PENDING', 'SSLCOMMERZ', null, 499],
        ['M8T2B', 'PAID', 'SSLCOMMERZ', 'BKASH-BKash', 499],
        ['M8T2C', 'FAILED', 'SSLCOMMERZ', 'NAGAD-Nagad', 499],
        ['M8T2D', 'CANCELLED', 'SSLCOMMERZ', null, 5388],
        ['M8T2E', 'REFUNDED', 'SSLCOMMERZ', 'VISA-Dutch Bangla', 499],
        ['M8T2F', 'PAID', 'PROMOTION', null, 0],
        ['M8T2G', 'PAID', 'SSLCOMMERZ', 'MASTER-Brac bank', 1499],
      ] as const;

      beforeAll(async () => {
        const db = actors.db;
        const accountId = await actors.accountIdOf(client);
        const [p] = await db
          .select({ id: plans.id, name: plans.name })
          .from(plans)
          .where(eq(plans.slug, 'starter'));
        plan = p!;
        const [w] = await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, client.workspaceId));
        workspace = w!;
        const start = new Date(base);
        const [sub] = await db
          .insert(subscriptions)
          .values({
            billingAccountId: accountId,
            planId: plan.id,
            interval: 'month',
            status: 'ACTIVE',
            startedAt: start,
            currentTermStart: start,
            currentTermEnd: new Date(base + 30 * 86_400_000),
            pricePerMonthBdt: 499,
            chargedBdt: 499,
          })
          .returning({ id: subscriptions.id });
        await db.insert(paymentTransactions).values(
          rows.map(([tranId, status, gateway, cardType, amountBdt], i) => {
            const settled = status === 'PAID' || status === 'REFUNDED';
            return {
              billingAccountId: accountId,
              workspaceId: client.workspaceId,
              userId: client.id,
              planId: plan.id,
              interval: 'month' as const,
              kind: 'NEW' as const,
              tranId: `${tranId}${tag}`,
              amountBdt,
              status,
              gateway,
              cardType,
              valId: settled && gateway === 'SSLCOMMERZ' ? `VAL${i}` : null,
              paidAt: settled ? new Date(base + i * 60_000) : null,
              subscriptionId: settled ? sub!.id : null,
              termStart: settled ? start : null,
              termEnd: settled ? new Date(base + 30 * 86_400_000) : null,
              invoiceNumber: settled ? `SC-2026-${tag}${i}` : null,
              price: {
                listChargedBdt: amountBdt,
                chargedBdt: amountBdt,
                perMonthBdt: amountBdt,
                discount: null,
                coupon: null,
                creditBdt: 0,
              },
              createdAt: new Date(base + i * 60_000),
              // D10: G was activated with risk_level 1.
              riskLevel: tranId === 'M8T2G' ? 1 : 0,
            };
          }),
        );
        subscriptionId = sub!.id;
      });

      let subscriptionId: string;
      const tran = (id: string) => `${id}${tag}`;
      const tranIds = (page: TransactionList) =>
        page.items.map((r) => r.tranId.slice(0, 5));
      async function idOf(tranId: string) {
        const [row] = await actors.db
          .select({ id: paymentTransactions.id })
          .from(paymentTransactions)
          .where(eq(paymentTransactions.tranId, tran(tranId)));
        return row!.id;
      }

      it('lists every row newest first with names, status and gateway labels', async () => {
        const page = await list('');
        expect(page.total).toBe(rows.length);
        expect(page.items).toEqual(
          [
            ['M8T2G', 'PAID', 'Mastercard', 1499],
            ['M8T2F', 'PAID', 'PROMOTION', 0],
            ['M8T2E', 'REFUNDED', 'Visa', 499],
            ['M8T2D', 'CANCELLED', 'SSLCommerz', 5388],
            ['M8T2C', 'FAILED', 'Nagad', 499],
            ['M8T2B', 'PAID', 'bKash', 499],
            ['M8T2A', 'PENDING', 'SSLCommerz', 499],
          ].map(([tranId, status, gateway, amountBdt], j) => ({
            id: expect.any(String),
            workspace,
            plan,
            amountBdt,
            gateway,
            status,
            tranId: `${tranId as string}${tag}`,
            createdAt: new Date(
              base + (rows.length - 1 - j) * 60_000,
            ).toISOString(),
            riskFlagged: tranId === 'M8T2G',
            invoiceNumber: ['PAID', 'REFUNDED'].includes(status as string)
              ? `SC-2026-${tag}${rows.length - 1 - j}`
              : null,
          })),
        );
      });

      it('pages with skip/take (total counts every row)', async () => {
        const page = await list('skip=2&take=3');
        expect(page).toMatchObject({ total: rows.length, skip: 2, take: 3 });
        expect(page.items.map((r) => r.tranId)).toEqual(
          ['M8T2E', 'M8T2D', 'M8T2C'].map((t) => `${t}${tag}`),
        );
        expect((await list('skip=7&take=5')).items).toEqual([]);
      });

      it.each([
        ['status=PAID', ['M8T2G', 'M8T2F', 'M8T2B']],
        ['status=PENDING', ['M8T2A']],
        ['gateway=bKash', ['M8T2B']],
        ['gateway=Mastercard', ['M8T2G']],
        ['gateway=SSLCommerz', ['M8T2D', 'M8T2A']],
        ['gateway=PROMOTION', ['M8T2F']],
        ['gateway=bkash', []],
        ['status=PAID&gateway=Visa', []],
        ['status=REFUNDED&gateway=Visa', ['M8T2E']],
        ['q=m8t2c', ['M8T2C']],
        ['q=%25', []],
        ['q=nobody-matches', []],
        // Payment times: Dhaka 2026-11-21 12:00–12:06.
        [
          'from=2026-11-21&to=2026-11-21',
          ['M8T2G', 'M8T2F', 'M8T2E', 'M8T2D', 'M8T2C', 'M8T2B', 'M8T2A'],
        ],
        ['to=2026-11-20', []],
        ['from=2026-11-22', []],
        ['from=2026-11-21&status=FAILED&q=M8T2', ['M8T2C']],
      ])('filters %s', async (query, expected) => {
        const page = await list(query);
        expect(tranIds(page)).toEqual(expected);
        expect(page.total).toBe(expected.length);
      });

      it('q matches the workspace name and the payer name / email', async () => {
        for (const q of [
          workspace.name,
          client.email.toUpperCase(),
          'm2t9-client',
        ])
          expect((await list(`q=${encodeURIComponent(q)}`)).total).toBe(
            rows.length,
          );
      });

      it('400 when from is after to', async () => {
        await http()
          .get(`${TRANSACTIONS}?from=2026-11-22&to=2026-11-21`)
          .set('Cookie', superAdmin.cookie)
          .expect(400);
      });

      describe('events', () => {
        const at = (min: number) => new Date(base + 600_000 + min * 60_000);
        /** [tranId (null = none, U = unknown), source, outcome], oldest first. */
        const events = [
          ['M8T2B', 'IPN', 'PAID'],
          ['M8T2B', 'SUCCESS', 'ALREADY_PAID'],
          ['M8T2C', 'FAIL', 'FAILED'],
          ['M8T2D', 'CANCEL', 'CANCELLED'],
          ['U', 'IPN', 'UNKNOWN_TRAN_ID'],
          ['M8T2A', 'IPN', 'AMOUNT_MISMATCH'],
          ['M8T2G', 'IPN', 'PAID_DUPLICATE_CLAIM'],
          ['M8T2A', 'IPN', 'ACTIVATION_FAILED'],
          [null, 'IPN', 'BAD_SIGNATURE'],
          ['M8T2C', 'FAIL', 'NOT_PENDING'],
        ] as const;
        const unknown = `UNKNOWN${tag}`;
        const tranOf = (t: string | null) =>
          t === null ? null : t === 'U' ? unknown : tran(t);

        beforeAll(async () => {
          await actors.db.insert(paymentEvents).values(
            events.map(([t, source, outcome], i) => ({
              tranId: tranOf(t),
              source,
              outcome,
              receivedAt: at(i),
            })),
          );
        });

        afterAll(async () => {
          // Events without a matching transaction are not cleaned by the account cleanup.
          await actors.db
            .delete(paymentEvents)
            .where(
              or(
                isNull(paymentEvents.tranId),
                eq(paymentEvents.tranId, unknown),
              ),
            );
        });

        async function listEvents(query: string) {
          const res = await http()
            .get(`${EVENTS}${query ? `?${query}` : ''}`)
            .set('Cookie', superAdmin.cookie)
            .expect(200);
          return res.body as PaymentEventList;
        }

        it('outcome=failed: everything except PAID / ALREADY_PAID / FAILED / CANCELLED, newest first, linked to its transaction', async () => {
          const page = await listEvents('outcome=failed');
          const failed = events
            .map((e, i) => [e, i] as const)
            .filter(
              ([[, , o]]) =>
                !['PAID', 'ALREADY_PAID', 'FAILED', 'CANCELLED'].includes(o),
            )
            .reverse();
          expect(page).toMatchObject({
            total: failed.length,
            skip: 0,
            take: 50,
          });
          expect(page.items).toEqual(
            failed.map(([[t, source, outcome], i]) => ({
              id: expect.any(String) as string,
              tranId: tranOf(t),
              source,
              outcome,
              receivedAt: at(i).toISOString(),
              transaction:
                t === null || t === 'U'
                  ? null
                  : { id: expect.any(String) as string, workspace },
            })),
          );
          expect(page.items[0]!.outcome).toBe('NOT_PENDING');
          expect(page.items.map((e) => e.outcome)).toEqual(
            expect.arrayContaining([
              'PAID_DUPLICATE_CLAIM',
              'ACTIVATION_FAILED',
              'UNKNOWN_TRAN_ID',
              'BAD_SIGNATURE',
            ]),
          );
        });

        it('no outcome = every event; pages with skip/take', async () => {
          expect((await listEvents('')).total).toBe(events.length);
          const page = await listEvents('outcome=failed&skip=1&take=2');
          expect(page.items.map((e) => e.outcome)).toEqual([
            'BAD_SIGNATURE',
            'ACTIVATION_FAILED',
          ]);
          expect(page.total).toBe(6);
        });

        it.each([
          ['outcome=PAID'],
          ['outcome=all'],
          ['take=0'],
          ['source=IPN'],
        ])('400 for %s', async (query) => {
          await http()
            .get(`${EVENTS}?${query}`)
            .set('Cookie', superAdmin.cookie)
            .expect(400);
        });

        it('transaction sheet: payer, term, price lines, risk, its events oldest first', async () => {
          const res = await http()
            .get(`${TRANSACTIONS}/${await idOf('M8T2B')}`)
            .set('Cookie', superAdmin.cookie)
            .expect(200);
          const detail = res.body as AdminTransactionDetail;
          expect(detail).toMatchObject({
            tranId: tran('M8T2B'),
            status: 'PAID',
            gateway: 'bKash',
            riskFlagged: false,
            riskLevel: 0,
            invoiceNumber: `SC-2026-${tag}1`,
            kind: 'NEW',
            interval: 'month',
            user: { id: client.id, email: client.email },
            paidAt: new Date(base + 60_000).toISOString(),
            term: {
              start: new Date(base).toISOString(),
              end: new Date(base + 30 * 86_400_000).toISOString(),
            },
            valId: 'VAL1',
            cardType: 'BKASH-BKash',
            listPriceBdt: 499,
            promotions: [],
            creditBdt: 0,
            refund: null,
          });
          expect(detail.events.map((e) => [e.source, e.outcome])).toEqual([
            ['IPN', 'PAID'],
            ['SUCCESS', 'ALREADY_PAID'],
          ]);
          const g = (
            await http()
              .get(`${TRANSACTIONS}/${await idOf('M8T2G')}`)
              .set('Cookie', superAdmin.cookie)
              .expect(200)
          ).body as AdminTransactionDetail;
          expect(g).toMatchObject({ riskFlagged: true, riskLevel: 1 });
        });

        it.each([['not-a-uuid'], ['01900000-0000-7000-8000-000000000000']])(
          'sheet 404 for %s',
          async (id) => {
            await http()
              .get(`${TRANSACTIONS}/${id}`)
              .set('Cookie', superAdmin.cookie)
              .expect(404);
          },
        );
      });

      describe('refund (D9)', () => {
        const refund = (id: string, body: unknown) =>
          http()
            .post(`${TRANSACTIONS}/${id}/refund`)
            .set('Cookie', superAdmin.cookie)
            .set('X-Forwarded-For', '198.51.100.66, 203.0.113.9')
            .set('User-Agent', 'm8t8-agent')
            .send(body as object);
        const refundRows = async () =>
          actors.db
            .select()
            .from(paymentRefunds)
            .where(
              inArray(
                paymentRefunds.paymentTransactionId,
                actors.db
                  .select({ id: paymentTransactions.id })
                  .from(paymentTransactions)
                  .where(
                    eq(paymentTransactions.workspaceId, client.workspaceId),
                  ),
              ),
            );

        it.each([
          ['no body', {}],
          ['blank reason', { reason: '   ' }],
          ['reason over 500', { reason: 'x'.repeat(501) }],
          ['non-string reason', { reason: 5 }],
          ['unknown field', { reason: 'ok', notify: true }],
        ])('400 for %s', async (_label, body) => {
          await refund(await idOf('M8T2B'), body).expect(400);
          expect(await refundRows()).toEqual([]);
        });

        it.each([['M8T2A'], ['M8T2C'], ['M8T2D'], ['M8T2E']])(
          '409 NOT_REFUNDABLE for %s (not PAID), no audit row',
          async (t) => {
            const res = await refund(await idOf(t), { reason: 'r' }).expect(
              409,
            );
            expect(res.body).toMatchObject({ code: 'NOT_REFUNDABLE' });
            expect(await refundRows()).toEqual([]);
          },
        );

        it('404 for an unknown or malformed id', async () => {
          await refund('01900000-0000-7000-8000-000000000000', {
            reason: 'r',
          }).expect(404);
          await refund('nope', { reason: 'r' }).expect(404);
        });

        it('PAID → REFUNDED: status only, settled facts + plan kept, one audit row; a second try is 409', async () => {
          const id = await idOf('M8T2G');
          const before = (
            await actors.db
              .select()
              .from(paymentTransactions)
              .where(eq(paymentTransactions.id, id))
          )[0]!;
          const [subBefore] = await actors.db
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.id, subscriptionId));
          const res = await refund(id, {
            reason: '  Refunded in the merchant panel  ',
          }).expect(200);
          expect(res.body).toMatchObject({
            id,
            status: 'REFUNDED',
            invoiceNumber: before.invoiceNumber,
            refund: {
              admin: { id: superAdmin.id },
              reason: 'Refunded in the merchant panel',
              createdAt: expect.any(String) as string,
            },
          });
          const after = (
            await actors.db
              .select()
              .from(paymentTransactions)
              .where(eq(paymentTransactions.id, id))
          )[0]!;
          expect(after).toEqual({
            ...before,
            status: 'REFUNDED',
            updatedAt: expect.any(Date) as Date,
          });
          const [subAfter] = await actors.db
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.id, subscriptionId));
          expect(subAfter).toEqual(subBefore);
          expect(await refundRows()).toEqual([
            {
              id: expect.any(String) as string,
              paymentTransactionId: id,
              adminId: superAdmin.id,
              reason: 'Refunded in the merchant panel',
              ipAddress: '203.0.113.9',
              userAgent: 'm8t8-agent',
              createdAt: expect.any(Date) as Date,
            },
          ]);
          // Listed as REFUNDED; a second mark is refused and writes nothing.
          expect(tranIds(await list('status=REFUNDED'))).toEqual([
            'M8T2G',
            'M8T2E',
          ]);
          await refund(id, { reason: 'again' }).expect(409);
          expect(await refundRows()).toHaveLength(1);
          const sheet = (
            await http()
              .get(`${TRANSACTIONS}/${id}`)
              .set('Cookie', superAdmin.cookie)
              .expect(200)
          ).body as AdminTransactionDetail;
          expect(sheet.refund?.reason).toBe('Refunded in the merchant panel');
          // A ৳0 PROMOTION row is PAID too: it can be marked as well.
          await refund(await idOf('M8T2F'), { reason: 'void' }).expect(200);
          expect(
            await actors.db
              .select({ status: paymentTransactions.status })
              .from(paymentTransactions)
              .where(and(eq(paymentTransactions.id, await idOf('M8T2F')))),
          ).toEqual([{ status: 'REFUNDED' }]);
        });
      });
    });

    it.each([
      ['negative skip', 'skip=-1'],
      ['fractional skip', 'skip=1.5'],
      ['non-numeric skip', 'skip=abc'],
      ['take 0', 'take=0'],
      ['take over 100', 'take=101'],
      ['non-numeric take', 'take=ten'],
      ['unknown parameter', 'workspaceId=x'],
      ['unknown parameter with valid paging', 'skip=0&take=10&sort=newest'],
      ['unknown status', 'status=paid'],
      ['impossible date', 'from=2026-02-30'],
      ['date-time instead of a date', 'to=2026-11-21T00:00:00Z'],
    ])('400 for %s', async (_label, query) => {
      const res = await http()
        .get(`${TRANSACTIONS}?${query}`)
        .set('Cookie', superAdmin.cookie)
        .expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    });
  });
});

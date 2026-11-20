import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import type { TransactionList } from '../src/admin/dto/billing-transactions.dto.js';
import {
  paymentTransactions,
  plans,
  subscriptions,
  workspaces,
} from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const TRANSACTIONS = '/api/admin/billing/transactions';

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
            };
          }),
        );
      });

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
    });

    it.each([
      ['negative skip', 'skip=-1'],
      ['fractional skip', 'skip=1.5'],
      ['non-numeric skip', 'skip=abc'],
      ['take 0', 'take=0'],
      ['take over 100', 'take=101'],
      ['non-numeric take', 'take=ten'],
      ['unknown parameter', 'status=PAID'],
      ['unknown parameter with valid paging', 'skip=0&take=10&gateway=bkash'],
    ])('400 for %s', async (_label, query) => {
      const res = await http()
        .get(`${TRANSACTIONS}?${query}`)
        .set('Cookie', superAdmin.cookie)
        .expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    });
  });
});

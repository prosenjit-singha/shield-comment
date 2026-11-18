import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import type { TransactionList } from '../src/admin/dto/billing-transactions.dto.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const TRANSACTIONS = '/api/admin/billing/transactions';

/**
 * M2-T9: `GET /api/admin/billing/transactions`. No payments table until Module 8 (SSLCommerz), so
 * the list is empty but carries its final paging shape (user decision 2026-11-18).
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

import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import type { SystemHealthResponse } from '../src/admin/dto/system-health.dto.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const HEALTH = '/api/admin/system/health';

/**
 * M2-T10: `GET /api/admin/system/health` (A6). DB + Redis probes, process info, queue counts
 * (`[]` until BullMQ queues exist) and the latest applied Drizzle migration (user decision
 * 2026-11-18). The e2e app stubs Redis, so only the shape of its probe is checked.
 */
describe('Admin system health (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const http = () => actors.http();

  let superAdmin: Actor;
  let client: Actor;

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    superAdmin = await actors.signUpSuperAdmin('m2t10-super');
    client = await actors.signUp('m2t10-client');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('access', () => {
    it('401 when signed out', async () => {
      const res = await http().get(HEALTH).expect(401);
      expect(res.body).toMatchObject({ statusCode: 401, path: HEALTH });
    });

    it('403 for a normal user (workspace owner)', async () => {
      const res = await http()
        .get(HEALTH)
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
        await http().get(HEALTH).set('Cookie', cookie).expect(403);
      }
    });
  });

  describe('report', () => {
    let body: SystemHealthResponse;

    beforeAll(async () => {
      const res = await http()
        .get(HEALTH)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      body = res.body as SystemHealthResponse;
    });

    it('has exactly the documented top-level keys', () => {
      expect(Object.keys(body).sort()).toEqual(
        [
          'checkedAt',
          'database',
          'migrations',
          'process',
          'queues',
          'redis',
          'status',
        ].sort(),
      );
      expect(['ok', 'degraded']).toContain(body.status);
      expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    });

    it('reports the test database up with a latency', () => {
      expect(body.database.status).toBe('up');
      expect(body.database.latencyMs).toBeTypeOf('number');
      expect(['up', 'down']).toContain(body.redis.status);
    });

    it('reports process info', () => {
      const p = body.process;
      expect(p.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(p.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(p.nodeVersion).toBe(process.version);
      expect(p.environment).toBe('test');
      expect(p.memory.rssBytes).toBeGreaterThan(0);
      expect(p.memory.heapUsedBytes).toBeGreaterThan(0);
      expect(p.memory.heapTotalBytes).toBeGreaterThanOrEqual(
        p.memory.heapUsedBytes,
      );
      expect(Date.parse(p.startedAt)).toBeLessThanOrEqual(
        Date.parse(body.checkedAt),
      );
    });

    it('returns an empty queue list until BullMQ queues exist', () => {
      expect(body.queues).toEqual([]);
    });

    it('reports the latest applied migration (test DB is fully migrated)', () => {
      const m = body.migrations;
      expect(m.known).toBe(true);
      expect(m.applied).toBeGreaterThan(0);
      expect(m.applied).toBe(m.shipped);
      expect(m.pending).toBe(0);
      expect(m.latest?.tag).toMatch(/^\d{4}_/);
      expect(m.latest?.hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it.each([['refresh=1'], ['skip=0'], ['queue=moderation']])(
    '400 for unknown query param %s',
    async (query) => {
      const res = await http()
        .get(`${HEALTH}?${query}`)
        .set('Cookie', superAdmin.cookie)
        .expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    },
  );
});

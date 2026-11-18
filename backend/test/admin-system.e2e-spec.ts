import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import type { SystemHealthResponse } from '../src/admin/dto/system-health.dto.js';
import { ALL_QUEUE_NAMES, QUEUE_NAMES } from '../src/queue/queue.constants.js';
import { QueueRegistry } from '../src/queue/queue.registry.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { FakeQueue, fakeQueue } from './utils/fake-queue.js';

const HEALTH = '/api/admin/system/health';

/**
 * M2-T10: `GET /api/admin/system/health` (A6). DB + Redis probes, process info, queue counts
 * and the latest applied Drizzle migration (user decision 2026-11-18). The e2e app stubs Redis, so
 * only the shape of its probe is checked. M4-T1: the three D3 queues report BullMQ counts; here
 * they come from the in-memory `FakeQueue`s (no Redis).
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
      fakeQueue(app, QUEUE_NAMES.commentIngest).setCounts({
        waiting: 4,
        active: 1,
      });
      fakeQueue(app, QUEUE_NAMES.metaTokenCheck).setCounts({ failed: 2 });
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

    it('lists the three D3 queues with their counts (from the fake queues)', () => {
      expect(body.queues).toEqual([
        { name: 'comment-ingest', waiting: 4, active: 1, failed: 0 },
        { name: 'comment-moderation', waiting: 0, active: 0, failed: 0 },
        { name: 'meta-token-check', waiting: 0, active: 0, failed: 2 },
      ]);
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

  describe('queues', () => {
    beforeEach(() => {
      for (const name of ALL_QUEUE_NAMES) fakeQueue(app, name).reset();
    });

    it('uses in-memory fakes for every queue (no Redis connection in e2e)', () => {
      const registry = app.get(QueueRegistry);
      for (const { queue } of registry.all()) {
        expect(queue).toBeInstanceOf(FakeQueue);
      }
    });

    it('counts added jobs as waiting; a duplicate jobId is not counted twice', async () => {
      const ingest = fakeQueue(app, QUEUE_NAMES.commentIngest);
      await ingest.add('comment', { n: 1 }, { jobId: 'FACEBOOK:1_2:add' });
      await ingest.add('comment', { n: 1 }, { jobId: 'FACEBOOK:1_2:add' });
      await ingest.add('comment', { n: 2 }, { jobId: 'FACEBOOK:1_3:add' });
      const res = await http()
        .get(HEALTH)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      const body = res.body as SystemHealthResponse;
      expect(body.queues[0]).toEqual({
        name: 'comment-ingest',
        waiting: 2,
        active: 0,
        failed: 0,
      });
      expect(ingest.jobs[0]?.opts).toMatchObject({
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      });
    });

    it('a queue whose counts fail is left out and the endpoint stays 200', async () => {
      fakeQueue(app, QUEUE_NAMES.commentModeration).failCounts(
        new Error('Connection is closed.'),
      );
      const res = await http()
        .get(HEALTH)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      const body = res.body as SystemHealthResponse;
      expect(body.queues.map((q) => q.name)).toEqual([
        'comment-ingest',
        'meta-token-check',
      ]);
    });

    it('every queue failing (Redis down) → empty list, still 200', async () => {
      for (const name of ALL_QUEUE_NAMES) {
        fakeQueue(app, name).failCounts(new Error('ECONNREFUSED'));
      }
      const res = await http()
        .get(HEALTH)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      expect((res.body as SystemHealthResponse).queues).toEqual([]);
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

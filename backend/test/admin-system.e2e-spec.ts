import type { INestApplication } from '@nestjs/common';
import { and, between, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { AdminSystemService } from '../src/admin/admin-system.service.js';
import type { SystemHealthResponse } from '../src/admin/dto/system-health.dto.js';
import { dailyAiUsage } from '../src/db/schema/index.js';
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
          'ai',
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

    it('lists the D3 queues + billing with their counts (from the fake queues)', () => {
      expect(body.queues).toEqual([
        { name: 'comment-ingest', waiting: 4, active: 1, failed: 0 },
        { name: 'comment-moderation', waiting: 0, active: 0, failed: 0 },
        { name: 'meta-token-check', waiting: 0, active: 0, failed: 2 },
        { name: 'billing', waiting: 0, active: 0, failed: 0 },
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
        'billing',
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

  /**
   * M5-T13 (D14): `ai` = platform-wide `daily_ai_usage`, today + last 7 Dhaka days. The clock is
   * pinned to 2031 so only this spec's rows (unique model names, deleted in `afterAll`) are read.
   */
  describe('ai (M5-T13)', () => {
    const MODEL_PRICED = 'gpt-4.1-mini';
    const MODEL_UNKNOWN = 'm5t13-e2e-model';
    const DAYS = { from: '2031-03-01', to: '2031-03-31' };
    let service: AdminSystemService;
    const realNow = () => new Date();

    const cleanup = () =>
      actors.db
        .delete(dailyAiUsage)
        .where(
          and(
            between(dailyAiUsage.day, DAYS.from, DAYS.to),
            inArray(dailyAiUsage.model, [MODEL_PRICED, MODEL_UNKNOWN]),
          ),
        );

    const health = async (cookie = superAdmin.cookie) =>
      (await http().get(HEALTH).set('Cookie', cookie).expect(200))
        .body as SystemHealthResponse;

    beforeAll(async () => {
      service = app.get(AdminSystemService);
      await cleanup();
      const base = {
        inputTokens: 0,
        outputTokens: 0,
        credits: 0,
        failedCalls: 0,
        failuresByKind: {},
        latencyMsSum: 0,
        latencyMsMax: 0,
      };
      await actors.db.insert(dailyAiUsage).values([
        // Today (Dhaka 2031-03-10).
        {
          ...base,
          day: '2031-03-10',
          provider: 'openai',
          model: MODEL_PRICED,
          calls: 10,
          inputTokens: 1_000_000,
          outputTokens: 250_000,
          credits: 12,
          failedCalls: 2,
          failuresByKind: { timeout: 1, rate_limited: 1 },
          latencyMsSum: 6000,
          latencyMsMax: 1400,
        },
        {
          ...base,
          day: '2031-03-10',
          provider: 'neon',
          model: MODEL_UNKNOWN,
          calls: 4,
          inputTokens: 4000,
          outputTokens: 800,
          credits: 4,
          failedCalls: 1,
          failuresByKind: { timeout: 1 },
          latencyMsSum: 2000,
          latencyMsMax: 700,
        },
        // First day of the 7-day window.
        {
          ...base,
          day: '2031-03-04',
          provider: 'openai',
          model: MODEL_PRICED,
          calls: 2,
          inputTokens: 1000,
          outputTokens: 100,
          credits: 2,
          latencyMsSum: 1000,
          latencyMsMax: 600,
        },
        // Outside both windows.
        {
          ...base,
          day: '2031-03-03',
          provider: 'openai',
          model: MODEL_PRICED,
          calls: 99,
          inputTokens: 99_000,
        },
      ]);
    });

    afterEach(() => {
      service.now = realNow;
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await cleanup();
    });

    it('today + last 7 Dhaka days per provider + model, with estimated cost USD + BDT', async () => {
      // 23:59 Dhaka on 2031-03-10.
      service.now = () => new Date('2031-03-10T17:59:00.000Z');
      const { ai } = await health();
      expect(ai).not.toBeNull();
      const rate = ai!.usdToBdtRate;
      expect(rate).toBeGreaterThan(0);
      expect(ai!.timezone).toBe('Asia/Dhaka');
      expect(ai!.today).toMatchObject({ from: '2031-03-10', to: '2031-03-10' });
      expect(ai!.last7Days).toMatchObject({
        from: '2031-03-04',
        to: '2031-03-10',
      });

      const priced = ai!.today.models.find((m) => m.model === MODEL_PRICED)!;
      const price = priced.priceUsdPer1M!;
      expect(price).toEqual({
        input: expect.any(Number) as number,
        output: expect.any(Number) as number,
      });
      const usd = (1_000_000 * price.input + 250_000 * price.output) / 1e6;
      expect(ai!.today.models).toEqual([
        {
          provider: 'neon',
          model: MODEL_UNKNOWN,
          calls: 4,
          failedCalls: 1,
          failuresByKind: { timeout: 1 },
          inputTokens: 4000,
          outputTokens: 800,
          credits: 4,
          avgLatencyMs: 500,
          maxLatencyMs: 700,
          estimatedCostUsd: null,
          estimatedCostBdt: null,
          priceUsdPer1M: null,
        },
        {
          provider: 'openai',
          model: MODEL_PRICED,
          calls: 10,
          failedCalls: 2,
          failuresByKind: { rate_limited: 1, timeout: 1 },
          inputTokens: 1_000_000,
          outputTokens: 250_000,
          credits: 12,
          avgLatencyMs: 600,
          maxLatencyMs: 1400,
          estimatedCostUsd: Math.round(usd * 1e6) / 1e6,
          estimatedCostBdt:
            Math.round((usd * rate + Number.EPSILON) * 100) / 100,
          priceUsdPer1M: price,
        },
      ]);
      expect(ai!.today.totals).toMatchObject({
        calls: 14,
        failedCalls: 3,
        failuresByKind: { rate_limited: 1, timeout: 2 },
        inputTokens: 1_004_000,
        outputTokens: 250_800,
        credits: 16,
        avgLatencyMs: Math.round(8000 / 14),
        maxLatencyMs: 1400,
        estimatedCostUsd: Math.round(usd * 1e6) / 1e6,
        unpricedModels: 1,
      });
      expect(ai!.last7Days.totals).toMatchObject({
        calls: 16,
        inputTokens: 1_005_000,
        credits: 18,
        maxLatencyMs: 1400,
      });
      expect(
        ai!.last7Days.models.find((m) => m.model === MODEL_PRICED)?.calls,
      ).toBe(12);
    });

    it('the window moves at Dhaka midnight (2031-03-04 drops out)', async () => {
      service.now = () => new Date('2031-03-10T18:00:00.000Z');
      const { ai } = await health();
      expect(ai!.today.totals.calls).toBe(0);
      expect(ai!.today.models).toEqual([]);
      expect(ai!.today.totals.avgLatencyMs).toBeNull();
      expect(ai!.last7Days).toMatchObject({
        from: '2031-03-05',
        to: '2031-03-11',
      });
      expect(ai!.last7Days.totals.calls).toBe(14);
    });

    it('no usage in the window → zeros and no models', async () => {
      service.now = () => new Date('2031-06-01T06:00:00.000Z');
      const { ai } = await health();
      expect(ai!.last7Days.models).toEqual([]);
      expect(ai!.last7Days.totals).toMatchObject({
        calls: 0,
        estimatedCostUsd: 0,
        estimatedCostBdt: 0,
        unpricedModels: 0,
      });
    });

    it('a failing usage read → ai: null, still 200 with the other sections', async () => {
      vi.spyOn(service, 'aiUsageRows').mockRejectedValueOnce(
        new Error('relation "daily_ai_usage" does not exist'),
      );
      const body = await health();
      expect(body.ai).toBeNull();
      expect(body.database.status).toBe('up');
      expect(body.migrations.known).toBe(true);
    });

    it('403 for a normal user (no platform-wide AI usage for clients)', async () => {
      const res = await http()
        .get(HEALTH)
        .set('Cookie', client.cookie)
        .expect(403);
      expect(res.body).not.toHaveProperty('ai');
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

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import { MIGRATIONS_FOLDER } from '../db/migrator.js';
import { Logger } from '@nestjs/common';
import type { HealthReport, HealthService } from '../health/health.service.js';
import type { QueueRegistry } from '../queue/queue.registry.js';
import { AdminSystemService } from './admin-system.service.js';
import { SystemHealthQueryDto } from './dto/system-health.dto.js';
import {
  describeMigrations,
  describeProcess,
  parseJournal,
  parseVersion,
  queueStats,
  UNKNOWN_MIGRATIONS,
} from './system-health.js';

const JOURNAL = [
  { tag: '0000_init', when: 1000 },
  { tag: '0001_auth', when: 2000 },
  { tag: '0002_tickets', when: 3000 },
];

describe('SystemHealthQueryDto', () => {
  async function fields(plain: Record<string, unknown>) {
    const dto = plainToInstance(SystemHealthQueryDto, plain);
    // Nest's ValidationPipe sets `forbidUnknownValues: false`; class-validator's own default (true)
    // would reject every instance of a class without rules.
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: false,
    });
    return errors.map((e) => e.property);
  }

  it('accepts no params', async () => {
    expect(await fields({})).toEqual([]);
  });

  it('rejects any param', async () => {
    expect(await fields({ refresh: '1' })).toEqual(['refresh']);
  });
});

describe('parseJournal', () => {
  it('reads tag + when of each entry', () => {
    const text = JSON.stringify({
      entries: [
        { idx: 0, when: 1000, tag: '0000_init' },
        { idx: 1, when: 'x', tag: 'bad' },
        null,
      ],
    });
    expect(parseJournal(text)).toEqual([{ tag: '0000_init', when: 1000 }]);
  });

  it.each(['', 'not json', '[]', '{"entries":5}', 'null'])(
    'returns [] for %j',
    (text) => {
      expect(parseJournal(text)).toEqual([]);
    },
  );

  it('parses the real journal in drizzle/', () => {
    const journal = parseJournal(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    );
    expect(journal.length).toBeGreaterThan(0);
    expect(journal[0]?.tag).toBe('0000_init');
  });
});

describe('describeMigrations', () => {
  it('up to date: latest tag from the journal, 0 pending', () => {
    expect(
      describeMigrations(
        { applied: 3, latest: { hash: 'abc', createdAt: 3000 } },
        JOURNAL,
      ),
    ).toEqual({
      known: true,
      applied: 3,
      shipped: 3,
      pending: 0,
      latest: {
        tag: '0002_tickets',
        hash: 'abc',
        createdAt: new Date(3000).toISOString(),
      },
    });
  });

  it('counts shipped migrations newer than the latest applied as pending', () => {
    const status = describeMigrations(
      { applied: 1, latest: { hash: 'h', createdAt: 1000 } },
      JOURNAL,
    );
    expect(status.pending).toBe(2);
    expect(status.latest?.tag).toBe('0000_init');
  });

  it('nothing applied: everything pending, latest null', () => {
    expect(describeMigrations({ applied: 0, latest: null }, JOURNAL)).toEqual({
      known: true,
      applied: 0,
      shipped: 3,
      pending: 3,
      latest: null,
    });
  });

  it('DB ahead of the build: tag null, 0 pending', () => {
    const status = describeMigrations(
      { applied: 4, latest: { hash: 'new', createdAt: 4000 } },
      JOURNAL,
    );
    expect(status.pending).toBe(0);
    expect(status.latest?.tag).toBeNull();
  });
});

describe('describeProcess', () => {
  it('maps uptime, start time, memory and versions', () => {
    expect(
      describeProcess({
        uptimeSeconds: 90.7,
        memory: { rss: 100, heapUsed: 40, heapTotal: 60 },
        version: '1.2.3',
        nodeVersion: 'v24.1.0',
        environment: 'production',
        now: new Date('2026-11-18T10:00:00.000Z'),
      }),
    ).toEqual({
      uptimeSeconds: 90,
      startedAt: '2026-11-18T09:58:29.300Z',
      version: '1.2.3',
      nodeVersion: 'v24.1.0',
      environment: 'production',
      memory: { rssBytes: 100, heapUsedBytes: 40, heapTotalBytes: 60 },
    });
  });
});

describe('parseVersion', () => {
  it.each([
    ['{"version":"0.4.0"}', '0.4.0'],
    ['{"version":""}', '0.0.0'],
    ['{}', '0.0.0'],
    ['', '0.0.0'],
  ])('%j → %s', (text, expected) => {
    expect(parseVersion(text)).toBe(expected);
  });
});

describe('AdminSystemService', () => {
  type Counts = Record<string, number>;
  type GetJobCounts = (...types: string[]) => Promise<Counts>;

  function makeService(
    report: Partial<HealthReport>,
    execute: () => Promise<unknown>,
    queueCounts: Record<string, GetJobCounts> = {},
    options: {
      /** What `listDailyAiUsage` resolves to (default: no rows). */
      aiRows?: () => Promise<unknown[]>;
      env?: Record<string, unknown>;
    } = {},
  ) {
    const full: HealthReport = {
      status: 'ok',
      database: 'up',
      redis: 'up',
      latencyMs: { database: 1.5, redis: 0.4 },
      timestamp: '2026-11-18T10:00:00.000Z',
      ...report,
    };
    const health = {
      check: vi.fn(async () => full),
    } as unknown as HealthService;
    const exec = vi.fn(execute);
    const aiRows = vi.fn(options.aiRows ?? (async () => []));
    const aiWhere = vi.fn(() => ({ orderBy: () => aiRows() }));
    const db = {
      execute: exec,
      select: vi.fn(() => ({ from: () => ({ where: aiWhere }) })),
    } as unknown as Database;
    const env: Record<string, unknown> = {
      NODE_ENV: 'test',
      AI_COST_USD_TO_BDT: 122,
      ...options.env,
    };
    const config = {
      get: vi.fn((key: string) => env[key]),
    } as unknown as ConfigService<EnvironmentVariables, true>;
    const getJobCounts = Object.fromEntries(
      Object.entries(queueCounts).map(([name, fn]) => [
        name,
        vi.fn<GetJobCounts>(fn),
      ]),
    );
    const registry = {
      all: vi.fn(() =>
        Object.entries(getJobCounts).map(([name, fn]) => ({
          name,
          queue: { getJobCounts: fn },
        })),
      ),
    } as unknown as QueueRegistry;
    return {
      service: new AdminSystemService(health, db, config, registry),
      exec,
      getJobCounts,
      aiRows,
    };
  }

  const okMigrations = async () => ({
    rows: [{ applied: 1, hash: 'h0', created_at: '1794931785688' }],
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('queues: one row per registered queue, in registry order, from waiting/active/failed', async () => {
    const { service, getJobCounts } = makeService({}, okMigrations, {
      'comment-ingest': async () => ({ waiting: 3, active: 1, failed: 0 }),
      'comment-moderation': async () => ({ waiting: 0, active: 0, failed: 0 }),
      'meta-token-check': async () => ({ waiting: 0, active: 2, failed: 7 }),
    });
    const res = await service.health();
    expect(res.queues).toEqual([
      { name: 'comment-ingest', waiting: 3, active: 1, failed: 0 },
      { name: 'comment-moderation', waiting: 0, active: 0, failed: 0 },
      { name: 'meta-token-check', waiting: 0, active: 2, failed: 7 },
    ]);
    expect(getJobCounts['comment-ingest']).toHaveBeenCalledWith(
      'waiting',
      'active',
      'failed',
    );
  });

  it('queues: a failing count leaves that queue out, logs it, and the report still resolves', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { service } = makeService({ redis: 'down' }, okMigrations, {
      'comment-ingest': async () => ({ waiting: 1, active: 0, failed: 0 }),
      'comment-moderation': async () => {
        throw new Error('Connection is closed.');
      },
      'meta-token-check': async () => ({ waiting: 0, active: 0, failed: 2 }),
    });
    const res = await service.health();
    expect(res.status).toBe('degraded');
    expect(res.queues).toEqual([
      { name: 'comment-ingest', waiting: 1, active: 0, failed: 0 },
      { name: 'meta-token-check', waiting: 0, active: 0, failed: 2 },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'Queue counts unavailable: comment-moderation',
    );
  });

  it('queues: a hanging count (Redis down, commands queued) times out after 3 s → empty list', async () => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const hang = () => new Promise<Counts>(() => undefined);
    const { service } = makeService({}, okMigrations, {
      'comment-ingest': hang,
      'comment-moderation': hang,
      'meta-token-check': hang,
    });
    const pending = service.health();
    await vi.advanceTimersByTimeAsync(3000);
    const res = await pending;
    expect(res.queues).toEqual([]);
    expect(res.migrations.known).toBe(true);
  });

  it('ok: probes, process, no queues registered, latest migration from the DB row', async () => {
    const { service } = makeService({}, async () => ({
      rows: [{ applied: 1, hash: 'h0', created_at: '1794931785688' }],
    }));
    const res = await service.health();
    expect(res.status).toBe('ok');
    expect(res.checkedAt).toBe('2026-11-18T10:00:00.000Z');
    expect(res.database).toEqual({ status: 'up', latencyMs: 1.5 });
    expect(res.redis).toEqual({ status: 'up', latencyMs: 0.4 });
    expect(res.queues).toEqual([]);
    expect(res.process.environment).toBe('test');
    expect(res.process.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.migrations.known).toBe(true);
    expect(res.migrations.applied).toBe(1);
    expect(res.migrations.latest?.tag).toBe('0000_init');
    expect(res.migrations.pending).toBe(res.migrations.shipped - 1);
  });

  it('degraded without a migrations query when the DB is down', async () => {
    const { service, exec } = makeService(
      {
        status: 'error',
        database: 'down',
        latencyMs: { database: null, redis: 0.4 },
      },
      async () => ({ rows: [] }),
    );
    const res = await service.health();
    expect(res.status).toBe('degraded');
    expect(res.database).toEqual({ status: 'down', latencyMs: null });
    expect(res.migrations).toEqual(UNKNOWN_MIGRATIONS);
    expect(exec).not.toHaveBeenCalled();
  });

  it('degraded when only Redis is down', async () => {
    const { service } = makeService(
      { redis: 'down', latencyMs: { database: 1, redis: null } },
      async () => ({ rows: [{ applied: 0, hash: null, created_at: null }] }),
    );
    const res = await service.health();
    expect(res.status).toBe('degraded');
    expect(res.redis).toEqual({ status: 'down', latencyMs: null });
    expect(res.migrations.latest).toBeNull();
  });

  describe('ai (M5-T13)', () => {
    const row = (day: string, model: string, extra: object = {}) => ({
      day,
      provider: 'openai',
      model,
      calls: 10,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      credits: 12,
      failedCalls: 1,
      failuresByKind: { timeout: 1 },
      latencyMsSum: 5000,
      latencyMsMax: 900,
      ...extra,
    });

    it('summarises the last 7 Dhaka days with built-in prices + the env rate', async () => {
      const { service } = makeService(
        {},
        okMigrations,
        {},
        {
          aiRows: async () => [
            row('2026-11-12', 'gpt-4.1-mini'),
            row('2026-11-18', 'gpt-4.1-mini'),
          ],
          env: { AI_COST_USD_TO_BDT: 120 },
        },
      );
      service.now = () => new Date('2026-11-18T10:00:00.000Z');
      const { ai } = await service.health();
      expect(ai?.usdToBdtRate).toBe(120);
      expect(ai?.today.from).toBe('2026-11-18');
      expect(ai?.last7Days).toMatchObject({
        from: '2026-11-12',
        to: '2026-11-18',
      });
      // 1M input × 0.4 + 0.1M output × 1.6 = 0.56 USD per day.
      expect(ai?.today.totals).toMatchObject({
        calls: 10,
        estimatedCostUsd: 0.56,
        estimatedCostBdt: 67.2,
      });
      expect(ai?.last7Days.totals).toMatchObject({
        calls: 20,
        estimatedCostUsd: 1.12,
        estimatedCostBdt: 134.4,
        avgLatencyMs: 500,
        failuresByKind: { timeout: 2 },
      });
    });

    it('AI_MODEL_PRICES prices an otherwise unknown model', async () => {
      const { service } = makeService(
        {},
        okMigrations,
        {},
        {
          aiRows: async () => [
            row('2026-11-18', 'gpt-oss-20b', { provider: 'neon' }),
          ],
          env: { AI_MODEL_PRICES: 'neon:gpt-oss-20b=0.05/0.2' },
        },
      );
      service.now = () => new Date('2026-11-18T10:00:00.000Z');
      const { ai } = await service.health();
      expect(ai?.today.models[0]).toMatchObject({
        provider: 'neon',
        priceUsdPer1M: { input: 0.05, output: 0.2 },
        estimatedCostUsd: 0.07,
      });
    });

    it('a failing usage read → ai null, logged, the report still resolves', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const { service } = makeService(
        {},
        okMigrations,
        {},
        {
          aiRows: async () => {
            throw new Error('relation "daily_ai_usage" does not exist');
          },
        },
      );
      const res = await service.health();
      expect(res.ai).toBeNull();
      expect(res.migrations.known).toBe(true);
      expect(warn).toHaveBeenCalledWith('AI usage unavailable: Error');
    });

    it('a hanging usage read times out after 3 s → ai null', async () => {
      vi.useFakeTimers();
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service } = makeService(
        {},
        okMigrations,
        {},
        {
          aiRows: () => new Promise<unknown[]>(() => undefined),
        },
      );
      const pending = service.health();
      await vi.advanceTimersByTimeAsync(3000);
      expect((await pending).ai).toBeNull();
    });

    it('DB down → ai null without a usage query', async () => {
      const { service, aiRows } = makeService(
        {
          status: 'error',
          database: 'down',
          latencyMs: { database: null, redis: 1 },
        },
        okMigrations,
      );
      expect((await service.health()).ai).toBeNull();
      expect(aiRows).not.toHaveBeenCalled();
    });
  });

  it('unknown migrations when the journal query fails', async () => {
    const { service } = makeService({}, async () => {
      throw new Error('relation "drizzle.__drizzle_migrations" does not exist');
    });
    expect((await service.health()).migrations).toEqual(UNKNOWN_MIGRATIONS);
  });
});

describe('queueStats', () => {
  it('maps BullMQ counts to a QueuesCard row', () => {
    expect(
      queueStats('comment-ingest', { waiting: 4, active: 2, failed: 1 }),
    ).toEqual({ name: 'comment-ingest', waiting: 4, active: 2, failed: 1 });
  });

  it('missing or non-finite counts become 0; extra keys are ignored', () => {
    expect(
      queueStats('meta-token-check', {
        waiting: Number.NaN,
        failed: Number.POSITIVE_INFINITY,
        delayed: 9,
      }),
    ).toEqual({ name: 'meta-token-check', waiting: 0, active: 0, failed: 0 });
  });
});

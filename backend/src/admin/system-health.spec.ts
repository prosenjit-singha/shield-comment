import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import { MIGRATIONS_FOLDER } from '../db/migrator.js';
import type { HealthReport, HealthService } from '../health/health.service.js';
import { AdminSystemService } from './admin-system.service.js';
import { SystemHealthQueryDto } from './dto/system-health.dto.js';
import {
  describeMigrations,
  describeProcess,
  parseJournal,
  parseVersion,
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
  function makeService(
    report: Partial<HealthReport>,
    execute: () => Promise<unknown>,
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
    const db = { execute: exec } as unknown as Database;
    const config = {
      get: vi.fn(() => 'test'),
    } as unknown as ConfigService<EnvironmentVariables, true>;
    return { service: new AdminSystemService(health, db, config), exec };
  }

  it('ok: probes, process, empty queues, latest migration from the DB row', async () => {
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

  it('unknown migrations when the journal query fails', async () => {
    const { service } = makeService({}, async () => {
      throw new Error('relation "drizzle.__drizzle_migrations" does not exist');
    });
    expect((await service.health()).migrations).toEqual(UNKNOWN_MIGRATIONS);
  });
});

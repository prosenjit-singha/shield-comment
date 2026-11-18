import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import { MIGRATIONS_FOLDER } from '../db/migrator.js';
import { HealthService } from '../health/health.service.js';
import type {
  MigrationStatus,
  QueueStats,
  SystemHealthResponse,
} from './dto/system-health.dto.js';
import {
  type AppliedMigrations,
  describeMigrations,
  describeProcess,
  type JournalEntry,
  parseJournal,
  parseVersion,
  UNKNOWN_MIGRATIONS,
} from './system-health.js';

const MIGRATIONS_TIMEOUT_MS = 3000;

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * A6 system health (M2-T10, user decision 2026-11-18): DB + Redis probes (reused from
 * `HealthService`), process info, BullMQ queue counts and the latest applied Drizzle migration.
 * It queries the DB (2 round trips), so the admin page polls at most every 30–60 s while visible;
 * uptime monitors must keep using `/api/health/live`.
 */
@Injectable()
export class AdminSystemService {
  /** `backend/package.json` from both `src/admin/` (tests) and `dist/admin/` (Docker image). */
  private readonly version = parseVersion(
    readText(join(import.meta.dirname, '..', '..', 'package.json')),
  );
  private readonly journal: JournalEntry[] = parseJournal(
    readText(join(MIGRATIONS_FOLDER, 'meta', '_journal.json')),
  );

  constructor(
    private readonly healthService: HealthService,
    @InjectDrizzle() private readonly db: Database,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  async health(): Promise<SystemHealthResponse> {
    const report = await this.healthService.check();
    // Skip the journal query when the DB probe already failed (it would only wait for the pool).
    const [migrations, queues] = await Promise.all([
      report.database === 'up'
        ? this.migrations()
        : Promise.resolve(UNKNOWN_MIGRATIONS),
      this.queues(),
    ]);
    return {
      status:
        report.database === 'up' && report.redis === 'up' ? 'ok' : 'degraded',
      checkedAt: report.timestamp,
      database: {
        status: report.database,
        latencyMs: report.latencyMs.database,
      },
      redis: { status: report.redis, latencyMs: report.latencyMs.redis },
      process: describeProcess({
        uptimeSeconds: process.uptime(),
        memory: process.memoryUsage(),
        version: this.version,
        nodeVersion: process.version,
        environment: this.config.get('NODE_ENV', { infer: true }),
        now: new Date(report.timestamp),
      }),
      queues,
      migrations,
    };
  }

  /**
   * BullMQ counts per queue. No queues exist until the moderation pipeline (Module 4+): it adds
   * `getJobCounts('waiting', 'active', 'failed')` per registered queue here.
   */
  private queues(): Promise<QueueStats[]> {
    return Promise.resolve([]);
  }

  private async migrations(): Promise<MigrationStatus> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.db.execute<{
          applied: number;
          hash: string | null;
          created_at: string | number | null;
        }>(sql`
          select c.applied, m.hash, m.created_at
          from (select count(*)::int as applied from drizzle.__drizzle_migrations) c
          left join lateral (
            select hash, created_at from drizzle.__drizzle_migrations
            order by created_at desc nulls last, id desc
            limit 1
          ) m on true
        `),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout')),
            MIGRATIONS_TIMEOUT_MS,
          );
        }),
      ]);
      const row = result.rows[0];
      if (!row) return UNKNOWN_MIGRATIONS;
      const applied: AppliedMigrations = {
        applied: Number(row.applied),
        // `bigint` comes back from pg as a string.
        latest:
          row.hash === null
            ? null
            : {
                hash: row.hash,
                createdAt:
                  row.created_at === null ? null : Number(row.created_at),
              },
      };
      return describeMigrations(applied, this.journal);
    } catch {
      // Journal table missing (never migrated) or the DB dropped between the probes.
      return UNKNOWN_MIGRATIONS;
    } finally {
      clearTimeout(timer);
    }
  }
}

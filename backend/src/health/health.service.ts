import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { RedisService } from '../redis/redis.service.js';

export type DependencyStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'error';
  database: DependencyStatus;
  redis: DependencyStatus;
  latencyMs: { database: number | null; redis: number | null };
  timestamp: string;
}

const CHECK_TIMEOUT_MS = 3000;

async function timed(check: () => Promise<unknown>): Promise<number | null> {
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timeout')),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return Math.round((performance.now() - start) * 100) / 100;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<HealthReport> {
    const [dbLatency, redisLatency] = await Promise.all([
      timed(() => this.db.execute(sql`select 1`)),
      timed(() => this.redis.ping()),
    ]);
    const database: DependencyStatus = dbLatency === null ? 'down' : 'up';
    const redis: DependencyStatus = redisLatency === null ? 'down' : 'up';
    return {
      status: database === 'up' && redis === 'up' ? 'ok' : 'error',
      database,
      redis,
      latencyMs: { database: dbLatency, redis: redisLatency },
      timestamp: new Date().toISOString(),
    };
  }
}

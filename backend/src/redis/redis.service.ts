import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { EnvironmentVariables } from '../config/env.validation.js';

/** `maxmemory_policy` from `INFO` text; `null` when the field is missing. */
export function parseMaxmemoryPolicy(info: string): string | null {
  const line = info
    .split(/\r?\n/)
    .find((l) => l.startsWith('maxmemory_policy:'));
  const value = line?.slice('maxmemory_policy:'.length).trim();
  return value ? value : null;
}

/** Shared Redis connection for app-level use (cache, rate limits, health). BullMQ gets its own connections. */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });
    // Errors are surfaced via health checks; avoid unhandled 'error' event crashes.
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<string> {
    if (this.client.status === 'wait') await this.client.connect();
    return this.client.ping();
  }

  /** Redis `maxmemory-policy` from `INFO memory` (works where `CONFIG GET` is blocked, e.g. Redis Cloud). */
  async evictionPolicy(): Promise<string | null> {
    if (this.client.status === 'wait') await this.client.connect();
    return parseMaxmemoryPolicy(await this.client.info('memory'));
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}

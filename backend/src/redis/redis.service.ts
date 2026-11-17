import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { EnvironmentVariables } from '../config/env.validation.js';

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

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}

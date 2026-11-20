import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

/**
 * Short-lived ownership-transfer state (M7-T6b): the one-time code hash, the attempt counter and
 * the resend window. Abstract class = DI token; e2e swaps in a memory store (Redis is stubbed).
 */
export abstract class OwnershipTransferStore {
  abstract put(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** `null` when missing or expired. */
  abstract get(key: string): Promise<string | null>;
  abstract del(...keys: string[]): Promise<void>;
  /** Fixed-window counter: the count including this hit; the window starts at the first hit. */
  abstract hit(key: string, windowSeconds: number): Promise<number>;
}

@Injectable()
export class RedisOwnershipTransferStore extends OwnershipTransferStore {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    await (await this.connected()).set(key, value, 'EX', ttlSeconds);
  }

  async get(key: string): Promise<string | null> {
    return (await this.connected()).get(key);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await (await this.connected()).del(...keys);
  }

  async hit(key: string, windowSeconds: number): Promise<number> {
    const client = await this.connected();
    // SET NX starts the window (TTL) once; INCR keeps the TTL. Atomic per command, so parallel
    // guesses each get their own count.
    const replies = await client
      .multi()
      .set(key, 0, 'EX', windowSeconds, 'NX')
      .incr(key)
      .exec();
    const [error, count] = replies?.[1] ?? [new Error('Redis MULTI aborted')];
    if (error) throw error;
    return Number(count);
  }

  private async connected() {
    const { client } = this.redis;
    if (client.status === 'wait') await client.connect();
    return client;
  }
}

import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

/**
 * Redis state of scam-spike alerts (M7-T9): the 60-minute cool-down per workspace (D14) and the
 * "Send test alert" counter (reading 12). Abstract class = DI token; e2e uses a memory twin.
 */
export abstract class AlertStore {
  /** `SET key 1 NX EX ttl`: `true` = taken now, `false` = already held. */
  abstract claim(key: string, ttlSeconds: number): Promise<boolean>;
  abstract release(key: string): Promise<void>;
  /** Fixed-window counter: the count including this hit; the window starts at the first hit. */
  abstract hit(key: string, windowSeconds: number): Promise<number>;
}

@Injectable()
export class RedisAlertStore extends AlertStore {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const reply = await (
      await this.connected()
    ).set(key, '1', 'EX', ttlSeconds, 'NX');
    return reply === 'OK';
  }

  async release(key: string): Promise<void> {
    await (await this.connected()).del(key);
  }

  async hit(key: string, windowSeconds: number): Promise<number> {
    const replies = await (
      await this.connected()
    )
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

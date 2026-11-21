import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { withTimeout } from '../common/async/with-timeout.js';

/** Not exported by the package index. */
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/** Keeps throttler counters apart from auth / BullMQ / cache keys on the shared Redis. */
export const THROTTLE_KEY_PREFIX = 'throttle:';

/**
 * Fixed window: INCR, and set the TTL (ms) when the key has none (first hit), in one atomic step.
 * Returns `{ hits, pttl }`.
 */
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}`;

/** Never let a slow or unreachable Redis hold every request. */
const REDIS_TIMEOUT_MS = 500;

const ALLOW: ThrottlerStorageRecord = {
  totalHits: 0,
  timeToExpire: 0,
  isBlocked: false,
  timeToBlockExpire: 0,
};

/**
 * `@nestjs/throttler` storage on the shared ioredis connection (M9-T2, D2): counters survive
 * restarts and are shared by every backend instance. Fixed window of `ttl` ms; the request past
 * `limit` is blocked until the window ends (`blockDuration` is ignored: every throttler here uses
 * the default = ttl). Redis down or slow → the request is allowed and one warning is logged per
 * window (rate limiting must never cause a 500 or block sign-ins).
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('RateLimit');
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly client: Pick<Redis, 'eval'>,
    private readonly now: () => number = Date.now,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
  ): Promise<ThrottlerStorageRecord> {
    try {
      const result = await withTimeout(
        this.client.eval(INCREMENT_SCRIPT, 1, THROTTLE_KEY_PREFIX + key, ttl),
        REDIS_TIMEOUT_MS,
      );
      if (
        !Array.isArray(result) ||
        typeof result[0] !== 'number' ||
        typeof result[1] !== 'number'
      )
        throw new Error('unexpected Redis reply');
      const [totalHits, pttl] = result as [number, number];
      const timeToExpire = Math.max(1, Math.ceil(pttl / 1000));
      const isBlocked = totalHits > limit;
      return {
        totalHits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire: isBlocked ? timeToExpire : 0,
      };
    } catch (error) {
      const now = this.now();
      if (now - this.lastWarnAt >= ttl) {
        this.lastWarnAt = now;
        this.logger.warn(
          `Rate limiting skipped, Redis unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return ALLOW;
    }
  }
}

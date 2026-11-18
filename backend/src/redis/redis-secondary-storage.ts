import type { SecondaryStorage } from 'better-auth';
import type { Redis } from 'ioredis';
import { RedisService } from './redis.service.js';

/** DI token for Better Auth's `secondaryStorage` (overridden with an in-memory store in e2e). */
export const AUTH_SECONDARY_STORAGE = Symbol('AUTH_SECONDARY_STORAGE');

/** Keeps auth keys apart from BullMQ / cache keys on the shared Redis. */
const PREFIX = 'auth:';

/**
 * Better Auth `secondaryStorage` on ioredis: session lookups and rate-limit counters.
 * Redis must run with `noeviction` (tech-stack.md §2) so live sessions aren't evicted.
 */
export function createRedisSecondaryStorage(client: Redis): SecondaryStorage {
  const k = (key: string) => PREFIX + key;
  return {
    get: (key) => client.get(k(key)),
    getAndDelete: (key) => client.getdel(k(key)),
    async set(key, value, ttl) {
      if (ttl && ttl > 0) await client.set(k(key), value, 'EX', Math.ceil(ttl));
      else await client.set(k(key), value);
    },
    async delete(key) {
      await client.del(k(key));
    },
    async increment(key, ttl) {
      // TTL only on creation (fixed window): SET NX seeds the key, INCR bumps it, atomically.
      const results = await client
        .multi()
        .set(k(key), '0', 'EX', Math.max(1, Math.ceil(ttl)), 'NX')
        .incr(k(key))
        .exec();
      const [error, value] = results?.[1] ?? [
        new Error('Redis MULTI aborted'),
        null,
      ];
      if (error) throw error;
      return Number(value);
    },
  };
}

export const authSecondaryStorageProvider = {
  provide: AUTH_SECONDARY_STORAGE,
  inject: [RedisService],
  useFactory: (redis: RedisService) =>
    createRedisSecondaryStorage(redis.client),
};

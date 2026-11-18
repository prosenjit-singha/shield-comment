import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { withTimeout } from '../common/async/with-timeout.js';
import { RedisService } from '../redis/redis.service.js';

const CHECK_TIMEOUT_MS = 5000;

export type EvictionCheckResult = 'ok' | 'wrong-policy' | 'unknown';

/**
 * BullMQ (and Better Auth sessions) need Redis `maxmemory-policy noeviction`: with any other
 * policy a full Redis silently drops job keys. Checked once at startup in the background; a wrong
 * or unreadable policy only logs a warning, the app never fails to start because of it.
 */
@Injectable()
export class RedisEvictionCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('Queues');

  constructor(private readonly redis: RedisService) {}

  onApplicationBootstrap(): void {
    // Not awaited: a slow or down Redis must not delay startup.
    void this.check();
  }

  async check(): Promise<EvictionCheckResult> {
    try {
      const policy = await withTimeout(
        this.redis.evictionPolicy(),
        CHECK_TIMEOUT_MS,
      );
      if (policy === null) {
        this.logger.warn(
          'Redis maxmemory-policy is not reported; BullMQ needs "noeviction"',
        );
        return 'unknown';
      }
      if (policy !== 'noeviction') {
        this.logger.warn(
          `Redis maxmemory-policy is "${policy}"; BullMQ needs "noeviction" or jobs can be evicted`,
        );
        return 'wrong-policy';
      }
      return 'ok';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not read Redis maxmemory-policy (${message}); BullMQ needs "noeviction"`,
      );
      return 'unknown';
    }
  }
}

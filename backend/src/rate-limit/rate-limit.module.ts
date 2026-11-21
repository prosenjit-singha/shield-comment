import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { META_CALLBACK_THROTTLE } from '../meta-callbacks/meta-callbacks.module.js';
import { RedisService } from '../redis/redis.service.js';
import { GlobalThrottlerGuard } from './global-throttler.guard.js';
import { RedisThrottlerStorage } from './redis-throttler-storage.js';

/**
 * Rate limiting (M9-T2, D2). `ThrottlerModule` is global: its `default` throttler (Meta callback
 * numbers) + per-route `@Throttle` overrides serve the routes that use `@UseGuards(ThrottlerGuard)`
 * (Meta + SSLCommerz callbacks, checkout); `GlobalThrottlerGuard` is the app-wide guard.
 * Storage = Redis for both (e2e overrides `ThrottlerStorage` with the in-memory one).
 * Import it **after** AuthModule: global guards run in module order and the tracker needs the session.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [{ ...META_CALLBACK_THROTTLE }],
        storage: new RedisThrottlerStorage(redis.client),
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: GlobalThrottlerGuard }],
})
export class RateLimitModule {}

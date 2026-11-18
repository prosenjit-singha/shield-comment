import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import {
  createMetaCallbacksConfig,
  META_CALLBACKS_CONFIG,
} from './meta-callbacks.config.js';
import { MetaCallbacksController } from './meta-callbacks.controller.js';
import { MetaDataDeletionService } from './meta-data-deletion.service.js';
import { MetaDeauthorizeService } from './meta-deauthorize.service.js';
import { MetaTokenCheckProcessor } from './meta-token-check.processor.js';

/**
 * Rate limit of the Meta callbacks, per client IP and per route (in-memory, per API process;
 * Meta's servers send a handful per user action). Over it → 429.
 */
export const META_CALLBACK_THROTTLE = { ttl: 60_000, limit: 30 } as const;

/**
 * Meta Deauthorize + Data Deletion callbacks (Module 4 D6, M4-T6) and the `meta-token-check`
 * worker (Data Deletion job now; M4-T7 adds the scheduled jobs). Queues come from the global
 * `QueueModule`. Startup never fails when `META_APP_SECRET` is unset (the POSTs answer 503).
 */
@Module({
  imports: [ThrottlerModule.forRoot([{ ...META_CALLBACK_THROTTLE }])],
  controllers: [MetaCallbacksController],
  providers: [
    {
      provide: META_CALLBACKS_CONFIG,
      inject: [ConfigService],
      useFactory: createMetaCallbacksConfig,
    },
    MetaDeauthorizeService,
    MetaDataDeletionService,
    MetaTokenCheckProcessor,
  ],
})
export class MetaCallbacksModule {}

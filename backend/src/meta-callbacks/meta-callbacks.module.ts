import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommentsModule } from '../comments/comments.module.js';
import { TokenCipherModule } from '../crypto/token-cipher.module.js';
import { MetaGraphModule } from '../meta/meta-graph.module.js';
import {
  createMetaCallbacksConfig,
  META_CALLBACKS_CONFIG,
} from './meta-callbacks.config.js';
import { MetaCallbacksController } from './meta-callbacks.controller.js';
import { MetaDataDeletionService } from './meta-data-deletion.service.js';
import { MetaDeauthorizeService } from './meta-deauthorize.service.js';
import { MetaJobSchedulers } from './meta-job-schedulers.js';
import { MetaTokenCheckProcessor } from './meta-token-check.processor.js';
import { MetaTokenCheckService } from './meta-token-check.service.js';

/**
 * Rate limit of the Meta callbacks, per client IP and per route (Meta's servers send a handful per
 * user action). Over it → 429. It is the `default` throttler of the global `ThrottlerModule`
 * (`RateLimitModule`, Redis storage, M9-T2).
 */
export const META_CALLBACK_THROTTLE = { ttl: 60_000, limit: 30 } as const;

/**
 * Meta Deauthorize + Data Deletion callbacks (Module 4 D6, M4-T6) and the `meta-token-check`
 * worker: Data Deletion job + the M4-T7 scheduled jobs (`debug-token` check, `raw-payload-purge`)
 * registered at startup by `MetaJobSchedulers`. Queues come from the global `QueueModule`.
 * Startup never fails when `META_APP_SECRET`, the Meta app, the cipher or Redis are missing.
 */
@Module({
  imports: [MetaGraphModule, TokenCipherModule, CommentsModule],
  controllers: [MetaCallbacksController],
  providers: [
    {
      provide: META_CALLBACKS_CONFIG,
      inject: [ConfigService],
      useFactory: createMetaCallbacksConfig,
    },
    MetaDeauthorizeService,
    MetaDataDeletionService,
    MetaTokenCheckService,
    MetaTokenCheckProcessor,
    MetaJobSchedulers,
  ],
})
export class MetaCallbacksModule {}

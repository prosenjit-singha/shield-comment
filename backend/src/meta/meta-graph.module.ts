import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaGraphClient } from './meta-graph.client.js';
import { createMetaAppConfig, META_APP_CONFIG } from './meta-graph.config.js';

/**
 * Meta Graph API client (M3-T3). No HTTP routes; `MetaModule` imports this and injects
 * `MetaGraphClient`. Disabled (`enabled` false, calls throw `MetaNotConfiguredError`) when the
 * META_* app vars are unset.
 */
@Module({
  providers: [
    {
      provide: META_APP_CONFIG,
      inject: [ConfigService],
      useFactory: createMetaAppConfig,
    },
    MetaGraphClient,
  ],
  exports: [MetaGraphClient],
})
export class MetaGraphModule {}

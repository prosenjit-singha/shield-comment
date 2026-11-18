import { Module } from '@nestjs/common';
import { TokenCipherModule } from '../crypto/token-cipher.module.js';
import { MetaGraphModule } from './meta-graph.module.js';
import {
  MetaOAuthCallbackController,
  MetaOAuthUrlController,
} from './meta-oauth.controller.js';
import { MetaOAuthService } from './meta-oauth.service.js';
import {
  MetaOAuthStateStore,
  RedisMetaOAuthStateStore,
} from './meta-oauth-state.store.js';

/**
 * Meta (FB/IG) connection (Module 3). M3-T4: OAuth connect flow. Needs the Graph client and the
 * token cipher; when either is unconfigured the app still starts and the URL endpoint answers 503.
 * Page sync (M3-T5) and the pages API (M3-T6) land here too; webhooks are Module 4.
 */
@Module({
  imports: [MetaGraphModule, TokenCipherModule],
  controllers: [MetaOAuthUrlController, MetaOAuthCallbackController],
  providers: [
    MetaOAuthService,
    { provide: MetaOAuthStateStore, useClass: RedisMetaOAuthStateStore },
  ],
})
export class MetaModule {}

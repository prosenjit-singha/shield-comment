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
import { SocialPagesController } from './social-pages.controller.js';
import { SocialPagesService } from './social-pages.service.js';

/**
 * Meta (FB/IG) connection (Module 3). M3-T4: OAuth connect flow. Needs the Graph client and the
 * token cipher; when either is unconfigured the app still starts and the URL endpoint answers 503.
 * M3-T5: Page sync in the callback. M3-T6: workspace pages API (list + toggle, no Meta call);
 * webhooks and `subscribed_apps` are Module 4.
 */
@Module({
  imports: [MetaGraphModule, TokenCipherModule],
  controllers: [
    MetaOAuthUrlController,
    MetaOAuthCallbackController,
    SocialPagesController,
  ],
  providers: [
    MetaOAuthService,
    SocialPagesService,
    { provide: MetaOAuthStateStore, useClass: RedisMetaOAuthStateStore },
  ],
})
export class MetaModule {}

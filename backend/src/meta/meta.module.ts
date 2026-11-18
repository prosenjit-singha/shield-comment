import { Module } from '@nestjs/common';
import { TokenCipherModule } from '../crypto/token-cipher.module.js';
import { MetaConnectionController } from './meta-connection.controller.js';
import { MetaDisconnectService } from './meta-disconnect.service.js';
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
import { PageSubscriptionService } from './page-subscription.service.js';
import { SocialPagesController } from './social-pages.controller.js';
import { SocialPagesService } from './social-pages.service.js';

/**
 * Meta (FB/IG) connection (Module 3). M3-T4: OAuth connect flow. Needs the Graph client and the
 * token cipher; when either is unconfigured the app still starts and the URL endpoint answers 503.
 * M3-T5: Page sync in the callback. M3-T6: workspace pages API (list + toggle). M4-T8: the toggle
 * calls Graph `subscribed_apps` (`PageSubscriptionService`). M4-T9: connection status in the pages
 * list, NEEDS_REAUTH switch-on rule, `DELETE …/meta/connection` (`MetaDisconnectService`).
 */
@Module({
  imports: [MetaGraphModule, TokenCipherModule],
  controllers: [
    MetaOAuthUrlController,
    MetaOAuthCallbackController,
    SocialPagesController,
    MetaConnectionController,
  ],
  providers: [
    MetaOAuthService,
    SocialPagesService,
    PageSubscriptionService,
    MetaDisconnectService,
    { provide: MetaOAuthStateStore, useClass: RedisMetaOAuthStateStore },
  ],
})
export class MetaModule {}

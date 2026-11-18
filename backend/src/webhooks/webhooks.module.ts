import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createMetaWebhookConfig,
  META_WEBHOOK_CONFIG,
} from './meta-webhook.config.js';
import { MetaWebhookController } from './meta-webhook.controller.js';
import { MetaWebhookSignatureGuard } from './meta-webhook-signature.guard.js';

/**
 * Meta webhooks (Module 4). M4-T3: `GET` verify handshake + `POST` HMAC guard (stub receiver).
 * The raw body for the route is captured by `metaWebhookRawBody()` in `configureApp()`.
 * Startup never fails when the secrets are unset; the endpoint answers 503 instead.
 */
@Module({
  controllers: [MetaWebhookController],
  providers: [
    {
      provide: META_WEBHOOK_CONFIG,
      inject: [ConfigService],
      useFactory: createMetaWebhookConfig,
    },
    MetaWebhookSignatureGuard,
  ],
})
export class WebhooksModule {}

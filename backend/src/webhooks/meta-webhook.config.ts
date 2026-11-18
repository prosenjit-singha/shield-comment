import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';

/**
 * Secrets the Meta webhook endpoint needs (Module 4 D1). Each is `null` when unset: the app still
 * starts and the matching half of `/api/webhooks/meta` answers 503.
 * - `verifyToken` (`META_WEBHOOK_VERIFY_TOKEN`): the `GET` subscription handshake.
 * - `appSecret` (`META_APP_SECRET`, part of the META_* app group): the `POST` HMAC check.
 */
export interface MetaWebhookConfig {
  verifyToken: string | null;
  appSecret: string | null;
}

/** DI token for `MetaWebhookConfig` (e2e overrides it to enable the endpoint). */
export const META_WEBHOOK_CONFIG = Symbol('META_WEBHOOK_CONFIG');

export function createMetaWebhookConfig(
  config: ConfigService<EnvironmentVariables, true>,
): MetaWebhookConfig {
  return {
    verifyToken:
      config.get('META_WEBHOOK_VERIFY_TOKEN', { infer: true }) || null,
    appSecret: config.get('META_APP_SECRET', { infer: true }) || null,
  };
}

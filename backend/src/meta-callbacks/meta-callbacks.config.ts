import type { ConfigService } from '@nestjs/config';
import { DEFAULT_CLIENT_APP_URL } from '../admin/admin-impersonation.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';

/**
 * What the Deauthorize + Data Deletion callbacks need (M4-T6).
 * - `appSecret` (`META_APP_SECRET`): verifies `signed_request`; `null` = unset → both POSTs 503
 *   (the app still starts).
 * - `clientAppUrl` (`CLIENT_APP_URL`): base of the status URL handed to Meta
 *   (`<clientAppUrl>/data-deletion?code=`, the client page is M4-T12).
 */
export interface MetaCallbacksConfig {
  appSecret: string | null;
  clientAppUrl: string;
}

/** DI token for `MetaCallbacksConfig` (e2e overrides it: the e2e env has no META_* vars). */
export const META_CALLBACKS_CONFIG = Symbol('META_CALLBACKS_CONFIG');

export function createMetaCallbacksConfig(
  config: ConfigService<EnvironmentVariables, true>,
): MetaCallbacksConfig {
  return {
    appSecret: config.get('META_APP_SECRET', { infer: true }) || null,
    clientAppUrl: (
      config.get('CLIENT_APP_URL', { infer: true }) || DEFAULT_CLIENT_APP_URL
    ).replace(/\/+$/, ''),
  };
}

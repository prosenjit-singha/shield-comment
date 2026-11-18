import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';

/**
 * Pinned Graph API version (decision D9, 2026-11-18: v26.0, released 2026-07-29).
 * `META_GRAPH_API_VERSION` can override it per environment. To bump: change this constant, read the
 * Graph changelog for Pages / Instagram comment changes, run the tests, update MEMORY.md.
 */
export const DEFAULT_GRAPH_API_VERSION = 'v26.0';

/**
 * Permissions the Login for Business configuration must request (decision D4). With `config_id` the
 * dialog takes its scopes from the configuration in the Meta dashboard, not from a `scope` param;
 * this list is what we expect to see granted (`MetaGraphClient.getPermissions`).
 */
export const META_LOGIN_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_engagement',
  'pages_read_user_content',
  'pages_manage_metadata',
  'business_management',
  'instagram_basic',
  'instagram_manage_comments',
] as const;
export type MetaLoginScope = (typeof META_LOGIN_SCOPES)[number];

export interface MetaAppConfig {
  appId: string;
  appSecret: string;
  loginConfigId: string;
  redirectUri: string;
  graphApiVersion: string;
}

/** DI token for the Meta app config (`null` when the META_* app vars are unset). */
export const META_APP_CONFIG = Symbol('META_APP_CONFIG');

/** Env validation already checked the values (all four or none); this only assembles them. */
export function createMetaAppConfig(
  config: ConfigService<EnvironmentVariables, true>,
): MetaAppConfig | null {
  const appId = config.get('META_APP_ID', { infer: true });
  const appSecret = config.get('META_APP_SECRET', { infer: true });
  const loginConfigId = config.get('META_LOGIN_CONFIG_ID', { infer: true });
  const redirectUri = config.get('META_OAUTH_REDIRECT_URI', { infer: true });
  if (!appId || !appSecret || !loginConfigId || !redirectUri) return null;
  return {
    appId,
    appSecret,
    loginConfigId,
    redirectUri,
    graphApiVersion:
      config.get('META_GRAPH_API_VERSION', { infer: true }) ||
      DEFAULT_GRAPH_API_VERSION,
  };
}

import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { buildTokenKeyring, type TokenKeyring } from './token-keyring.js';

/** DI token for the token keyring (`null` when the token env vars are unset). */
export const TOKEN_KEYRING = Symbol('TOKEN_KEYRING');

/** Env validation already checked the values; this only assembles the keyring. */
export function createTokenKeyring(
  config: ConfigService<EnvironmentVariables, true>,
): TokenKeyring | null {
  return buildTokenKeyring({
    key: config.get('TOKEN_ENCRYPTION_KEY', { infer: true }),
    keyId: config.get('TOKEN_ENCRYPTION_KEY_ID', { infer: true }),
    previousKeys: config.get('TOKEN_ENCRYPTION_PREVIOUS_KEYS', { infer: true }),
  });
}

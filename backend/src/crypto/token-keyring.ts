/**
 * Keyring for the AES-256-GCM token cipher (M3-T1, user decision D2 2026-11-18).
 *
 * Env: `TOKEN_ENCRYPTION_KEY` (base64 of exactly 32 bytes, `openssl rand -base64 32`)
 * + `TOKEN_ENCRYPTION_KEY_ID` encrypt; `TOKEN_ENCRYPTION_PREVIOUS_KEYS`
 * (`id:base64,id:base64`) only decrypt, so the key can rotate without downtime.
 * Pure functions (no Nest, no env types): `env.validation.ts` reuses them.
 * Error messages never include key material.
 */

export const AES_256_KEY_BYTES = 32;

/** Key ids are stored in every ciphertext (`v1:<keyId>:…`), so no `:` and short. */
export const TOKEN_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export interface TokenKey {
  id: string;
  key: Buffer;
}

export interface TokenKeyring {
  /** Encrypts new tokens. */
  current: TokenKey;
  /** Every key that may decrypt (current + previous), by id. */
  keys: ReadonlyMap<string, Buffer>;
}

export interface TokenKeyringEnv {
  key?: string;
  keyId?: string;
  previousKeys?: string;
}

/** Decodes canonical standard base64 of exactly 32 bytes; anything else → `null`. */
export function decodeAes256Key(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const key = Buffer.from(value, 'base64');
  if (key.length !== AES_256_KEY_BYTES) return null;
  // Buffer.from is lenient; a canonical round trip rejects stray padding/bits.
  if (key.toString('base64') !== value) return null;
  return key;
}

export function isValidTokenKeyId(value: string): boolean {
  return TOKEN_KEY_ID_PATTERN.test(value);
}

/** Parses `id:base64,id:base64` (blank entries ignored). Throws on any bad entry or duplicate id. */
export function parsePreviousTokenKeys(value: string): TokenKey[] {
  const keys: TokenKey[] = [];
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const [index, entry] of entries.entries()) {
    const separator = entry.indexOf(':');
    const id = separator === -1 ? '' : entry.slice(0, separator);
    if (!isValidTokenKeyId(id)) {
      throw new Error(
        `entry ${index + 1} must be "<keyId>:<base64 key>" with keyId matching ${TOKEN_KEY_ID_PATTERN}`,
      );
    }
    const key = decodeAes256Key(entry.slice(separator + 1));
    if (!key) {
      throw new Error(
        `key "${id}" must be base64 of exactly ${AES_256_KEY_BYTES} bytes`,
      );
    }
    if (keys.some((k) => k.id === id)) {
      throw new Error(`key id "${id}" is listed twice`);
    }
    keys.push({ id, key });
  }
  return keys;
}

/**
 * Builds the keyring, or `null` when no token env var is set (cipher disabled).
 * Throws when the vars are set but incomplete or invalid.
 */
export function buildTokenKeyring(env: TokenKeyringEnv): TokenKeyring | null {
  const { key, keyId, previousKeys } = env;
  if (key === undefined && keyId === undefined && previousKeys === undefined) {
    return null;
  }
  if (key === undefined || keyId === undefined) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY and TOKEN_ENCRYPTION_KEY_ID must be set together',
    );
  }
  const currentKey = decodeAes256Key(key);
  if (!currentKey) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be base64 of exactly ${AES_256_KEY_BYTES} bytes`,
    );
  }
  if (!isValidTokenKeyId(keyId)) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY_ID must match ${TOKEN_KEY_ID_PATTERN}`,
    );
  }
  const previous = parsePreviousTokenKeys(previousKeys ?? '');
  if (previous.some((k) => k.id === keyId)) {
    throw new Error(
      `TOKEN_ENCRYPTION_PREVIOUS_KEYS must not reuse the current key id "${keyId}"`,
    );
  }
  const keys = new Map<string, Buffer>([[keyId, currentKey]]);
  for (const k of previous) keys.set(k.id, k.key);
  return { current: { id: keyId, key: currentKey }, keys };
}

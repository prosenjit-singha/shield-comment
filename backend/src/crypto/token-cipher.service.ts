import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TOKEN_KEYRING } from './token-cipher.config.js';
import { isValidTokenKeyId, type TokenKeyring } from './token-keyring.js';

/**
 * Stored format (one `text` column, user decision D2):
 * `v1:<keyId>:<iv>:<tag>:<ciphertext>`, parts in unpadded base64url.
 * AAD = `v1:<keyId>:<context>`, so the header and the row context are both authenticated.
 */
export const TOKEN_CIPHER_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** What a token is for. Extend when a new encrypted column appears. */
export type TokenPurpose = 'meta_user_token' | 'meta_page_token';

/**
 * AAD context = purpose + workspace + subject (FB user id / Page id). A ciphertext
 * copied into another row or workspace then fails to decrypt.
 */
export function tokenCipherContext(
  purpose: TokenPurpose,
  workspaceId: string,
  subjectId: string,
): string {
  for (const part of [workspaceId, subjectId]) {
    if (part.length === 0 || part.includes(':')) {
      throw new Error(
        'Token cipher context parts must be non-empty, without ":"',
      );
    }
  }
  return `${purpose}:${workspaceId}:${subjectId}`;
}

export class TokenCipherNotConfiguredError extends Error {
  constructor() {
    super(
      'Token cipher is not configured (TOKEN_ENCRYPTION_KEY, TOKEN_ENCRYPTION_KEY_ID)',
    );
    this.name = 'TokenCipherNotConfiguredError';
  }
}

export type TokenDecryptionFailure =
  'malformed' | 'unknown_key' | 'auth_failed';

/** Decrypt failed. The message is generic on purpose; `reason` tells callers why. */
export class TokenDecryptionError extends Error {
  constructor(readonly reason: TokenDecryptionFailure) {
    super(`Token decryption failed (${reason})`);
    this.name = 'TokenDecryptionError';
  }
}

interface ParsedToken {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/** Strict unpadded base64url; `null` on non-canonical input. */
function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

function parseToken(stored: string): ParsedToken {
  const parts = stored.split(':');
  if (parts.length !== 5) throw new TokenDecryptionError('malformed');
  const [version, keyId, ivPart, tagPart, ciphertextPart] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== TOKEN_CIPHER_VERSION || !isValidTokenKeyId(keyId)) {
    throw new TokenDecryptionError('malformed');
  }
  const iv = decodeBase64Url(ivPart);
  const tag = decodeBase64Url(tagPart);
  const ciphertext = decodeBase64Url(ciphertextPart);
  if (iv?.length !== IV_BYTES || tag?.length !== TAG_BYTES || !ciphertext) {
    throw new TokenDecryptionError('malformed');
  }
  return { keyId, iv, tag, ciphertext };
}

function aad(keyId: string, context: string): Buffer {
  return Buffer.from(`${TOKEN_CIPHER_VERSION}:${keyId}:${context}`, 'utf8');
}

function assertContext(context: string): void {
  if (context.length === 0) {
    throw new Error('Token cipher context must not be empty');
  }
}

/**
 * AES-256-GCM encryption for third-party access tokens (Meta user/Page tokens) at rest.
 * Random 12-byte IV per call, 16-byte auth tag verified on decrypt. No HTTP routes.
 * Disabled (`isConfigured` false, calls throw) when the token env vars are unset.
 */
@Injectable()
export class TokenCipherService {
  constructor(
    @Inject(TOKEN_KEYRING) private readonly keyring: TokenKeyring | null,
  ) {}

  get isConfigured(): boolean {
    return this.keyring !== null;
  }

  /** Encrypts with the current key. `context` must be passed again to decrypt. */
  encrypt(plaintext: string, context: string): string {
    const keyring = this.requireKeyring();
    assertContext(context);
    if (plaintext.length === 0) {
      throw new Error('Token cipher plaintext must not be empty');
    }
    const { id, key } = keyring.current;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad(id, context));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      TOKEN_CIPHER_VERSION,
      id,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  /** Throws `TokenDecryptionError` on malformed input, unknown key id, or failed authentication. */
  decrypt(stored: string, context: string): string {
    const keyring = this.requireKeyring();
    assertContext(context);
    const { keyId, iv, tag, ciphertext } = parseToken(stored);
    const key = keyring.keys.get(keyId);
    if (!key) throw new TokenDecryptionError('unknown_key');
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad(keyId, context));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new TokenDecryptionError('auth_failed');
    }
  }

  /** True when `stored` was written with a previous key (re-encrypt it during rotation). */
  needsReencrypt(stored: string): boolean {
    const keyring = this.requireKeyring();
    return parseToken(stored).keyId !== keyring.current.id;
  }

  private requireKeyring(): TokenKeyring {
    if (!this.keyring) throw new TokenCipherNotConfiguredError();
    return this.keyring;
  }
}

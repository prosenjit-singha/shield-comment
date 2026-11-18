import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { createTokenKeyring } from './token-cipher.config.js';
import {
  TokenCipherNotConfiguredError,
  TokenCipherService,
  TokenDecryptionError,
  tokenCipherContext,
  type TokenDecryptionFailure,
} from './token-cipher.service.js';
import { buildTokenKeyring } from './token-keyring.js';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');
const WORKSPACE = '0193b1a2-0000-7000-8000-000000000001';
const CONTEXT = tokenCipherContext('meta_page_token', WORKSPACE, '1234567890');
const TOKEN = 'EAAG-page-token-ব্যাংক-✓';

function cipher(key = KEY_A, keyId = 'k1', previousKeys?: string) {
  return new TokenCipherService(
    buildTokenKeyring({ key, keyId, previousKeys }),
  );
}

function expectFailure(fn: () => unknown, reason: TokenDecryptionFailure) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TokenDecryptionError);
  expect((caught as TokenDecryptionError).reason).toBe(reason);
}

/** Flips one bit of a base64url part (index 2 = iv, 3 = tag, 4 = ciphertext). */
function tamper(stored: string, partIndex: number): string {
  const parts = stored.split(':');
  const bytes = Buffer.from(parts[partIndex]!, 'base64url');
  bytes[0] = bytes[0]! ^ 0x01;
  parts[partIndex] = bytes.toString('base64url');
  return parts.join(':');
}

describe('TokenCipherService', () => {
  it('round-trips a token (unicode included)', () => {
    const service = cipher();
    const stored = service.encrypt(TOKEN, CONTEXT);
    expect(service.decrypt(stored, CONTEXT)).toBe(TOKEN);
  });

  it('writes v1:<keyId>:<iv>:<tag>:<ciphertext> with a 12-byte IV and 16-byte tag', () => {
    const stored = cipher().encrypt(TOKEN, CONTEXT);
    const [version, keyId, iv, tag, ciphertext] = stored.split(':');
    expect(version).toBe('v1');
    expect(keyId).toBe('k1');
    expect(Buffer.from(iv!, 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag!, 'base64url')).toHaveLength(16);
    expect(Buffer.from(ciphertext!, 'base64url')).toHaveLength(
      Buffer.byteLength(TOKEN, 'utf8'),
    );
    expect(stored).not.toContain(TOKEN);
  });

  it('uses a unique IV per call', () => {
    const service = cipher();
    const outputs = Array.from({ length: 50 }, () =>
      service.encrypt(TOKEN, CONTEXT),
    );
    const ivs = new Set(outputs.map((o) => o.split(':')[2]));
    expect(ivs.size).toBe(50);
    expect(new Set(outputs).size).toBe(50);
  });

  it.each([
    ['iv', 2],
    ['tag', 3],
    ['ciphertext', 4],
  ])('rejects a tampered %s', (_name, index) => {
    const service = cipher();
    const stored = service.encrypt(TOKEN, CONTEXT);
    expectFailure(
      () => service.decrypt(tamper(stored, index), CONTEXT),
      'auth_failed',
    );
  });

  it('rejects a wrong key with the same key id', () => {
    const stored = cipher(KEY_A).encrypt(TOKEN, CONTEXT);
    expectFailure(() => cipher(KEY_B).decrypt(stored, CONTEXT), 'auth_failed');
  });

  it('rejects an unknown key id', () => {
    const stored = cipher(KEY_A, 'k1').encrypt(TOKEN, CONTEXT);
    expectFailure(
      () => cipher(KEY_A, 'k2').decrypt(stored, CONTEXT),
      'unknown_key',
    );
  });

  it('rejects a swapped key id in the header (header is authenticated)', () => {
    const stored = cipher(KEY_A, 'k2', `k1:${KEY_A}`).encrypt(TOKEN, CONTEXT);
    const relabelled = stored.replace(/^v1:k2:/, 'v1:k1:');
    expectFailure(
      () => cipher(KEY_A, 'k2', `k1:${KEY_A}`).decrypt(relabelled, CONTEXT),
      'auth_failed',
    );
  });

  it('rejects a ciphertext moved to another workspace, subject or purpose (AAD)', () => {
    const service = cipher();
    const stored = service.encrypt(TOKEN, CONTEXT);
    for (const other of [
      tokenCipherContext('meta_page_token', 'another-workspace', '1234567890'),
      tokenCipherContext('meta_page_token', WORKSPACE, '999'),
      tokenCipherContext('meta_user_token', WORKSPACE, '1234567890'),
    ]) {
      expectFailure(() => service.decrypt(stored, other), 'auth_failed');
    }
  });

  it.each([
    ['empty string', ''],
    ['plain token', 'EAAGplaintoken'],
    ['too few parts', 'v1:k1:aaaa:bbbb'],
    ['too many parts', 'v1:k1:a:b:c:d'],
    ['unknown version', 'v2:k1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AA'],
    ['bad key id', 'v1:k 1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AA'],
    ['short iv', 'v1:k1:AAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AA'],
    ['short tag', 'v1:k1:AAAAAAAAAAAAAAAA:AAAAAAAA:AA'],
    ['empty ciphertext', 'v1:k1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:'],
    ['padded base64', 'v1:k1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AA'],
    [
      'non-base64url chars',
      'v1:k1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:A+/A',
    ],
  ])('rejects malformed input: %s', (_name, input) => {
    expectFailure(() => cipher().decrypt(input, CONTEXT), 'malformed');
  });

  it('rejects an empty plaintext or context', () => {
    const service = cipher();
    expect(() => service.encrypt('', CONTEXT)).toThrow(/plaintext/);
    expect(() => service.encrypt(TOKEN, '')).toThrow(/context/);
    expect(() => service.decrypt(service.encrypt(TOKEN, CONTEXT), '')).toThrow(
      /context/,
    );
  });

  it('decrypts tokens written with a previous key and flags them for re-encryption', () => {
    const oldStored = cipher(KEY_A, 'k1').encrypt(TOKEN, CONTEXT);
    const rotated = cipher(KEY_B, 'k2', `k1:${KEY_A}`);
    expect(rotated.decrypt(oldStored, CONTEXT)).toBe(TOKEN);
    expect(rotated.needsReencrypt(oldStored)).toBe(true);
    const fresh = rotated.encrypt(TOKEN, CONTEXT);
    expect(fresh.startsWith('v1:k2:')).toBe(true);
    expect(rotated.needsReencrypt(fresh)).toBe(false);
  });

  it('is disabled without a keyring', () => {
    const service = new TokenCipherService(null);
    expect(service.isConfigured).toBe(false);
    expect(() => service.encrypt(TOKEN, CONTEXT)).toThrow(
      TokenCipherNotConfiguredError,
    );
    expect(() => service.decrypt('v1:k1:a:b:c', CONTEXT)).toThrow(
      TokenCipherNotConfiguredError,
    );
  });
});

describe('tokenCipherContext', () => {
  it('joins purpose, workspace and subject', () => {
    expect(tokenCipherContext('meta_user_token', 'ws', '42')).toBe(
      'meta_user_token:ws:42',
    );
  });

  it('rejects empty parts and parts with ":"', () => {
    expect(() => tokenCipherContext('meta_user_token', '', '42')).toThrow();
    expect(() => tokenCipherContext('meta_user_token', 'ws', 'a:b')).toThrow();
  });
});

describe('createTokenKeyring', () => {
  function fakeConfig(values: Partial<EnvironmentVariables>) {
    return {
      get: (key: keyof EnvironmentVariables) => values[key],
    } as unknown as ConfigService<EnvironmentVariables, true>;
  }

  it('returns null when the token env vars are unset', () => {
    expect(createTokenKeyring(fakeConfig({}))).toBeNull();
  });

  it('builds the keyring from env', () => {
    const keyring = createTokenKeyring(
      fakeConfig({
        TOKEN_ENCRYPTION_KEY: KEY_B,
        TOKEN_ENCRYPTION_KEY_ID: 'k2',
        TOKEN_ENCRYPTION_PREVIOUS_KEYS: `k1:${KEY_A}`,
      }),
    );
    expect(keyring?.current.id).toBe('k2');
    expect([...(keyring?.keys.keys() ?? [])]).toEqual(['k2', 'k1']);
  });
});

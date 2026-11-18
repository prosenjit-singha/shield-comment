import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { validateEnv } from './env.validation.js';

const BASE = {
  DATABASE_URL: 'postgresql://shield:shield@localhost:5432/shield_comment',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'unit-test-better-auth-secret-0123456789',
  BETTER_AUTH_URL: 'http://localhost:3000',
};
const KEY = randomBytes(32).toString('base64');
const OLD_KEY = randomBytes(32).toString('base64');

function expectInvalid(env: Record<string, unknown>, field: string) {
  let message = '';
  try {
    validateEnv({ ...BASE, ...env });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain(field);
  // Never echo key material into logs.
  expect(message).not.toContain(KEY);
  expect(message).not.toContain(OLD_KEY);
}

describe('validateEnv: token cipher', () => {
  it('accepts no token env (cipher disabled)', () => {
    const env = validateEnv(BASE);
    expect(env.TOKEN_ENCRYPTION_KEY).toBeUndefined();
  });

  it('accepts a 32-byte key with an id and previous keys', () => {
    const env = validateEnv({
      ...BASE,
      TOKEN_ENCRYPTION_KEY: KEY,
      TOKEN_ENCRYPTION_KEY_ID: 'k2026b',
      TOKEN_ENCRYPTION_PREVIOUS_KEYS: `k2026a:${OLD_KEY}`,
    });
    expect(env.TOKEN_ENCRYPTION_KEY_ID).toBe('k2026b');
  });

  it.each([
    ['31 bytes', randomBytes(31).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['64-char hex', randomBytes(32).toString('hex')],
    ['empty', ''],
  ])('rejects a key of bad length/encoding: %s', (_name, key) => {
    expectInvalid(
      { TOKEN_ENCRYPTION_KEY: key, TOKEN_ENCRYPTION_KEY_ID: 'k1' },
      'TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes',
    );
  });

  it('rejects a key without an id, and an id without a key', () => {
    expectInvalid({ TOKEN_ENCRYPTION_KEY: KEY }, 'TOKEN_ENCRYPTION_KEY_ID');
    expectInvalid(
      { TOKEN_ENCRYPTION_KEY_ID: 'k1' },
      'TOKEN_ENCRYPTION_KEY must be base64',
    );
  });

  it('rejects a key id with ":" or spaces', () => {
    expectInvalid(
      { TOKEN_ENCRYPTION_KEY: KEY, TOKEN_ENCRYPTION_KEY_ID: 'k:1' },
      'TOKEN_ENCRYPTION_KEY_ID must match',
    );
  });

  it('rejects previous keys without a current key', () => {
    expectInvalid(
      { TOKEN_ENCRYPTION_PREVIOUS_KEYS: `k0:${OLD_KEY}` },
      'TOKEN_ENCRYPTION_KEY must be base64',
    );
  });

  it.each([
    [
      'bad previous key length',
      `k0:${randomBytes(16).toString('base64')}`,
      'must be base64 of exactly 32 bytes',
    ],
    ['reused current id', `k1:${OLD_KEY}`, 'must not reuse the current key id'],
    ['duplicate previous ids', `k0:${OLD_KEY},k0:${OLD_KEY}`, 'listed twice'],
  ])('rejects %s', (_name, previous, message) => {
    expectInvalid(
      {
        TOKEN_ENCRYPTION_KEY: KEY,
        TOKEN_ENCRYPTION_KEY_ID: 'k1',
        TOKEN_ENCRYPTION_PREVIOUS_KEYS: previous,
      },
      message,
    );
  });
});

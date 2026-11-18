import { randomBytes } from 'node:crypto';
import {
  buildTokenKeyring,
  decodeAes256Key,
  parsePreviousTokenKeys,
} from './token-keyring.js';

const KEY = randomBytes(32).toString('base64');
const OTHER = randomBytes(32).toString('base64');

describe('decodeAes256Key', () => {
  it('accepts canonical base64 of 32 bytes', () => {
    expect(decodeAes256Key(KEY)).toHaveLength(32);
  });

  it.each([
    ['31 bytes', randomBytes(31).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['16 bytes', randomBytes(16).toString('base64')],
    ['empty', ''],
    ['base64url alphabet', randomBytes(32).toString('base64url')],
    ['hex', randomBytes(32).toString('hex')],
    ['raw 32 chars', 'x'.repeat(32)],
    ['missing padding', KEY.replace(/=+$/, '')],
  ])('rejects %s', (_name, value) => {
    expect(decodeAes256Key(value)).toBeNull();
  });
});

describe('parsePreviousTokenKeys', () => {
  it('parses id:key entries, ignoring blanks and spaces', () => {
    const keys = parsePreviousTokenKeys(` k1:${KEY} , ,k0:${OTHER}`);
    expect(keys.map((k) => k.id)).toEqual(['k1', 'k0']);
  });

  it.each([
    ['missing id', `:${KEY}`],
    ['missing separator', KEY],
    ['bad id', `k 1:${KEY}`],
    ['bad key', 'k1:not-a-key'],
    ['duplicate id', `k1:${KEY},k1:${OTHER}`],
  ])('rejects %s without echoing key material', (_name, value) => {
    let message = '';
    try {
      parsePreviousTokenKeys(value);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(KEY);
    expect(message).not.toContain(OTHER);
  });
});

describe('buildTokenKeyring', () => {
  it('returns null when nothing is set', () => {
    expect(buildTokenKeyring({})).toBeNull();
  });

  it.each([
    ['key without id', { key: KEY }],
    ['id without key', { keyId: 'k1' }],
    ['previous keys only', { previousKeys: `k0:${OTHER}` }],
    [
      'bad key length',
      { key: randomBytes(24).toString('base64'), keyId: 'k1' },
    ],
    ['bad key id', { key: KEY, keyId: 'k:1' }],
    [
      'previous reuses current id',
      { key: KEY, keyId: 'k1', previousKeys: `k1:${OTHER}` },
    ],
  ])('throws for %s', (_name, env) => {
    expect(() => buildTokenKeyring(env)).toThrow();
  });
});

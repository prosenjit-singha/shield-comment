import { createHmac } from 'node:crypto';
import {
  checkMetaVerifyRequest,
  checkMetaWebhookSignature,
  metaWebhookSignature,
  verifyTokenMatches,
} from './meta-webhook-signature.js';

const SECRET = 'meta-app-secret-0123456789abcdef';
const BODY = Buffer.from(
  '{"object":"page","entry":[{"id":"1","time":1,"changes":[]}]}',
);
const hex = (body: Buffer | string, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

describe('metaWebhookSignature', () => {
  it('is sha256= + the hex HMAC of the bytes (Meta format)', () => {
    expect(metaWebhookSignature(BODY, SECRET)).toBe(`sha256=${hex(BODY)}`);
    expect(metaWebhookSignature(BODY.toString(), SECRET)).toBe(
      metaWebhookSignature(BODY, SECRET),
    );
  });
});

describe('checkMetaWebhookSignature', () => {
  const check = (header: string | string[] | undefined, body = BODY) =>
    checkMetaWebhookSignature(body, header, SECRET);

  it('accepts the right signature (lower- or upper-case hex)', () => {
    expect(check(`sha256=${hex(BODY)}`)).toBe('ok');
    expect(check(`sha256=${hex(BODY).toUpperCase()}`)).toBe('ok');
  });

  it('rejects a signature made with another secret', () => {
    expect(check(`sha256=${hex(BODY, 'another-app-secret-0123456789')}`)).toBe(
      'mismatch',
    );
  });

  it('rejects a tampered body (one byte, or re-serialised JSON)', () => {
    const signature = `sha256=${hex(BODY)}`;
    const tampered = Buffer.from(BODY);
    tampered[tampered.length - 2] ^= 1;
    expect(check(signature, tampered)).toBe('mismatch');
    const reserialised = Buffer.from(
      JSON.stringify(JSON.parse(BODY.toString()), null, 2),
    );
    expect(check(signature, reserialised)).toBe('mismatch');
  });

  it('treats a missing or empty header as missing', () => {
    expect(check(undefined)).toBe('missing');
    expect(check('')).toBe('missing');
  });

  it.each([
    ['no prefix', hex(BODY)],
    ['sha1 prefix', `sha1=${hex(BODY)}`],
    ['short hex', `sha256=${hex(BODY).slice(0, 62)}`],
    ['long hex', `sha256=${hex(BODY)}00`],
    ['non-hex', `sha256=${'z'.repeat(64)}`],
    ['prefix only', 'sha256='],
  ])('rejects a malformed header (%s)', (_label, header) => {
    expect(check(header)).toBe('malformed');
  });

  it('rejects a repeated header', () => {
    const signature = `sha256=${hex(BODY)}`;
    expect(check([signature, signature])).toBe('malformed');
  });

  it('checks an empty body like any other (signature of zero bytes)', () => {
    const empty = Buffer.alloc(0);
    expect(check(`sha256=${hex(empty)}`, empty)).toBe('ok');
    expect(check(`sha256=${hex(BODY)}`, empty)).toBe('mismatch');
  });
});

describe('verifyTokenMatches', () => {
  const TOKEN = 'verify-token-0123456789abcdef';

  it('matches only the exact token', () => {
    expect(verifyTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(verifyTokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(verifyTokenMatches(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(verifyTokenMatches(TOKEN.toUpperCase(), TOKEN)).toBe(false);
  });

  it('rejects missing, empty and non-string values', () => {
    expect(verifyTokenMatches(undefined, TOKEN)).toBe(false);
    expect(verifyTokenMatches('', TOKEN)).toBe(false);
    expect(verifyTokenMatches([TOKEN, TOKEN], TOKEN)).toBe(false);
  });
});

describe('checkMetaVerifyRequest', () => {
  const TOKEN = 'verify-token-0123456789abcdef';
  const query = (overrides: Record<string, unknown> = {}) => ({
    'hub.mode': 'subscribe',
    'hub.verify_token': TOKEN,
    'hub.challenge': '1158201444',
    ...overrides,
  });

  it('returns the challenge for subscribe + the right token', () => {
    expect(checkMetaVerifyRequest(query(), TOKEN)).toEqual({
      ok: true,
      challenge: '1158201444',
    });
  });

  it.each([
    ['wrong token', { 'hub.verify_token': 'wrong-token-0123456789abcdef' }],
    ['missing token', { 'hub.verify_token': undefined }],
    ['wrong mode', { 'hub.mode': 'unsubscribe' }],
    ['missing mode', { 'hub.mode': undefined }],
    ['missing challenge', { 'hub.challenge': undefined }],
    ['empty challenge', { 'hub.challenge': '' }],
    ['challenge with a space', { 'hub.challenge': '1 2' }],
    ['challenge with markup', { 'hub.challenge': '<script>x</script> ' }],
    ['overlong challenge', { 'hub.challenge': '1'.repeat(513) }],
    ['repeated challenge', { 'hub.challenge': ['1', '2'] }],
    ['repeated mode', { 'hub.mode': ['subscribe', 'subscribe'] }],
  ])('fails on %s', (_label, overrides) => {
    expect(checkMetaVerifyRequest(query(overrides), TOKEN)).toEqual({
      ok: false,
    });
  });
});

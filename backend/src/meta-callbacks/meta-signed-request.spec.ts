import { createHmac } from 'node:crypto';
import {
  parseMetaSignedRequest,
  SIGNED_REQUEST_MAX_LENGTH,
  signedRequestFailureStatus,
  signMetaSignedRequest,
} from './meta-signed-request.js';

const SECRET = 'unit-app-secret';
const PAYLOAD = {
  algorithm: 'HMAC-SHA256',
  issued_at: 1795000000,
  user_id: '10000000000001',
};

/** Signs an already-encoded payload part (to test non-JSON / odd encodings). */
function signRaw(encodedPayload: string, secret = SECRET): string {
  const sig = createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');
  return `${sig}.${encodedPayload}`;
}
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

describe('parseMetaSignedRequest', () => {
  it('accepts a request signed like Meta does', () => {
    expect(
      parseMetaSignedRequest(signMetaSignedRequest(PAYLOAD, SECRET), SECRET),
    ).toEqual({
      ok: true,
      value: { userId: '10000000000001', issuedAt: 1795000000 },
    });
  });

  it('matches an independently built Meta-style value (base64url HMAC of the payload part)', () => {
    const encoded = b64(JSON.stringify(PAYLOAD));
    expect(signMetaSignedRequest(PAYLOAD, SECRET)).toBe(signRaw(encoded));
  });

  it('accepts the algorithm in any case, a numeric user_id and no issued_at', () => {
    const result = parseMetaSignedRequest(
      signMetaSignedRequest(
        { algorithm: 'hmac-sha256', user_id: 10000000000001 },
        SECRET,
      ),
      SECRET,
    );
    expect(result).toEqual({
      ok: true,
      value: { userId: '10000000000001', issuedAt: null },
    });
  });

  it('accepts a padded payload part', () => {
    let json = JSON.stringify(PAYLOAD);
    while (json.length % 3 === 0) json += ' ';
    const padded = Buffer.from(json, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(padded).toMatch(/=$/);
    expect(parseMetaSignedRequest(signRaw(padded), SECRET).ok).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['an array (repeated field)', ['a.b', 'c.d']],
    ['an object', { a: 'b' }],
    ['a number', 42],
  ])('missing: %s', (_label, value) => {
    expect(parseMetaSignedRequest(value, SECRET)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it.each([
    ['one part', 'abc'],
    ['three parts', 'a.b.c'],
    ['empty signature', `.${b64('{}')}`],
    ['empty payload', 'abc.'],
    ['non-base64url characters', 'ab+c/.de$f'],
    ['a signature of the wrong length', `${b64('short')}.${b64('{}')}`],
    ['too long', `${'a'.repeat(SIGNED_REQUEST_MAX_LENGTH)}.b`],
  ])('malformed: %s', (_label, value) => {
    expect(parseMetaSignedRequest(value, SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('bad_signature: signed with another secret', () => {
    expect(
      parseMetaSignedRequest(
        signMetaSignedRequest(PAYLOAD, 'other-secret'),
        SECRET,
      ),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('bad_signature: payload changed after signing (user id swapped)', () => {
    const [sig] = signMetaSignedRequest(PAYLOAD, SECRET).split('.');
    const forged = b64(JSON.stringify({ ...PAYLOAD, user_id: '2' }));
    expect(parseMetaSignedRequest(`${sig}.${forged}`, SECRET)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it.each([
    ['not JSON', b64('not json')],
    ['a JSON array', b64('[1,2]')],
    ['JSON null', b64('null')],
    ['a JSON string', b64('"x"')],
  ])('bad_payload (signed): %s', (_label, encoded) => {
    expect(parseMetaSignedRequest(signRaw(encoded), SECRET)).toEqual({
      ok: false,
      reason: 'bad_payload',
    });
  });

  it.each([
    ['missing', { user_id: '1' }],
    ['another algorithm', { algorithm: 'HMAC-SHA1', user_id: '1' }],
    ['not a string', { algorithm: 1, user_id: '1' }],
  ])('bad_algorithm: %s', (_label, payload) => {
    expect(
      parseMetaSignedRequest(signMetaSignedRequest(payload, SECRET), SECRET),
    ).toEqual({ ok: false, reason: 'bad_algorithm' });
  });

  it.each([
    ['missing', {}],
    ['empty', { user_id: '' }],
    ['not numeric', { user_id: 'abc' }],
    ['negative number', { user_id: -1 }],
    ['fraction', { user_id: 1.5 }],
    ['too long', { user_id: '1'.repeat(33) }],
    ['null', { user_id: null }],
  ])('bad_user_id: %s', (_label, extra) => {
    expect(
      parseMetaSignedRequest(
        signMetaSignedRequest({ algorithm: 'HMAC-SHA256', ...extra }, SECRET),
        SECRET,
      ),
    ).toEqual({ ok: false, reason: 'bad_user_id' });
  });

  it('ignores a non-numeric issued_at', () => {
    const result = parseMetaSignedRequest(
      signMetaSignedRequest({ ...PAYLOAD, issued_at: 'soon' }, SECRET),
      SECRET,
    );
    expect(result).toEqual({
      ok: true,
      value: { userId: PAYLOAD.user_id, issuedAt: null },
    });
  });
});

describe('signedRequestFailureStatus', () => {
  it('401 only for a signature that does not verify, else 400', () => {
    expect(signedRequestFailureStatus('bad_signature')).toBe(401);
    for (const reason of [
      'missing',
      'malformed',
      'bad_payload',
      'bad_algorithm',
      'bad_user_id',
    ] as const) {
      expect(signedRequestFailureStatus(reason)).toBe(400);
    }
  });
});

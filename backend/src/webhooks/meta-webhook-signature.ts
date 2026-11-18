import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Header Meta signs every webhook `POST` with (lower-cased, as Node exposes it). */
export const META_SIGNATURE_HEADER = 'x-hub-signature-256';

const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

/** `sha256=<hex>`: HMAC-SHA256 of the exact request bytes with the app secret (Meta's format). */
export function metaWebhookSignature(
  rawBody: Buffer | string,
  appSecret: string,
): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

export type MetaSignatureCheck = 'ok' | 'missing' | 'malformed' | 'mismatch';

/**
 * Checks `X-Hub-Signature-256` against the raw body. Shape and length are checked first, then the
 * digests are compared with `timingSafeEqual`. A repeated header (array) counts as malformed.
 */
export function checkMetaWebhookSignature(
  rawBody: Buffer,
  header: string | string[] | undefined,
  appSecret: string,
): MetaSignatureCheck {
  if (header === undefined || header === '') return 'missing';
  if (typeof header !== 'string') return 'malformed';
  const match = SIGNATURE_PATTERN.exec(header.trim());
  if (!match) return 'malformed';
  const provided = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  if (provided.length !== expected.length) return 'malformed';
  return timingSafeEqual(provided, expected) ? 'ok' : 'mismatch';
}

/**
 * Constant-time string compare for the verify token: both sides are hashed first, so neither the
 * content nor the length of the expected token leaks through timing.
 */
export function verifyTokenMatches(
  provided: unknown,
  expected: string,
): boolean {
  if (typeof provided !== 'string' || provided === '') return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

const CHALLENGE_PATTERN = /^[!-~]{1,512}$/;

export type MetaVerifyResult = { ok: true; challenge: string } | { ok: false };

/**
 * Meta's subscription handshake (`GET` with `hub.mode`, `hub.verify_token`, `hub.challenge`).
 * The query is read raw (keys contain dots). Repeated keys (arrays) fail. The challenge must be
 * 1–512 printable ASCII characters (Meta sends a number); it is echoed as `text/plain`.
 */
export function checkMetaVerifyRequest(
  query: Record<string, unknown>,
  verifyToken: string,
): MetaVerifyResult {
  const mode = query['hub.mode'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe') return { ok: false };
  if (typeof challenge !== 'string' || !CHALLENGE_PATTERN.test(challenge)) {
    return { ok: false };
  }
  if (!verifyTokenMatches(query['hub.verify_token'], verifyToken)) {
    return { ok: false };
  }
  return { ok: true, challenge };
}

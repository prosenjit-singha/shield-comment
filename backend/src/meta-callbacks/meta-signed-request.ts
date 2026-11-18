import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta `signed_request` (Deauthorize + Data Deletion callbacks, Module 4 D6, M4-T6):
 * `<base64url HMAC-SHA256 signature>.<base64url JSON payload>`, signed with the app secret over the
 * encoded payload part. The payload carries `algorithm: "HMAC-SHA256"`, `user_id` (app-scoped
 * Facebook user id) and `issued_at`.
 *
 * Pure helper: never logs and never echoes the value. The signature is checked on the encoded
 * payload **before** its JSON is parsed.
 */

/** Longest `signed_request` accepted (real ones are a few hundred bytes). */
export const SIGNED_REQUEST_MAX_LENGTH = 8192;

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const NUMERIC_ID = /^[0-9]{1,32}$/;
const HMAC_SHA256_BYTES = 32;

export type SignedRequestFailure =
  /** No `signed_request` value (absent, empty, or not a single string). */
  | 'missing'
  /** Not two base64url parts, too long, or a signature of the wrong length. */
  | 'malformed'
  /** The HMAC doesn't match: not signed with our app secret. */
  | 'bad_signature'
  /** Signed, but the payload isn't a JSON object. */
  | 'bad_payload'
  /** Signed, but `algorithm` isn't `HMAC-SHA256`. */
  | 'bad_algorithm'
  /** Signed, but `user_id` is missing or not a numeric id. */
  | 'bad_user_id';

export interface MetaSignedRequest {
  /** App-scoped Facebook user id (= `meta_connections.facebook_user_id`). */
  userId: string;
  /** Unix seconds; `null` when absent. Informational only (not enforced). */
  issuedAt: number | null;
}

export type SignedRequestResult =
  | { ok: true; value: MetaSignedRequest }
  | { ok: false; reason: SignedRequestFailure };

/**
 * HTTP status per failure (recorded choice): a value that isn't a signed_request at all, or a
 * signed payload we can't use → 400; a signature that doesn't verify → 401 (like the webhook HMAC).
 */
export function signedRequestFailureStatus(
  reason: SignedRequestFailure,
): 400 | 401 {
  return reason === 'bad_signature' ? 401 : 400;
}

/** Parses and verifies a `signed_request` with the app secret. */
export function parseMetaSignedRequest(
  value: unknown,
  appSecret: string,
): SignedRequestResult {
  if (typeof value !== 'string' || value === '') {
    return fail('missing');
  }
  if (value.length > SIGNED_REQUEST_MAX_LENGTH) return fail('malformed');
  const parts = value.split('.');
  if (parts.length !== 2) return fail('malformed');
  const [encodedSignature, encodedPayload] = parts as [string, string];
  if (!BASE64URL.test(encodedSignature) || !BASE64URL.test(encodedPayload)) {
    return fail('malformed');
  }

  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== HMAC_SHA256_BYTES) return fail('malformed');
  const expected = createHmac('sha256', appSecret)
    .update(encodedPayload)
    .digest();
  if (!timingSafeEqual(signature, expected)) return fail('bad_signature');

  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    );
  } catch {
    return fail('bad_payload');
  }
  if (!isRecord(payload)) return fail('bad_payload');

  const algorithm = payload.algorithm;
  if (
    typeof algorithm !== 'string' ||
    algorithm.toUpperCase() !== 'HMAC-SHA256'
  ) {
    return fail('bad_algorithm');
  }

  const userId = toNumericId(payload.user_id);
  if (!userId) return fail('bad_user_id');

  const issuedAt =
    typeof payload.issued_at === 'number' && Number.isFinite(payload.issued_at)
      ? payload.issued_at
      : null;
  return { ok: true, value: { userId, issuedAt } };
}

/**
 * Builds a `signed_request` the way Meta does (test fixtures, local smoke scripts). `payload` is
 * sent as is, so tests can also sign broken payloads.
 */
export function signMetaSignedRequest(
  payload: unknown,
  appSecret: string,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const signature = createHmac('sha256', appSecret)
    .update(encodedPayload)
    .digest('base64url');
  return `${signature}.${encodedPayload}`;
}

function toNumericId(value: unknown): string | null {
  if (typeof value === 'string') return NUMERIC_ID.test(value) ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(reason: SignedRequestFailure): SignedRequestResult {
  return { ok: false, reason };
}

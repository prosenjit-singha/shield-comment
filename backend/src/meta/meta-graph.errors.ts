/**
 * Typed Graph API failures. Messages never contain tokens, the app secret or request URLs (the URL
 * carries `access_token` / `client_secret`), so they are safe to log.
 */

/**
 * - `token_invalid`: code 190 / 102 (expired, revoked, password changed, app removed) → the
 *   connection goes `NEEDS_REAUTH` (decision D8).
 * - `rate_limited`: 4, 17, 32, 613, 80000–80014 (app / user / Page / business-use-case limits).
 * - `permission`: 10, 200–299 (permission missing or not granted).
 * - `invalid_request`: 100 (bad parameter; also an invalid, expired or reused OAuth `code`).
 * - `not_found`: 100 with subcode 33 ("Object with ID … does not exist, cannot be loaded due to
 *   missing permissions, or does not support this operation"): the comment is already gone
 *   (M5-T9; a DELETE treats it as done). Not retryable.
 * - `transient`: 1, 2, `is_transient`, or HTTP 5xx without a Graph error body.
 * - `network`: fetch failed or timed out (no response).
 * - `unexpected_response`: 2xx with a body we can't read, or too many result pages.
 * - `unknown`: any other Graph error.
 */
export type MetaGraphErrorKind =
  | 'token_invalid'
  | 'rate_limited'
  | 'permission'
  | 'invalid_request'
  | 'not_found'
  | 'transient'
  | 'network'
  | 'unexpected_response'
  | 'unknown';

const RETRYABLE: ReadonlySet<MetaGraphErrorKind> = new Set([
  'rate_limited',
  'transient',
  'network',
]);

export interface MetaGraphErrorDetails {
  /** HTTP status; `null` for network failures. */
  status?: number | null;
  code?: number;
  subcode?: number;
  type?: string;
  fbtraceId?: string;
}

export class MetaGraphError extends Error {
  readonly status: number | null;
  readonly code?: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly fbtraceId?: string;

  constructor(
    readonly kind: MetaGraphErrorKind,
    message: string,
    details: MetaGraphErrorDetails = {},
  ) {
    super(message);
    this.name = 'MetaGraphError';
    this.status = details.status ?? null;
    this.code = details.code;
    this.subcode = details.subcode;
    this.type = details.type;
    this.fbtraceId = details.fbtraceId;
  }

  /** Worth retrying later (BullMQ backoff in Module 4). */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

export class MetaNotConfiguredError extends Error {
  constructor() {
    super(
      'Meta app is not configured (META_APP_ID, META_APP_SECRET, META_LOGIN_CONFIG_ID, META_OAUTH_REDIRECT_URI)',
    );
    this.name = 'MetaNotConfiguredError';
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const TOKEN_CODES = new Set([102, 190]);
/** Graph error subcode of code 100 for "object does not exist" (M5-T9). */
const OBJECT_MISSING_SUBCODE = 33;
/** Meta messages are short; cap them anyway so an odd body can't flood logs. */
const MESSAGE_MAX = 300;

export function graphErrorKind(
  code: number | undefined,
  status: number,
  isTransient: boolean,
  subcode?: number,
): MetaGraphErrorKind {
  if (code !== undefined) {
    if (TOKEN_CODES.has(code)) return 'token_invalid';
    if (RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014)) {
      return 'rate_limited';
    }
    if (code === 10 || (code >= 200 && code <= 299)) return 'permission';
    if (code === 100) {
      return subcode === OBJECT_MISSING_SUBCODE
        ? 'not_found'
        : 'invalid_request';
    }
    if (code === 1 || code === 2 || isTransient) return 'transient';
    return 'unknown';
  }
  if (isTransient || status >= 500) return 'transient';
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const num = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;
const str = (value: unknown) =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Meta access tokens start with `EAA`; long runs of token characters after it are redacted. */
const TOKEN_LIKE = /EAA[A-Za-z0-9_-]{20,}/g;

/** Removes the request's secrets (tokens, app secret, OAuth code) and token-shaped strings. */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out.replace(TOKEN_LIKE, '[redacted]');
}

/**
 * Maps a non-2xx Graph response (`{ error: { message, type, code, error_subcode, … } }`).
 * `secrets` = values sent with the request; they are scrubbed from Meta's message.
 */
export function graphErrorFromResponse(
  status: number,
  body: unknown,
  secrets: readonly string[] = [],
): MetaGraphError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = num(error?.code);
  const subcode = num(error?.error_subcode);
  const kind = graphErrorKind(
    code,
    status,
    error?.is_transient === true,
    subcode,
  );
  const raw = redactSecrets(str(error?.message) ?? `HTTP ${status}`, secrets);
  const text = raw.length > MESSAGE_MAX ? `${raw.slice(0, MESSAGE_MAX)}…` : raw;
  const codes =
    code === undefined ? '' : ` (#${code}${subcode ? `/${subcode}` : ''})`;
  return new MetaGraphError(kind, `Meta Graph ${status}${codes}: ${text}`, {
    status,
    code,
    subcode,
    type: str(error?.type),
    fbtraceId: str(error?.fbtrace_id),
  });
}

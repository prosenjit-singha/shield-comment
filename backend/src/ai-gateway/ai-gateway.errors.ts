import type { AiProvider } from './ai-provider.js';

/**
 * Typed LLM failures (M5-T1, decision D2). Messages never contain API keys or request URLs, so
 * they are safe to log; provider messages are scrubbed and capped.
 *
 * - `not_configured`: no provider config / no adapter for the provider. Not retried.
 * - `payment_required`: 402 (Anthropic `billing_error`), Neon 403 `paid_plan_required`, OpenAI 429
 *   `insufficient_quota`, Anthropic 429 `enforced_spend_limit_reached` (spend cap) and 400 "credit
 *   balance is too low". Not retried.
 * - `auth`: 401, any other 403, Gemini 400 `API_KEY_INVALID`. Not retried.
 * - `rate_limited`: 429 (honour `retryAfterMs`). Retried.
 * - `transient`: 5xx (incl. Anthropic 529 `overloaded_error`), 408. Retried.
 * - `timeout`: the per-call timeout fired. Retried.
 * - `network`: fetch failed before a response. Retried.
 * - `invalid_request`: 400 / 404 / 422 / other 4xx (unknown model, `response_format` refused,
 *   bad parameter). Not retried; M5-T5 falls back from `json_schema` on it.
 * - `unexpected_response`: 2xx with a non-JSON body, no choices or empty content. One retry is
 *   left to the caller (D2: "one invalid JSON").
 */
export type AiErrorKind =
  | 'not_configured'
  | 'payment_required'
  | 'auth'
  | 'rate_limited'
  | 'transient'
  | 'timeout'
  | 'network'
  | 'invalid_request'
  | 'unexpected_response';

/**
 * `reason` of an `unexpected_response` whose 2xx answer had no text (e.g. a reasoning model cut
 * off by a tiny `max_tokens`). `testConnection` counts it as reachable.
 */
export const EMPTY_CONTENT_REASON = 'empty_content';

const RETRYABLE: ReadonlySet<AiErrorKind> = new Set([
  'rate_limited',
  'transient',
  'timeout',
  'network',
]);

export function isRetryableAiErrorKind(kind: AiErrorKind): boolean {
  return RETRYABLE.has(kind);
}

export interface AiGatewayErrorDetails {
  /** HTTP status; `null` when there was no response (network, timeout, not configured). */
  status?: number | null;
  /** Neon `unavailable_reason` or the provider's error `code`/`type` (e.g. `insufficient_quota`). */
  reason?: string;
  /** Provider's `error.param` when given (OpenAI names `response_format` on a schema refusal). */
  param?: string;
  /** From `Retry-After` / `retry-after-ms`, capped at `MAX_RETRY_AFTER_MS`. */
  retryAfterMs?: number;
  provider?: AiProvider;
}

export class AiGatewayError extends Error {
  readonly status: number | null;
  readonly reason?: string;
  readonly param?: string;
  readonly retryAfterMs?: number;
  readonly provider?: AiProvider;

  constructor(
    readonly kind: AiErrorKind,
    message: string,
    details: AiGatewayErrorDetails = {},
  ) {
    super(message);
    this.name = 'AiGatewayError';
    this.status = details.status ?? null;
    this.reason = details.reason;
    this.param = details.param;
    this.retryAfterMs = details.retryAfterMs;
    this.provider = details.provider;
  }

  /** Worth retrying later (BullMQ backoff, D2). */
  get retryable(): boolean {
    return isRetryableAiErrorKind(this.kind);
  }
}

/** Same `kind` as any other `not_configured` failure; kept as a class for `instanceof` checks. */
export class AiGatewayNotConfiguredError extends AiGatewayError {
  constructor(message?: string, provider?: AiProvider) {
    super(
      'not_configured',
      message ??
        'AI provider is not configured (AI_PROVIDER + its key, e.g. NEON_AI_GATEWAY_BASE_URL + NEON_AI_GATEWAY_TOKEN)',
      { provider },
    );
    this.name = 'AiGatewayNotConfiguredError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export interface AiErrorBodyDetails {
  message?: string;
  /** `unavailable_reason` (Neon) or the error `code` (string) / `type` / `status` (Gemini). */
  reason?: string;
  type?: string;
  code?: string;
  param?: string;
}

/**
 * Reads the provider error body: OpenAI/Neon `{ error: { message, type, code, param,
 * unavailable_reason } }`, Neon `{ message, unavailable_reason }`, Gemini OpenAI-compat
 * `[{ error: { code, message, status, details } }]`, Anthropic `{ type: 'error', error: { type,
 * message, details?: { error_code } } }`.
 */
export function aiErrorDetails(body: unknown): AiErrorBodyDetails {
  const root = Array.isArray(body) ? (body[0] as unknown) : body;
  if (!isRecord(root)) return {};
  const inner = isRecord(root.error) ? root.error : root;
  const type = str(inner.type) ?? str(inner.status);
  // Anthropic: `{ type: 'error', error: { type, message, details?: { error_code } } }`.
  const details = isRecord(inner.details) ? inner.details : {};
  const code =
    str(inner.code) ??
    (typeof inner.code === 'number' ? String(inner.code) : undefined) ??
    str(details.error_code);
  const unavailable =
    str(inner.unavailable_reason) ?? str(root.unavailable_reason);
  const reason =
    unavailable ??
    (code && !/^\d+$/.test(code) ? code : undefined) ??
    type ??
    undefined;
  return {
    message: str(inner.message),
    reason,
    type,
    code,
    param: str(inner.param),
  };
}

/** Gemini answers a bad key with 400 `INVALID_ARGUMENT` + `details[].reason: API_KEY_INVALID`. */
function isInvalidApiKeyBody(body: unknown): boolean {
  const text = JSON.stringify(body ?? null);
  return text.includes('API_KEY_INVALID') || /API key not valid/i.test(text);
}

const PAYMENT_REASONS = new Set([
  'paid_plan_required',
  'insufficient_quota',
  'billing_not_active',
  // Anthropic: 402 type, and the 429 monthly spend cap (`error.details.error_code`).
  'billing_error',
  'enforced_spend_limit_reached',
  // Neon AI Gateway: 429 when the AI credits are used up (D26).
  'credits_required',
]);

/** Anthropic answers an organization without credits with 400 "Your credit balance is too low…". */
function isNoCreditBody(body: unknown): boolean {
  return /credit balance is too low/i.test(aiErrorDetails(body).message ?? '');
}

/** HTTP status + error body → kind. Pure; shared by every adapter (M5-T2 maps Anthropic onto it). */
export function aiErrorKind(status: number, body: unknown): AiErrorKind {
  const { reason, type, code } = aiErrorDetails(body);
  const tags = [reason, type, code].filter((t): t is string => Boolean(t));
  const paymentTag = tags.some((t) => PAYMENT_REASONS.has(t));
  if (status === 402) return 'payment_required';
  if (status === 401) return 'auth';
  if (status === 403) return paymentTag ? 'payment_required' : 'auth';
  if (status === 429) return paymentTag ? 'payment_required' : 'rate_limited';
  if (status === 408 || status >= 500) return 'transient';
  if (status === 400 && isInvalidApiKeyBody(body)) return 'auth';
  if (status === 400 && isNoCreditBody(body)) return 'payment_required';
  if (status >= 400) return 'invalid_request';
  return 'unexpected_response';
}

/** Longest wait we pass on; a bigger `Retry-After` is clamped (BullMQ backoff takes over). */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

/**
 * `Retry-After` as delta-seconds (`"7"`, `"1.5"`) or an HTTP date → ms from `now`, clamped to
 * `[0, MAX_RETRY_AFTER_MS]`. `retryAfterMs` (OpenAI's `retry-after-ms`) wins when valid.
 * Missing / unparseable → `undefined`.
 */
export function parseRetryAfter(
  retryAfter: string | null | undefined,
  now: number = Date.now(),
  retryAfterMs?: string | null,
): number | undefined {
  const clamp = (ms: number) =>
    Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
  const msValue = retryAfterMs?.trim();
  if (msValue && /^\d+(\.\d+)?$/.test(msValue)) return clamp(Number(msValue));
  const value = retryAfter?.trim();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return clamp(Number(value) * 1000);
  // HTTP dates name the day/month; anything else (e.g. "-5") is junk, not a date.
  if (!/[A-Za-z]/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : clamp(date - now);
}

/** Key-shaped strings, in case a provider echoes a key we did not send (or a different one). */
const KEY_LIKE =
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|nt_(?:live|test)_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,})/g;

/** Removes `secrets` (the request's API key) and key-shaped strings from `text`. */
export function redactAiSecrets(
  text: string,
  secrets: readonly string[] = [],
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out.replace(KEY_LIKE, '[redacted]');
}

/** Provider messages are short; cap them so an odd body (or echoed input) can't flood logs. */
const MESSAGE_MAX = 300;

/** Builds the error for a non-2xx response. `secrets` are scrubbed from the provider's message. */
export function aiErrorFromResponse(
  provider: AiProvider,
  status: number,
  body: unknown,
  headers: Pick<Headers, 'get'>,
  secrets: readonly string[] = [],
  now: number = Date.now(),
): AiGatewayError {
  const kind = aiErrorKind(status, body);
  const { message, reason, param } = aiErrorDetails(body);
  const raw = redactAiSecrets(message ?? `HTTP ${status}`, secrets);
  const text = raw.length > MESSAGE_MAX ? `${raw.slice(0, MESSAGE_MAX)}…` : raw;
  const safeReason = reason ? redactAiSecrets(reason, secrets) : undefined;
  const retryAfterMs =
    kind === 'rate_limited' || kind === 'transient'
      ? parseRetryAfter(
          headers.get('retry-after'),
          now,
          headers.get('retry-after-ms'),
        )
      : undefined;
  return new AiGatewayError(
    kind,
    `AI ${provider} ${status}${safeReason ? ` (${safeReason})` : ''}: ${text}`,
    { status, reason: safeReason, param, retryAfterMs, provider },
  );
}

/**
 * 400 `invalid_request` whose message matches `pattern` (the provider refused the output format)
 * → same error with `param: 'response_format'`, so M5-T5 falls back to the next output mode.
 */
export function markResponseFormatRefusal(
  error: unknown,
  pattern: RegExp,
): unknown {
  if (
    !(error instanceof AiGatewayError) ||
    error.kind !== 'invalid_request' ||
    error.param !== undefined ||
    !pattern.test(error.message)
  ) {
    return error;
  }
  return new AiGatewayError(error.kind, error.message, {
    status: error.status,
    reason: error.reason,
    param: 'response_format',
    retryAfterMs: error.retryAfterMs,
    provider: error.provider,
  });
}

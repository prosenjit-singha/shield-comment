import { createHash, randomBytes } from 'node:crypto';

/**
 * Meta OAuth `state` (M3-T4, user decision D6 2026-11-18): a random key in Redis, 10-minute TTL,
 * single use (GETDEL), bound to the user + workspace that started the flow and to the client page
 * the callback returns to. Pure helpers; the store is `MetaOAuthStateStore`.
 */

/** Random bytes per state (256 bits). */
export const META_OAUTH_STATE_BYTES = 32;
/** The user has this long to finish the Meta dialog. */
export const META_OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Client pages allowed to start the flow (and to receive the result). First = default. */
export const META_OAUTH_RETURN_PATHS = ['/onboarding', '/pages'] as const;
export type MetaOAuthReturnPath = (typeof META_OAUTH_RETURN_PATHS)[number];
export const DEFAULT_META_OAUTH_RETURN_PATH: MetaOAuthReturnPath =
  '/onboarding';

/** What the state key points to. */
export interface MetaOAuthStateData {
  userId: string;
  workspaceId: string;
  returnTo: MetaOAuthReturnPath;
}

/**
 * `reason` values on `?meta=error&reason=…` (the client maps them to messages):
 * - `access_denied`: the user cancelled / declined the Meta dialog.
 * - `invalid_state`: state missing, malformed, expired or already used.
 * - `unauthenticated`: no session on the callback (the client's `_app` guard then asks to log in).
 * - `state_mismatch`: the session's user or active workspace isn't the one that started the flow.
 * - `impersonation_blocked`: impersonated sessions may not connect Meta (D5).
 * - `forbidden`: no longer owner/admin of the workspace, or the workspace is suspended.
 * - `missing_code`: Meta returned neither a code nor an error.
 * - `not_configured`: Meta app or token cipher env missing on the server.
 * - `meta_unavailable`: Meta rate limit / outage / network (worth retrying).
 * - `meta_error`: Meta rejected the exchange (bad/used code, permissions, other errors).
 * - `server_error`: anything else (DB, Redis).
 */
export const META_OAUTH_ERROR_REASONS = [
  'access_denied',
  'invalid_state',
  'unauthenticated',
  'state_mismatch',
  'impersonation_blocked',
  'forbidden',
  'missing_code',
  'not_configured',
  'meta_unavailable',
  'meta_error',
  'server_error',
] as const;
export type MetaOAuthErrorReason = (typeof META_OAUTH_ERROR_REASONS)[number];

/**
 * `skipped` (M3-T5, D7) = Pages not synced because they (or their IG account) belong to another
 * workspace; sent as `&skipped=N` only when N > 0.
 */
export type MetaOAuthResult =
  { ok: true; skipped?: number } | { ok: false; reason: MetaOAuthErrorReason };

/** base64url of 32 bytes = 43 chars, no padding. */
const STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function generateMetaOAuthState(): string {
  return randomBytes(META_OAUTH_STATE_BYTES).toString('base64url');
}

/** Cheap shape check before touching Redis. */
export function isWellFormedMetaOAuthState(state: unknown): state is string {
  return typeof state === 'string' && STATE_FORMAT.test(state);
}

/** Redis key: sha256 of the state, so a Redis dump can't be replayed against the callback. */
export function metaOAuthStateKey(state: string): string {
  return `meta:oauth-state:${createHash('sha256').update(state, 'utf8').digest('hex')}`;
}

export function isMetaOAuthReturnPath(
  value: unknown,
): value is MetaOAuthReturnPath {
  return (
    typeof value === 'string' &&
    (META_OAUTH_RETURN_PATHS as readonly string[]).includes(value)
  );
}

/** `null` for anything that isn't exactly what `createLoginUrl` stored. */
export function parseMetaOAuthStateData(
  raw: string | null,
): MetaOAuthStateData | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { userId, workspaceId, returnTo } = value as Record<string, unknown>;
  if (
    typeof userId !== 'string' ||
    userId.length === 0 ||
    typeof workspaceId !== 'string' ||
    !UUID.test(workspaceId) ||
    !isMetaOAuthReturnPath(returnTo)
  ) {
    return null;
  }
  return { userId, workspaceId: workspaceId.toLowerCase(), returnTo };
}

/**
 * `<clientOrigin><returnTo>?meta=connected` (+ `&skipped=N` when Pages were skipped) or
 * `?meta=error&reason=<reason>`.
 */
export function metaOAuthClientRedirect(
  clientOrigin: string,
  returnTo: MetaOAuthReturnPath,
  result: MetaOAuthResult,
): string {
  const url = new URL(returnTo, clientOrigin);
  if (result.ok) {
    url.searchParams.set('meta', 'connected');
    if (result.skipped !== undefined && result.skipped > 0) {
      url.searchParams.set('skipped', String(result.skipped));
    }
  } else {
    url.searchParams.set('meta', 'error');
    url.searchParams.set('reason', result.reason);
  }
  return url.toString();
}

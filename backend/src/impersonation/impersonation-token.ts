import { createHash, randomBytes } from 'node:crypto';

/**
 * 1-click impersonation tokens (M1-T3). Pure helpers, shared by the admin endpoint that issues a
 * token (src/admin/admin-impersonation.service.ts) and the Better Auth exchange that burns it
 * (src/auth/impersonation-exchange.plugin.ts).
 */

/** Random bytes per token (256 bits). */
export const IMPERSONATION_TOKEN_BYTES = 32;
/** A token must be exchanged within this many seconds. */
export const IMPERSONATION_TOKEN_TTL_SECONDS = 60;
/** The impersonated session lasts exactly this long and is never refreshed (user decision, M1-T3). */
export const IMPERSONATION_SESSION_SECONDS = 60 * 60;

/** base64url of 32 bytes = 43 chars, no padding. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function generateImpersonationToken(): string {
  return randomBytes(IMPERSONATION_TOKEN_BYTES).toString('base64url');
}

/** sha256(token) as hex: the only form that reaches the database. */
export function hashImpersonationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cheap shape check before touching the database. */
export function isWellFormedImpersonationToken(
  token: unknown,
): token is string {
  return typeof token === 'string' && TOKEN_FORMAT.test(token);
}

export function impersonationTokenExpiry(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + IMPERSONATION_TOKEN_TTL_SECONDS * 1000);
}

export function impersonationSessionExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + IMPERSONATION_SESSION_SECONDS * 1000);
}

export type RedeemFailure = 'unknown' | 'expired' | 'used';

/**
 * Why a token can't be redeemed at `now`, or `null` if it can. The exchange's atomic
 * `UPDATE … WHERE used_at IS NULL AND expires_at > now` applies the same rules; this explains a miss.
 * A token is dead from `expiresAt` on (exclusive bound).
 */
export function redeemFailure(
  row: { expiresAt: Date; usedAt: Date | null } | undefined,
  now: Date,
): RedeemFailure | null {
  if (!row) return 'unknown';
  if (row.usedAt) return 'used';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return null;
}

/** `<client origin>/impersonate?token=…` (the client app's exchange page, Module 3). */
export function impersonationRedirectUrl(
  clientOrigin: string,
  token: string,
): string {
  const url = new URL('/impersonate', clientOrigin);
  url.searchParams.set('token', token);
  return url.toString();
}

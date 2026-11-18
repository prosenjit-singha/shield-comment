import type { MetaConnectionStatus } from '../db/schema/meta.js';
import type { MetaTokenDebugInfo } from '../meta/meta-graph.client.js';
import { META_LOGIN_SCOPES } from '../meta/meta-graph.config.js';
import type { MetaGraphErrorKind } from '../meta/meta-graph.errors.js';

/**
 * Pure rules of the daily `debug_token` check (M4-T7, Module 4 D8 answered 2026-11-18):
 * valid + every D4 scope → ACTIVE (a fixed token goes back to ACTIVE); `is_valid=false` or a
 * missing D4 scope → NEEDS_REAUTH; Graph `token_invalid` → NEEDS_REAUTH. Anything else leaves the
 * row alone (it is checked again the next day). REVOKED only ever comes from Deauthorize, and
 * REVOKED rows are never checked.
 */

/** What one `debug_token` call gave: a result, or a `MetaGraphError` kind. */
export type DebugTokenOutcome =
  | { kind: 'result'; info: MetaTokenDebugInfo }
  | { kind: 'error'; error: MetaGraphErrorKind };

export type TokenCheckVerdict =
  | {
      action: 'set';
      status: Extract<MetaConnectionStatus, 'ACTIVE' | 'NEEDS_REAUTH'>;
      reason: 'valid' | 'invalid' | 'missing_scope' | 'graph_token_invalid';
      /** Missing D4 scopes (names only; for the log line). */
      missingScopes: string[];
      /**
       * Expiry Meta reported for a **valid** token (`null` = none); `undefined` = keep the stored
       * value (invalid token / Graph error: Meta's number says nothing useful then).
       */
      tokenExpiresAt?: Date | null;
    }
  | {
      action: 'leave';
      reason: 'rate_limited' | 'graph_error';
      /** Stop calling Meta for the rest of this run (rate limited). */
      stop: boolean;
    };

/** The D4 scopes missing from `scopes`, in `META_LOGIN_SCOPES` order. */
export function missingLoginScopes(scopes: readonly string[]): string[] {
  const granted = new Set(scopes);
  return META_LOGIN_SCOPES.filter((scope) => !granted.has(scope));
}

export function decideTokenStatus(
  outcome: DebugTokenOutcome,
): TokenCheckVerdict {
  if (outcome.kind === 'error') {
    switch (outcome.error) {
      case 'token_invalid':
        return {
          action: 'set',
          status: 'NEEDS_REAUTH',
          reason: 'graph_token_invalid',
          missingScopes: [],
        };
      case 'rate_limited':
        return { action: 'leave', reason: 'rate_limited', stop: true };
      default:
        return { action: 'leave', reason: 'graph_error', stop: false };
    }
  }
  const { info } = outcome;
  if (!info.isValid) {
    return {
      action: 'set',
      status: 'NEEDS_REAUTH',
      reason: 'invalid',
      missingScopes: [],
    };
  }
  const missing = missingLoginScopes(info.scopes);
  return {
    action: 'set',
    status: missing.length > 0 ? 'NEEDS_REAUTH' : 'ACTIVE',
    reason: missing.length > 0 ? 'missing_scope' : 'valid',
    missingScopes: missing,
    tokenExpiresAt: info.expiresAt,
  };
}

/** Same instant (or both `null`). */
export function sameInstant(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}
